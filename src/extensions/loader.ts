import type { IMiscLink } from '@bull-board/api/typings/app';
import express, { type Router } from 'express';
import { isAbsolute, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

import type { BullBoardExtension, ExtensionContext, ExtensionDisposer, ExtensionQueues, JsonValue } from './api.ts';

const extensionIdPattern = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;
const windowsAbsolutePathPattern = /^[a-zA-Z]:[\\/]|^\\\\/;
const schemePattern = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export interface ExtensionSpec {
  specifier: string;
  options: JsonValue | undefined;
}

export interface ExtensionLoaderDependencies {
  redis: ExtensionContext['redis'];
  queues: ExtensionQueues;
  proxyPath: string;
  cwd?: string;
  createRouter?: () => Router;
  mountRouter: (mountPath: string, router: Router) => void;
  addMiscLink: (link: IMiscLink) => void;
  importModule?: (specifier: string) => Promise<unknown>;
}

export interface ExtensionLifecycle {
  dispose(): Promise<void>;
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
      if (entry.trim() === '') throw configEntryError(index);
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
  return new Error(`Invalid BULL_BOARD_EXTENSIONS entry at index ${index}${specifier === undefined ? '' : ` (${specifier})`}`);
}

export async function resolveExtensionSpecifier(specifier: string, cwd = process.cwd()): Promise<string> {
  if (!windowsAbsolutePathPattern.test(specifier) && schemePattern.test(specifier)) {
    const scheme = specifier.slice(0, specifier.indexOf(':')).toLowerCase();
    if (scheme === 'npm' || scheme === 'jsr' || scheme === 'https') return specifier;
    if (scheme !== 'file') throw new Error(`Unsupported extension specifier "${specifier}"`);
  }

  let localPath: string;
  try {
    localPath = specifier.startsWith('file:')
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
  const specs = parseExtensionConfig(configuration);
  const createRouter = dependencies.createRouter ?? (() => express.Router());
  const importModule = dependencies.importModule ?? ((specifier: string) => import(specifier));
  const activated: ExtensionDisposer[] = [];
  const ids = new Set<string>();
  let disposePromise: Promise<void> | undefined;

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposePromise = (async () => {
      const errors: unknown[] = [];
      for (const disposer of activated.reverse()) {
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
    for (const [index, spec] of specs.entries()) {
      const specifier = await resolveExtensionSpecifier(spec.specifier, dependencies.cwd);
      let module: unknown;
      try {
        module = await importModule(specifier);
      } catch (error) {
        throw extensionOperationError('import', index, spec.specifier, error);
      }
      const extension = validateExtension(module, index, spec.specifier);
      if (ids.has(extension.id)) throw new Error(`Duplicate extension id "${extension.id}" at index ${index} (${spec.specifier})`);
      ids.add(extension.id);

      let activating = true;
      const router = createRouter();
      const context = createContext(dependencies, extension.id, router, () => activating);
      let result: void | ExtensionDisposer;
      try {
        result = await extension.activate(context, spec.options);
      } catch (error) {
        activating = false;
        throw extensionOperationError('activate', index, spec.specifier, error);
      }
      activating = false;
      if (result !== undefined && typeof result !== 'function') {
        throw new Error(`Extension at index ${index} (${spec.specifier}) with id "${extension.id}" returned an invalid activate result`);
      }
      if (typeof result === 'function') activated.push(result);
      dependencies.mountRouter(`/ext/${extension.id}`, router);
    }
  } catch (error) {
    try {
      await dispose();
    } catch (disposeError) {
      throw new AggregateError([error, disposeError], `Failed to activate extensions: ${errorMessage(error)}`);
    }
    throw error;
  }

  return { dispose };
}

function validateExtension(module: unknown, index: number, specifier: string): BullBoardExtension {
  const extension = module !== null && typeof module === 'object' && 'default' in module ? module.default : undefined;
  const label = `Extension at index ${index} (${specifier})`;
  if (extension === null || typeof extension !== 'object') throw new Error(`${label} must have a default export`);
  if (!('id' in extension) || typeof extension.id !== 'string' || !extensionIdPattern.test(extension.id)) {
    throw new Error(`${label} has an invalid id`);
  }
  if (!('apiVersion' in extension) || extension.apiVersion !== 1) throw new Error(`${label} must use apiVersion 1`);
  if (!('activate' in extension) || typeof extension.activate !== 'function') throw new Error(`${label} must export an activate function`);
  return extension as BullBoardExtension;
}

function createContext(
  dependencies: ExtensionLoaderDependencies,
  id: string,
  router: Router,
  isActivating: () => boolean,
): ExtensionContext {
  return {
    redis: dependencies.redis,
    queues: dependencies.queues,
    router,
    proxyPath: dependencies.proxyPath,
    url: (path) => extensionUrl(dependencies.proxyPath, id, path),
    addLink: ({ text, path }) => {
      if (!isActivating()) throw new Error(`Extension "${id}" can only add links while activating`);
      dependencies.addMiscLink({ text, url: extensionUrl(dependencies.proxyPath, id, path) });
    },
  };
}

function extensionUrl(proxyPath: string, id: string, extensionPath: string): string {
  const base = posix.join('/', proxyPath, 'ext', id);
  const suffixStart = extensionPath.search(/[?#]/);
  const pathname = suffixStart === -1 ? extensionPath : extensionPath.slice(0, suffixStart);
  const suffix = suffixStart === -1 ? '' : extensionPath.slice(suffixStart);
  const normalized = posix.normalize(`/${pathname}`).replace(/^\/+/, '');
  return `${base}/${normalized}${suffix}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function extensionOperationError(operation: 'import' | 'activate', index: number, specifier: string, cause: unknown): Error {
  return new Error(`Extension at index ${index} (${specifier}) failed to ${operation}: ${errorMessage(cause)}`, { cause });
}
