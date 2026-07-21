import type { NextFunction, Request, Response, Router } from 'express';

import type { ExtensionPageMountOptions, ExtensionPages } from './api.ts';
import { bundleBrowserTypeScript } from './browser-typescript.ts';

const mediaTypes = Object.freeze({
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.ts': 'text/javascript',
});

export interface ExtensionPagesDependencies {
  bundleTypeScript?(url: URL): Promise<string>;
  loadText?(url: URL): Promise<string>;
}

export interface ExtensionPagesController {
  readonly pages: ExtensionPages;
  completeActivation(): Promise<void>;
}

interface MountedPages {
  readonly root: URL;
  readonly preload: readonly URL[];
}

export function createExtensionPages(
  id: string,
  router: Router,
  isActivating: () => boolean,
  dependencies: ExtensionPagesDependencies = {},
): ExtensionPagesController {
  const bundleTypeScript = dependencies.bundleTypeScript ?? bundleBrowserTypeScript;
  const loadText = dependencies.loadText ?? defaultLoadText;
  const assets = new Map<string, Promise<string>>();
  let mounted: MountedPages | undefined;
  let fallbackInstalled = false;

  const loadAsset = (url: URL): Promise<string> => {
    const existing = assets.get(url.href);
    if (existing !== undefined) return existing;

    const loading = Promise.resolve().then(() => isTypeScript(url) ? bundleTypeScript(url) : loadText(url));
    assets.set(url.href, loading);
    void loading.catch(() => {
      if (assets.get(url.href) === loading) assets.delete(url.href);
    });
    return loading;
  };

  const pages: ExtensionPages = {
    mount: (options) => {
      if (!isActivating()) throw new Error(`Extension "${id}" can only mount pages while activating`);
      if (mounted !== undefined) throw new Error(`Extension "${id}" can only mount one page root`);

      const root = validateRoot(options.root);
      const preload = Object.freeze((options.preload ?? []).map((path) => resolvePreload(root, path)));
      mounted = Object.freeze({ root, preload });
    },
  };

  return Object.freeze({
    pages,
    completeActivation: async () => {
      if (mounted === undefined) return;
      await Promise.all([...new Map(mounted.preload.map((url) => [url.href, url])).values()].map(loadAsset));
      if (!fallbackInstalled) {
        router.use((request, response, next) => serveAsset(request, response, next, mounted!, loadAsset));
        fallbackInstalled = true;
      }
    },
  });
}

function validateRoot(root: URL): URL {
  const validated = new URL(root.href);
  if (
    (validated.protocol !== 'file:' && validated.protocol !== 'http:' && validated.protocol !== 'https:') ||
    validated.username !== '' ||
    validated.password !== '' ||
    validated.search !== '' ||
    validated.hash !== '' ||
    !validated.pathname.endsWith('/')
  ) {
    throw new Error(`Invalid page root "${root.href}"`);
  }
  return validated;
}

function resolvePreload(root: URL, path: string): URL {
  if (!isCanonicalRelativePath(path)) throw new Error(`Invalid preload path "${path}"`);
  const url = new URL(path, root);
  if (!isWithinRoot(url, root)) throw new Error(`Invalid preload path "${path}"`);
  return url;
}

function serveAsset(
  request: Request,
  response: Response,
  next: NextFunction,
  mounted: MountedPages,
  loadAsset: (url: URL) => Promise<string>,
): void {
  if (request.method !== 'GET' && request.method !== 'HEAD') return next();
  const requestAsset = requestAssetPath(request);
  if (requestAsset === undefined) return next();
  const url = new URL(requestAsset, mounted.root);
  const mediaType = mediaTypeFor(url.pathname);
  if (!isWithinRoot(url, mounted.root) || mediaType === undefined) return next();

  void loadAsset(url).then(
    (text) => response.type(mediaType).send(text),
    (error) => isTypeScript(url) ? next(error) : next(),
  );
}

function requestAssetPath(request: Request): string | undefined {
  const raw = request.url;
  if (raw === '') return 'index.html';
  if (!raw.startsWith('/') || raw.startsWith('//')) return undefined;
  const relativePath = raw.slice(1);
  if (relativePath === '') return 'index.html';
  if (!isCanonicalRelativePath(relativePath)) return undefined;
  return relativePath.endsWith('/') ? `${relativePath}index.html` : relativePath;
}

function isCanonicalRelativePath(path: string): boolean {
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.includes('?') || path.includes('#')) return false;

  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  if (decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0') || decoded.includes('?') || decoded.includes('#')) {
    return false;
  }
  return decoded.split('/').every((segment) => segment !== '.' && segment !== '..');
}

function isWithinRoot(url: URL, root: URL): boolean {
  return url.protocol === root.protocol && url.host === root.host && url.pathname.startsWith(root.pathname);
}

function mediaTypeFor(pathname: string): string | undefined {
  const extension = pathname.slice(pathname.lastIndexOf('.')).toLowerCase();
  return mediaTypes[extension as keyof typeof mediaTypes];
}

function isTypeScript(url: URL): boolean {
  return url.pathname.toLowerCase().endsWith('.ts');
}

async function defaultLoadText(url: URL): Promise<string> {
  const module = await import(url.href, { with: { type: 'text' } });
  return (module as { default: string }).default;
}
