import type { NextFunction, Request, Response, Router } from 'express';

import type { ExtensionPageMountOptions, ExtensionPages } from './api.ts';

const mediaTypes = Object.freeze({
  '.css': 'text/css',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.txt': 'text/plain',
});

export interface ExtensionPagesDependencies {
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
  const loadText = dependencies.loadText ?? defaultLoadText;
  const assets = new Map<string, Promise<string>>();
  let mounted: MountedPages | undefined;
  let fallbackInstalled = false;

  const loadAsset = (url: URL): Promise<string> => {
    const existing = assets.get(url.href);
    if (existing !== undefined) return existing;

    const loading = Promise.resolve().then(() => loadText(url));
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
    (validated.protocol !== 'http:' && validated.protocol !== 'https:') ||
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
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('?') || path.includes('#')) {
    throw new Error(`Invalid preload path "${path}"`);
  }
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
  const requestAsset = request.path.endsWith('/') ? `${request.path.slice(1)}index.html` : request.path.slice(1);
  const url = new URL(requestAsset, mounted.root);
  const mediaType = mediaTypeFor(url.pathname);
  if (!isWithinRoot(url, mounted.root) || mediaType === undefined) return next();

  void loadAsset(url).then(
    (text) => response.type(mediaType).send(text),
    () => next(),
  );
}

function isWithinRoot(url: URL, root: URL): boolean {
  return url.protocol === root.protocol && url.host === root.host && url.pathname.startsWith(root.pathname);
}

function mediaTypeFor(pathname: string): string | undefined {
  const extension = pathname.slice(pathname.lastIndexOf('.')).toLowerCase();
  return mediaTypes[extension as keyof typeof mediaTypes];
}

async function defaultLoadText(url: URL): Promise<string> {
  const module = await import(url.href, { with: { type: 'text' } });
  return (module as { default: string }).default;
}
