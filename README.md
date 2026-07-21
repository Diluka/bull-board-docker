Docker image for [bull-board]. Allow you to monitor your bull queue without any coding!

Supports both: bull and bullmq. bull-board version v3.2.6

### Quick start with Docker

```
docker run -p 3000:3000 diluka/bull-board
```

will run bull-board interface on `localhost:3000` and connect to your redis instance on `localhost:6379` without password.

To configurate redis see "Environment variables" section.

### Quick start with docker-compose

```yaml
version: '3.5'

services:
  bullboard:
    container_name: bullboard
    image: diluka/bull-board
    restart: always
    ports:
      - 3000:3000
```

will run bull-board interface on `localhost:3000` and connect to your redis instance on `localhost:6379` without password.

see "Example with docker-compose" section for example with env parameters

### Environment variables

- `REDIS_HOST` - host to connect to redis (localhost by default)
- `REDIS_PORT` - redis port (6379 by default)
- `REDIS_DB` - redis db to use ('0' by default)
- `REDIS_USE_TLS` - enable TLS true or false (false by default)
- `REDIS_PASSWORD` - password to connect to redis (no password by default)
- `BULL_PREFIX` - prefix to your bull queue name (bull by default)
- `BULL_VERSION` - version of bull lib to use 'BULLMQ' or 'BULL' ('BULLMQ' by default)
- `PROXY_PATH` - proxyPath for bull board, e.g. https://<server_name>/my-base-path/queues [docs] ('' by default)
- `USER_LOGIN` - login to restrict access to bull-board interface (disabled by default)
- `USER_PASSWORD` - password to restrict access to bull-board interface (disabled by default)
- `METRICS_ENABLED` - enable Prometheus metrics endpoint (disabled by default)
- `METRICS_VAR_*` - custom labels for Prometheus metrics (e.g., `METRICS_VAR_env=production`, `METRICS_VAR_server=1`)
- `BULL_BOARD_EXTENSIONS` - ordered JSON array of runtime extension specifiers (disabled by default)

### Runtime extensions

`BULL_BOARD_EXTENSIONS` loads extensions in array order during application startup. Use absolute container paths for local extensions; when an entry names a directory, Bull Board resolves its `mod.ts` file. For example:

```yaml
services:
  bullboard:
    environment:
      BULL_BOARD_EXTENSIONS: '["/extensions/example-ts"]'
    volumes:
      - type: bind
        source: ./extensions/example-ts
        target: /extensions/example-ts
        read_only: true
```

An entry may also be an object with a `specifier` and JSON `options` passed to that extension:

```json
[
  "/extensions/first",
  { "specifier": "/extensions/second/mod.ts", "options": { "enabled": true } }
]
```

Extensions are trusted in-process code. They receive the raw Redis client and raw Bull/BullMQ queue registry, so they have the same data access capabilities as the application. The image currently starts with `deno run -A`; install only extensions you trust.

Extensions can mount a URL-backed page tree while activating. A root relative to `import.meta.url` works for both local modules and extensions distributed over HTTPS. Keep browser references relative so they continue to work behind `PROXY_PATH` and the extension route:

```ts
context.pages.mount({
  root: new URL('./public/', import.meta.url),
  preload: ['index.html', 'app.ts', 'styles.css'],
});
```

`pages.mount()` accepts a trailing-slash `file:`, `http:`, or `https:` root. Its `preload` list is the startup manifest: every listed text asset is loaded before the server starts, so an unavailable asset fails startup instead of producing a partially loaded page. Keep HTML and API references relative so they remain valid behind `PROXY_PATH`:

```html
<link rel="stylesheet" href="./styles.css">
<script type="module" src="./app.ts"></script>
```

Browser TypeScript entries are bundled at runtime by the Deno CLI with an isolated browser ESM configuration (`--no-config --no-lock --platform browser --format esm --allow-import`). Relative TypeScript imports are included in the same JavaScript output. The browser still requests the original `.ts` URL, but receives the cached bundle as `text/javascript; charset=utf-8`; no generated `.js` path or frontend build step is needed. Add `/// <reference lib="dom" />` to a browser entry when it should also pass `deno check` without a separate browser TypeScript configuration.

Preloaded `.ts` compilation failures stop startup before HTTP listening. A `.ts` asset omitted from `preload` is compiled on its first request, cached in memory, and returns HTTP 500 if compilation fails. The base image pre-warms Deno's platform-specific esbuild package, while remote source modules can still require startup network access and writable Deno cache storage.

Page serving supports these text extensions: `.css`, `.html`, `.js`, `.json`, `.map`, `.mjs`, `.svg`, `.ts`, and `.txt`. It does not render templates or serve binary assets. Extensions and their pages are loaded once at startup; changing configuration, code, or assets requires an application restart. There is no hot reload or hot unload.

The repository includes `extensions/example-js` as the plain JavaScript compatibility example and `extensions/example-ts` as the recommended native TypeScript example. Both use an HTML page plus relative AJAX calls to extension API routes.

The loader accepts `npm:`, `jsr:`, and `https:` specifiers. A raw GitHub URL should include a fixed commit, for example `https://raw.githubusercontent.com/OWNER/REPOSITORY/COMMIT/mod.ts`. Pin package versions and commits in production. Cold startup of a remote extension can require network access and writable Deno cache storage, so production images should pre-cache remote extensions in a derived image during the image build.

### Restrict access with login and password

To restrict access to bull-board use `USER_LOGIN` and `USER_PASSWORD` env vars.
Only when both `USER_LOGIN` and `USER_PASSWORD` specified, access will be restricted with login/password

### Prometheus Metrics

Enable Prometheus metrics endpoint with `METRICS_ENABLED=true`. This requires BullMQ queues (not supported for Bull v3).

**Endpoints:**
- `GET /metrics` - Prometheus metrics for all queues
- `GET /metrics/{queueName}` - Prometheus metrics for a specific queue

**Authentication:**
When `USER_LOGIN` and `USER_PASSWORD` are set, metrics endpoints require HTTP Basic Authentication:
```bash
curl -u username:password http://localhost:3000/metrics
```

**Custom Labels:**
Add custom labels to metrics using `METRICS_VAR_*` environment variables:
```
METRICS_VAR_env=production
METRICS_VAR_server=1
METRICS_VAR_region=us-east-1
```

These will be included in the metrics output:
```
bullmq_job_count{queue="my-queue", state="waiting", env="production", server="1", region="us-east-1"} 5
```

**Prometheus Configuration Example:**
```yaml
scrape_configs:
  - job_name: 'bull-board'
    basic_auth:
      username: 'your-username'
      password: 'your-password'
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: '/metrics'
```

### Example with docker-compose

```yaml
version: '3.5'

services:
  redis:
    container_name: redis
    image: redis:5.0-alpine
    restart: always
    ports:
      - 6379:6379
    volumes:
      - redis_db_data:/data

  bullboard:
    container_name: bullboard
    image: diluka/bull-board
    restart: always
    ports:
      - 3000:3000
    environment:
      REDIS_HOST: redis
      REDIS_PORT: 6379
      REDIS_PASSWORD: example-password
      REDIS_USE_TLS: 'false'
      BULL_PREFIX: bull
      METRICS_ENABLED: 'true'
      METRICS_VAR_env: production
      METRICS_VAR_server: '1'
    depends_on:
      - redis

volumes:
  redis_db_data:
    external: false
```

[bull-board]: https://github.com/vcapretz/bull-board
[bull-board]: https://github.com/felixmosh/bull-board#hosting-router-on-a-sub-path
