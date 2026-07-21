# URL-Backed Extension Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let runtime extensions mount an ordinary HTML/CSS/JavaScript directory from a `file:`, npm, JSR, or HTTPS module URL and exchange live data through their existing protected Express Router.

**Architecture:** A new extension-scoped page controller validates one URL root, preloads a declared text-asset manifest through Deno text imports, and appends a static-like fallback after extension activation. The loader gives each extension an isolated controller; explicit Router APIs therefore win before page assets. The example mounts `public/`, serves `/` as `index.html`, and fetches queue data from `./api/queues`.

**Tech Stack:** Deno 2.4+, TypeScript, Express 5, Deno text import attributes, native DOM APIs, Docker Compose.

## Global Constraints

- Do not expose the top-level Express app; extensions retain only their isolated Router and context capabilities.
- Keep extension API version `1`; the `pages` context field is additive.
- `pages.mount()` is activate-only, single-use, and accepts only trailing-slash `file:`, `http:`, or `https:` roots without query or fragment.
- Only `.html`, `.css`, `.js`, `.mjs`, `.json`, `.map`, `.svg`, and `.txt` text assets are served.
- Explicit extension routes precede the page fallback; `/` and directory paths map to `index.html`.
- Asset paths must remain below the declared root and reject absolute paths, backslashes, NUL bytes, query/fragment input, and normalized traversal.
- `preload` completes before HTTP listening; a preload error fails startup and participates in reverse extension cleanup.
- Keep `deno run -A`; do not add a template engine, binary-asset loader, Worker, sidecar, permission manifest, or top-level app access.
- Container documentation continues to recommend absolute extension paths; relative extension paths remain an undocumented compatibility feature.
- The base image must not copy `extensions/example`; test Compose bind-mounts it read-only at `/extensions/example`.

## File Structure

- Create `src/extensions/pages.ts`: URL validation, text loading/cache, preload lifecycle, and static fallback.
- Create `src/extensions/pages.test.ts`: controller behavior and URL-loading unit tests.
- Modify `src/extensions/api.ts` and `src/extensions/api.test.ts`: public `pages` types.
- Modify `src/extensions/loader.ts` and `src/extensions/loader.test.ts`: one controller per extension and activation cleanup.
- Move `example/` to `extensions/example/` and add `public/index.html`, `public/app.js`, and `public/styles.css`.
- Modify `package.json`, `.github/workflows/main.yml`, `docker-compose.test.yml`, `test/docker.ts`, `test/acceptance.ts`, `test/acceptance.test.ts`, and `README.md`.

---

### Task 1: URL-Backed Page Controller

**Files:**
- Create: `src/extensions/pages.ts`
- Create: `src/extensions/pages.test.ts`
- Modify: `src/extensions/api.ts`
- Modify: `src/extensions/api.test.ts`

**Interfaces:**
- Produces: `ExtensionPageMountOptions`, `ExtensionPages`, `createExtensionPages(id, router, isActivating, dependencies?)`.
- Produces: controller `{ pages, completeActivation() }`; `completeActivation()` preloads assets and appends the fallback.
- Produces: injectable `loadText(url)` dependency for deterministic tests; production uses `import(url.href, { with: { type: 'text' } })`.

- [ ] **Step 1: Add failing public API and controller tests**

Add these public types:

```ts
export interface ExtensionPageMountOptions {
  root: URL;
  preload?: readonly string[];
}

export interface ExtensionPages {
  mount(options: ExtensionPageMountOptions): void;
}
```

In `pages.test.ts`, cover these observable cases with an Express Router and an injected loader:

```ts
controller.pages.mount({
  root: new URL('https://extensions.example/public/'),
  preload: ['index.html', 'app.js', 'styles.css'],
});
await controller.completeActivation();

assert.equal(await text(request(app, '/')), '<!doctype html><h1>Example</h1>');
assert.equal((await request(app, '/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
assert.equal((await request(app, '/nested/')).status, 200);
assert.equal((await request(app, '/image.png')).status, 404);
```

Also assert activate-only/single mount behavior, invalid root protocols and URL components, invalid preload paths, normalized traversal rejection, GET/HEAD handling, explicit-route precedence, preload failure, concurrent load deduplication, retry after a failed load, and isolation between two controllers.

Add one default-loader test that starts `Deno.serve()` on `127.0.0.1`, serves an HTML text response, mounts that HTTP directory without injecting `loadText`, requests the page twice, and asserts the source server receives exactly one asset request. This is the ordinary-CI proof that Deno text imports work for URL assets without external network access.

- [ ] **Step 2: Run the focused tests and observe RED**

Run:

```powershell
deno test -A --frozen --node-modules-dir=none src/extensions/api.test.ts src/extensions/pages.test.ts
```

Expected: failure because `ExtensionContext.pages` and `src/extensions/pages.ts` do not exist.

- [ ] **Step 3: Implement the page controller minimally**

Use these internal contracts:

```ts
export interface ExtensionPagesDependencies {
  loadText?(url: URL): Promise<string>;
}

export interface ExtensionPagesController {
  readonly pages: ExtensionPages;
  completeActivation(): Promise<void>;
}

export function createExtensionPages(
  id: string,
  router: Router,
  isActivating: () => boolean,
  dependencies: ExtensionPagesDependencies = {},
): ExtensionPagesController;
```

Implement a frozen media-type table and resolve request paths as follows:

```ts
const requestAsset = request.path.endsWith('/')
  ? `${request.path.slice(1)}index.html`
  : request.path.slice(1);
```

Resolve with `new URL(relativePath, root)` and require equal protocol/host plus a pathname beginning with the trailing-slash root pathname. Maintain `Map<string, Promise<string>>`; delete only the matching promise after rejection. On `completeActivation()`, preload every unique manifest entry, then append one GET/HEAD middleware. Unsupported paths and lazy load failures call `next()`; successful responses set the exact media type and call `send(text)`.

- [ ] **Step 4: Run focused tests and observe GREEN**

Run the Step 2 command.

Expected: all page and API tests pass.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/extensions/api.ts src/extensions/api.test.ts src/extensions/pages.ts src/extensions/pages.test.ts
git commit -m "feat: add URL-backed extension pages"
```

---

### Task 2: Extension Loader Lifecycle Integration

**Files:**
- Modify: `src/extensions/loader.ts`
- Modify: `src/extensions/loader.test.ts`

**Interfaces:**
- Consumes: `createExtensionPages()` and `ExtensionContext.pages` from Task 1.
- Preserves: extension routers mount at `/ext/{id}` and extension cleanup remains idempotent and reverse ordered.

- [ ] **Step 1: Add failing lifecycle tests**

Extend loader tests with modules that call:

```ts
context.pages.mount({
  root: new URL('https://extensions.example/demo/'),
  preload: ['index.html'],
});
```

Add this exact optional dependency to `ExtensionPreparationDependencies`, capture it in `prepareExtensions()`, and default it to the production factory:

```ts
createPages?: typeof createExtensionPages;
```

Inject `createPages` in loader tests so they can record `activate`, `preload`, `next extension`, and `dispose` events without external network. Assert:

```ts
assert.deepEqual(events, [
  'activate:first',
  'preload:first/index.html',
  'activate:second',
  'preload:second/index.html',
]);
```

Add failures for a late `pages.mount()`, a duplicate mount, and a preload rejection after `activate()` returns a disposer. The rejection must include the array index, extension specifier, id, and asset URL, and the returned disposer must run before the error escapes.

- [ ] **Step 2: Run loader tests and observe RED**

```powershell
deno test -A --frozen --node-modules-dir=none src/extensions/loader.test.ts
```

Expected: failures because the loader does not create, expose, or complete a page controller.

- [ ] **Step 3: Integrate controllers into serial activation**

For each prepared extension:

```ts
const router = createRouter();
let activating = true;
const pageController = createExtensionPages(extension.id, router, () => activating, pageDependencies);
const context = createContext(dependencies, extension.id, router, pageController.pages, () => activating, addLink);
```

After `activate()` returns, set `activating = false`, validate and record its disposer, then await `pageController.completeActivation()` before starting the next extension. Wrap activation and preload failures once with existing index/specifier diagnostics. If preload fails after a disposer was returned, the outer reverse cleanup must call it.

- [ ] **Step 4: Run loader and application tests and observe GREEN**

```powershell
deno test -A --frozen --node-modules-dir=none src/extensions/loader.test.ts src/app.test.ts
```

Expected: all loader ordering, rollback, authentication, and application assembly tests pass.

- [ ] **Step 5: Commit Task 2**

```powershell
git add src/extensions/loader.ts src/extensions/loader.test.ts src/app.test.ts
git commit -m "feat: activate extension page mounts"
```

---

### Task 3: Static Example Page and AJAX API

**Files:**
- Move: `example/mod.ts` to `extensions/example/mod.ts`
- Move: `example/mod.test.ts` to `extensions/example/mod.test.ts`
- Create: `extensions/example/public/index.html`
- Create: `extensions/example/public/app.js`
- Create: `extensions/example/public/styles.css`
- Modify: `package.json`

**Interfaces:**
- Consumes: `context.pages.mount()` from Task 1 and loader completion from Task 2.
- Produces: `GET /ext/example/api/queues` with `{ queueCount: number, queues: string[] }`.

- [ ] **Step 1: Move the example and write failing tests**

The test context records this exact mount:

```ts
assert.deepEqual(pageMount, {
  root: new URL('./public/', import.meta.url),
  preload: ['index.html', 'app.js', 'styles.css'],
});
```

Request `/api/queues`, mutate the backing queue list, request again, and deep-compare both JSON snapshots. Include a queue named `'<beta & gamma>'` to prove the API returns data rather than server-generated HTML. Assert the navigation remains `{ text: 'Example', path: '/' }`.

- [ ] **Step 2: Run example tests and observe RED**

```powershell
deno test -A --frozen --node-modules-dir=none extensions/example/
```

Expected: failure until the moved module mounts pages and exposes the JSON route.

- [ ] **Step 3: Implement the extension module and static files**

Use this module behavior:

```ts
activate(context) {
  context.pages.mount({
    root: new URL('./public/', import.meta.url),
    preload: ['index.html', 'app.js', 'styles.css'],
  });
  context.addLink({ text: 'Example', path: '/' });
  context.router.get('/api/queues', (_request, response) => {
    const queues = context.queues.list();
    response.json({ queueCount: queues.length, queues: queues.map((queue) => queue.name) });
  });
}
```

`index.html` must contain an accessible queue status region, queue list, and Refresh button, and reference only `./styles.css` and `./app.js`. `app.js` must call `fetch('./api/queues')`, create queue elements with `document.createElement()` and `textContent`, disable the button while loading, and expose loading, empty, and error states without `innerHTML`. `styles.css` must define a responsive warm-paper/industrial visual using CSS variables, a subtle grid background, high-contrast focus styles, and a single staggered page-load reveal; do not load external fonts or assets.

Update `test:unit` to include `extensions/` instead of `example/`.

- [ ] **Step 4: Run example and core unit tests and observe GREEN**

```powershell
deno task test:unit
```

Expected: all unit tests pass.

- [ ] **Step 5: Commit Task 3**

```powershell
git add example extensions package.json
git commit -m "feat: add static AJAX extension example"
```

---

### Task 4: Container Acceptance, CI, and Documentation

**Files:**
- Modify: `docker-compose.test.yml`
- Modify: `test/docker.ts`
- Modify: `test/acceptance.ts`
- Modify: `test/acceptance.test.ts`
- Modify: `.github/workflows/main.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: example HTML/assets/API from Task 3.
- Preserves: exact authentication redirects, Bull Board navigation, no-extension baseline, and invalid-extension startup failure.

- [ ] **Step 1: Update acceptance fixtures first and observe RED**

Change the acceptance contract to fetch and validate:

```ts
GET /ext/example/             -> text/html with ./styles.css and ./app.js
GET /ext/example/app.js       -> text/javascript containing fetch('./api/queues')
GET /ext/example/styles.css   -> text/css
GET /ext/example/api/queues   -> { queueCount: 1, queues: ['example'] }
```

Before login, both `/ext/example/` and `/ext/example/api/queues` must redirect exactly to `/app/bull-board/login`. Retain wrong-password, exact navigation, core page, baseline, and invalid-extension assertions. Replace the old queue-count HTML fixture test with exact JSON deep comparisons, including a negative count of `10`.

Run:

```powershell
deno test -A --frozen --node-modules-dir=none test/acceptance.test.ts
```

Expected: failure until fixtures and assertions use static assets and JSON.

- [ ] **Step 2: Update Compose, Docker checks, and CI paths**

- Bind `./extensions/example` to `/extensions/example` read-only.
- Assert `/usr/app/extensions` is absent from the built image while `/extensions/example/mod.ts` is valid through the bind mount.
- Replace CI `example/*.ts` and `example/` arguments with `extensions/example/*.ts` and `extensions/`.
- Keep ordinary CI independent of external registries and GitHub URLs.

- [ ] **Step 3: Document pages and URL distribution**

Update the README Compose source path to `./extensions/example`. Document the `pages.mount()` API, relative browser asset/API URLs, supported text extensions, preload manifest, lack of templates/binary assets/hot reload, and this HTTPS pattern:

```ts
context.pages.mount({
  root: new URL('./public/', import.meta.url),
  preload: ['index.html', 'app.js', 'styles.css'],
});
```

Retain the trusted-code and `deno run -A` warnings.

- [ ] **Step 4: Run the full validation chain**

```powershell
deno install --frozen
deno cache --frozen --node-modules-dir=none src/*.ts src/extensions/*.ts extensions/example/*.ts test/*.ts
deno check --reload --frozen --node-modules-dir=none src/*.ts src/extensions/*.ts extensions/example/*.ts test/*.ts
deno lint src/ extensions/ test/
deno fmt --check src/ extensions/ test/ docs/superpowers/
deno task test:unit
deno task test:docker
git diff --check
```

Expected: every command succeeds. If Docker Hub networking fails despite available network permission, retry only the failing Docker command with `HTTP_PROXY` and `HTTPS_PROXY` set to `http://127.0.0.1:1080`.

- [ ] **Step 5: Commit Task 4**

```powershell
git add .github/workflows/main.yml README.md docker-compose.test.yml test
git commit -m "test: verify static extension pages"
```

---

## Final Review and PR Update

- Generate one whole-branch review package from the branch merge base and run the requesting-code-review reviewer.
- Resolve every Critical or Important finding and rerun its covering tests.
- Re-run the full validation chain after review fixes.
- Push `feat/runtime-extensions` without force and confirm PR #6 checks correspond to the new head SHA.
