import type { IMiscLink } from '@bull-board/api/typings/app';
import express, { type Router } from 'express';
import { isAbsolute, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

import type { BullBoardExtension, ExtensionContext, ExtensionDisposer, ExtensionQueues, JsonValue } from './api.ts';
import { createExtensionPages } from './pages.ts';

const extensionIdPattern = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;
const windowsAbsolutePathPattern = /^[a-zA-Z]:[\\/]|^\\\\/;
const schemePattern = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export interface ExtensionSpec {
  specifier: string;
  options: JsonValue | undefined;
}

export interface ExtensionPreparationDependencies {
  cwd?: string;
  createRouter?: () => Router;
  createPages?: typeof createExtensionPages;
  importModule?: (specifier: string) => Promise<unknown>;
}

export interface ExtensionActivationDependencies {
  redis: ExtensionContext['redis'];
  queues: ExtensionQueues;
  proxyPath: string;
}

export interface ExtensionLoaderDependencies extends ExtensionPreparationDependencies, ExtensionActivationDependencies {
  mountRouter: (mountPath: string, router: Router) => void;
  addMiscLink: (link: IMiscLink) => void;
}

export interface ExtensionLifecycle {
  dispose(): Promise<void>;
}

export interface ActivatedExtensions extends ExtensionLifecycle {
  readonly miscLinks: readonly IMiscLink[];
  mountRouters(mountRouter: (mountPath: string, router: Router) => void): void;
}

export interface PreparedExtensions {
  activate(dependencies: ExtensionActivationDependencies): Promise<ActivatedExtensions>;
}

interface PreparedExtension {
  readonly index: number;
  readonly specifier: string;
  readonly options: JsonValue | undefined;
  readonly id: string;
  readonly activate: BullBoardExtension['activate'];
}

interface ValidatedExtension {
  readonly id: string;
  readonly apiVersion: 1;
  readonly activate: BullBoardExtension['activate'];
  readonly receiver: object;
}

export function parseExtensionConfig(value: string | undefined): ExtensionSpec[] {
  if (value === undefined || value.trim() === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('BULL_BOARD_EXTENSIONS must be a JSON array');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('BULL_BOARD_EXTENSIONS must be a JSON array');
  }

  return parsed.map((entry, index) => {
    if (typeof entry === 'string') {
      if (entry.trim() === '') throw configEntryError(index, entry);
      return { specifier: entry, options: undefined };
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw configEntryError(index);
    }

    const specifier = 'specifier' in entry ? entry.specifier : undefined;
    if (typeof specifier !== 'string' || specifier.trim() === '') {
      throw configEntryError(index, typeof specifier === 'string' ? specifier : undefined);
    }
    const options = 'options' in entry ? entry.options : undefined;
    return { specifier, options: options as JsonValue | undefined };
  });
}

function configEntryError(index: number, specifier?: string): Error {
  return new Error(
    `Invalid BULL_BOARD_EXTENSIONS entry at index ${index}${specifier === undefined ? '' : ` (${JSON.stringify(specifier)})`}`,
  );
}

export async function resolveExtensionSpecifier(specifier: string, cwd = process.cwd()): Promise<string> {
  const normalizedScheme = !windowsAbsolutePathPattern.test(specifier) && schemePattern.test(specifier)
    ? specifier.slice(0, specifier.indexOf(':')).toLowerCase()
    : undefined;
  if (normalizedScheme !== undefined) {
    if (normalizedScheme === 'npm' || normalizedScheme === 'jsr' || normalizedScheme === 'https') return specifier;
    if (normalizedScheme !== 'file') throw new Error(`Unsupported extension specifier "${specifier}"`);
  }

  let localPath: string;
  try {
    localPath = normalizedScheme === 'file'
      ? fileURLToPath(specifier)
      : (isAbsolute(specifier) || windowsAbsolutePathPattern.test(specifier) ? specifier : resolve(cwd, specifier));
  } catch (error) {
    throw localSpecifierError(specifier, error);
  }

  try {
    const stat = await Deno.stat(localPath);
    if (stat.isDirectory) localPath = resolve(localPath, 'mod.ts');
    const targetStat = await Deno.stat(localPath);
    if (!targetStat.isFile) throw new Error('target is not a file');
  } catch (error) {
    throw localSpecifierError(specifier, error);
  }
  return pathToFileURL(resolve(localPath)).href;
}

function localSpecifierError(specifier: string, error: unknown): Error {
  const detail = error instanceof Error ? `: ${error.message}` : '';
  return new Error(`Unable to resolve extension specifier "${specifier}"${detail}`);
}

export async function loadExtensions(
  dependencies: ExtensionLoaderDependencies,
  configuration = process.env.BULL_BOARD_EXTENSIONS,
): Promise<ExtensionLifecycle> {
  const prepared = await prepareExtensions(dependencies, configuration);
  const activated = await prepared.activate(dependencies);
  try {
    activated.mountRouters(dependencies.mountRouter);
    for (const link of activated.miscLinks) dependencies.addMiscLink(link);
  } catch (error) {
    try {
      await activated.dispose();
    } catch (disposeError) {
      throw new AggregateError([error, disposeError], `Failed to mount extensions: ${errorMessage(error)}`);
    }
    throw error;
  }
  return activated;
}

export async function prepareExtensions(
  dependencies: ExtensionPreparationDependencies = {},
  configuration = process.env.BULL_BOARD_EXTENSIONS,
): Promise<PreparedExtensions> {
  const specs = parseExtensionConfig(configuration);
  const createRouter = dependencies.createRouter ?? (() => express.Router());
  const createPages = dependencies.createPages ?? createExtensionPages;
  const importModule = dependencies.importModule ?? ((specifier: string) => import(specifier));
  const ids = new Set<string>();
  const extensions: PreparedExtension[] = [];

  for (const [index, spec] of specs.entries()) {
    let resolvedSpecifier: string;
    try {
      resolvedSpecifier = await resolveExtensionSpecifier(spec.specifier, dependencies.cwd);
    } catch (error) {
      throw extensionOperationError('resolve', index, spec.specifier, error);
    }
    let module: unknown;
    try {
      module = await importModule(resolvedSpecifier);
    } catch (error) {
      throw extensionOperationError('import', index, spec.specifier, error);
    }
    const { id, activate, receiver } = validateExtension(module, index, spec.specifier);
    if (ids.has(id)) throw new Error(`Duplicate extension id "${id}" at index ${index} (${spec.specifier})`);
    ids.add(id);
    extensions.push({
      index,
      specifier: spec.specifier,
      options: spec.options,
      id,
      activate: activate.bind(receiver),
    });
  }

  return {
    activate: (activationDependencies) => activatePreparedExtensions(extensions, activationDependencies, createRouter, createPages),
  };
}

async function activatePreparedExtensions(
  extensions: readonly PreparedExtension[],
  dependencies: ExtensionActivationDependencies,
  createRouter: () => Router,
  createPages: typeof createExtensionPages,
): Promise<ActivatedExtensions> {
  const disposers: ExtensionDisposer[] = [];
  const routers: { readonly id: string; readonly router: Router }[] = [];
  const miscLinks: IMiscLink[] = [];
  let disposePromise: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposePromise = (async () => {
      const errors: unknown[] = [];
      for (const disposer of [...disposers].reverse()) {
        try {
          await disposer();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Failed to dispose extensions');
    })();
    return disposePromise;
  };

  try {
    for (const extension of extensions) {
      const router = createRouter();
      let activating = true;
      const pageController = createPages(extension.id, router, () => activating);
      const context = createContext(
        dependencies,
        extension.id,
        router,
        pageController.pages,
        () => activating,
        (link) => miscLinks.push(link),
      );
      let result: void | ExtensionDisposer;
      try {
        result = await extension.activate(context, extension.options);
      } catch (error) {
        throw extensionOperationError('activate', extension.index, extension.specifier, error);
      } finally {
        activating = false;
      }
      if (result !== undefined && typeof result !== 'function') {
        throw new Error(
          `Extension at index ${extension.index} (${extension.specifier}) with id "${extension.id}" returned an invalid activate result`,
        );
      }
      if (typeof result === 'function') disposers.push(result);
      try {
        await pageController.completeActivation();
      } catch (error) {
        throw pageOperationError(extension, error);
      }
      routers.push({ id: extension.id, router });
    }
  } catch (error) {
    try {
      await dispose();
    } catch (disposeError) {
      throw new AggregateError([error, disposeError], `Failed to activate extensions: ${errorMessage(error)}`);
    }
    throw error;
  }

  const frozenMiscLinks = Object.freeze([...miscLinks]);
  return {
    miscLinks: frozenMiscLinks,
    mountRouters: (mountRouter) => {
      for (const { id, router } of routers) mountRouter(`/ext/${id}`, router);
    },
    dispose,
  };
}

function validateExtension(module: unknown, index: number, specifier: string): ValidatedExtension {
  const extension = module !== null && typeof module === 'object' && 'default' in module ? module.default : undefined;
  const label = `Extension at index ${index} (${specifier})`;
  if (extension === null || typeof extension !== 'object') throw new Error(`${label} must have a default export`);
  const id = 'id' in extension ? extension.id : undefined;
  const apiVersion = 'apiVersion' in extension ? extension.apiVersion : undefined;
  const activate = 'activate' in extension ? extension.activate : undefined;
  if (typeof id !== 'string' || !extensionIdPattern.test(id)) throw new Error(`${label} has an invalid id`);
  if (apiVersion !== 1) throw new Error(`${label} must use apiVersion 1`);
  if (typeof activate !== 'function') throw new Error(`${label} must export an activate function`);
  return Object.freeze({ id, apiVersion, activate: activate as BullBoardExtension['activate'], receiver: extension });
}

function createContext(
  dependencies: ExtensionActivationDependencies,
  id: string,
  router: Router,
  pages: ExtensionContext['pages'],
  isActivating: () => boolean,
  addMiscLink: (link: IMiscLink) => void,
): ExtensionContext {
  return {
    redis: dependencies.redis,
    queues: dependencies.queues,
    router,
    pages,
    proxyPath: dependencies.proxyPath,
    url: (path) => extensionUrl(dependencies.proxyPath, id, path),
    addLink: ({ text, path }) => {
      if (!isActivating()) throw new Error(`Extension "${id}" can only add links while activating`);
      addMiscLink({ text, url: extensionUrl(dependencies.proxyPath, id, path) });
    },
  };
}

function extensionUrl(proxyPath: string, id: string, extensionPath: string): string {
  const mountRoot = `${posix.join('/', proxyPath, 'ext', id)}/`;
  const origin = 'https://bull-board-extension.invalid';
  const base = new URL(mountRoot, origin);
  const url = new URL(extensionPath.startsWith('/') ? extensionPath.slice(1) : extensionPath, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(mountRoot)) {
    throw new Error(`Extension URL "${extensionPath}" escapes extension mount "${mountRoot}"`);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extensionOperationError(operation: 'resolve' | 'import' | 'activate', index: number, specifier: string, cause: unknown): Error {
  return new Error(`Extension at index ${index} (${specifier}) failed to ${operation}: ${errorMessage(cause)}`, { cause });
}

function pageOperationError(extension: PreparedExtension, cause: unknown): Error {
  return new Error(
    `Extension at index ${extension.index} (${extension.specifier}) with id "${extension.id}" failed to preload pages: ${
      errorMessage(cause)
    }`,
    { cause },
  );
}
