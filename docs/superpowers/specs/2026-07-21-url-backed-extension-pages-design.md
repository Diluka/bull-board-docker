# URL-Backed Extension Pages Design

## Goal

Allow a runtime extension to publish an ordinary HTML/CSS/JavaScript page from the same `file:`, `npm:`, `jsr:`, or `https:` source as its `mod.ts`, while retaining its isolated Express Router and the existing `/ext/{id}` authentication boundary.

The page layer does not interpolate data or execute templates. Browser code obtains live data from routes on the extension Router, such as `GET ./api/queues`.

## Scope

- Add an extension-scoped page root and raw `res.render('relative/path.html')` support.
- Add a static-like fallback for text web assets below that page root.
- Load remote text assets through Deno's module loader so URL extensions and Deno caching work consistently.
- Move the example to `extensions/example/` and give it a standalone HTML page, CSS, JavaScript, and a queue JSON API.
- Keep all extension pages and APIs behind the application's existing login protection.

The first version does not provide template interpolation, layouts, partials, helper functions, binary assets, directory listings, client bundling, hot reload, or a top-level Express app.

## Public API

The additive API remains at extension API version 1:

```ts
interface ExtensionPageMountOptions {
  root: URL;
  preload?: readonly string[];
}

interface ExtensionPages {
  mount(options: ExtensionPageMountOptions): void;
}

interface ExtensionContext {
  redis: Redis | Cluster;
  queues: ExtensionQueues;
  router: express.Router;
  pages: ExtensionPages;
  proxyPath: string;
  url(path: `/${string}`): string;
  addLink(link: { text: string; path: `/${string}` }): void;
}
```

`pages.mount()` may be called once and only while the extension is activating. The root must be a `file:`, `http:`, or `https:` directory URL with no query or fragment and with a trailing slash. Extensions derive it from their own module rather than from loader internals:

```ts
context.pages.mount({
  root: new URL('./public/', import.meta.url),
  preload: ['index.html', 'app.js', 'styles.css'],
});
```

This works for an absolute-path extension because `import.meta.url` is a `file:` URL. It also keeps a direct HTTPS extension and its assets on the same pinned commit. npm and JSR packages must include the declared assets in the published package.

## Router Integration

Each extension receives a page controller bound only to its own Router:

1. Before `activate()`, the loader inserts middleware that provides the extension-scoped `res.render()` implementation.
2. The extension registers API and page routes during `activate()`.
3. After `activate()`, the loader freezes page configuration, preloads declared assets, and appends the static fallback to the end of the extension Router.
4. The extension Router is mounted at internal `/ext/{id}` as it is today.

Appending the static fallback after activation guarantees that explicit routes such as `/api/queues` take precedence over files with the same request path.

An explicit page route is ordinary Express code:

```ts
context.router.get('/', (_request, response) => {
  response.render('index.html');
});
```

The extension-scoped renderer resolves only a relative `.html` path below the mounted page root, loads the file as text, sets `text/html; charset=utf-8`, and returns it unchanged. It preserves the Express callback form of `res.render()`, but render locals are unsupported because this layer performs no interpolation. A non-empty locals object is an error.

If an extension calls `res.render()` without mounting pages, supplies an absolute path, escapes the page root, uses a non-HTML extension, or names a missing page, the request is forwarded to Express error handling.

## Static-Like Assets

After explicit extension routes run, GET and HEAD requests may resolve to a text asset below the mounted page root. `/` and any path ending in `/` map to `index.html` below that path. The fallback supports these extensions and response media types:

| Extension | Media type |
| --- | --- |
| `.html` | `text/html; charset=utf-8` |
| `.css` | `text/css; charset=utf-8` |
| `.js`, `.mjs` | `text/javascript; charset=utf-8` |
| `.json`, `.map` | `application/json; charset=utf-8` |
| `.svg` | `image/svg+xml; charset=utf-8` |
| `.txt` | `text/plain; charset=utf-8` |

Unsupported extensions and missing lazy assets fall through to the next Express handler and produce the normal 404 response. The fallback does not enumerate directories.

The browser uses document-relative URLs:

```html
<link rel="stylesheet" href="./styles.css">
<script type="module" src="./app.js"></script>
```

```js
const response = await fetch('./api/queues');
```

Relative browser URLs retain `PROXY_PATH` automatically, so the page works at both `/ext/example/` and `/app/bull-board/ext/example/` without injecting server data into HTML.

## Loading, Caching, and Validation

Text assets are loaded with dynamic imports using `{ with: { type: 'text' } }`. This gives local and remote sources the same behavior and stores successfully loaded remote assets in Deno's module cache. The page controller also shares an in-process promise per resolved URL so concurrent requests perform one load; a failed promise is removed so a later request may retry.

Every relative asset path is resolved with `new URL(path, root)`. The controller rejects absolute paths, backslashes, NUL bytes, changes of protocol or origin, and any normalized pathname outside the root prefix.

`preload` is an explicit remote-safe manifest, because an HTTP directory cannot be enumerated. Preloaded paths use the same validation and media-type allowlist as lazy assets. They are loaded after `activate()` and before the HTTP server listens. A preload failure fails extension activation, includes the extension id and asset URL in the error, and participates in the existing reverse cleanup path.

Page configuration is immutable after activation. Extensions still require a process restart for code or page changes.

## Example Extension

The example moves to:

```text
extensions/example/
  mod.ts
  mod.test.ts
  public/
    index.html
    app.js
    styles.css
```

It mounts `public/`, preloads all three files, registers an explicit root route using `res.render('index.html')`, and exposes `GET /api/queues`. The API reads `context.queues.list()` for every request and returns only plain data:

```json
{
  "queueCount": 1,
  "queues": ["example"]
}
```

The browser script fetches the API on initial load and when the user selects Refresh. It builds queue rows with DOM APIs and `textContent`; it does not use `innerHTML` or serialize raw Queue objects. The page remains usable on desktop and mobile and includes explicit loading, empty, and error states.

The base image continues to exclude `extensions/example`. Test Compose bind-mounts `./extensions/example` read-only at `/extensions/example` and keeps `BULL_BOARD_EXTENSIONS='["/extensions/example"]'`.

## Failure Semantics

- Invalid page roots, repeated mounts, invalid preload paths, and calls after activation fail activation before listening.
- A missing or unreachable preloaded asset fails activation before listening.
- An explicit `res.render()` failure reaches Express error handling.
- A missing lazy static asset falls through as 404.
- One extension's page state, cache, or failure cannot select templates or assets from another extension.
- Disposer and Queue/Redis cleanup behavior remains unchanged.

## Verification

Unit coverage will verify:

- API typing and the activate-only, single-mount lifecycle.
- `file:` and HTTP page roots, raw HTML rendering, callback rendering, media types, GET/HEAD behavior, directory index handling, and explicit-route precedence.
- URL traversal rejection, unsupported asset types, missing assets, preload failure, concurrent load deduplication, retry after failure, and page-state isolation between extensions.
- A URL-loaded extension can derive its page root from `import.meta.url`, preload sibling HTML/JS/CSS, and render the HTML without filesystem access.
- The example registers its page root and navigation, returns a live queue JSON snapshot, and does not expose raw Queue objects.

Docker acceptance will verify:

- The no-extension service remains compatible.
- Anonymous page and API requests redirect exactly to `/app/bull-board/login`.
- A wrong password cannot access either route.
- A successful login can fetch the HTML, JavaScript, CSS, and exact queue JSON payload.
- The HTML uses relative assets, the JavaScript uses a relative API URL, and the navigation href is `/app/bull-board/ext/example/`.
- The core Bull Board page remains available.
- The base image does not contain the example, while the read-only absolute-path mount does.

CI will check, lint, format, and test `src/`, `extensions/`, and `test/`. Ordinary CI will not require an external extension registry or GitHub asset URL; URL-loading unit tests use a local HTTP fixture.

## Rejected Alternatives

- `express.static()` alone was rejected because it requires a local filesystem directory and cannot model direct HTTPS extensions.
- hbs was proven capable of compiling a URL-imported HTML string, but its standard Express adapter reads templates with `fs.readFile()`. Keeping it would add a dependency and a custom adapter without providing value when page data is intentionally fetched through AJAX.
- React and Vue SSR were rejected because their interactive workflows require client compilation or hydration and do not improve this raw-page use case.
- Exposing the top-level Express app remains out of scope because the extension Router, page root, and JSON routes provide the required capability without weakening route isolation.
