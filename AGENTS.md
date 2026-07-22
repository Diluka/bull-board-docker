# Repository Guidelines

This repository packages Bull Board as a Deno-based TypeScript service and Docker image. It supports Bull and BullMQ queues backed by Redis.

## Layout

- `src/`: application assembly, configuration, queue discovery, authentication, metrics, and process lifecycle.
- `src/extensions/`: runtime extension API, loader, page serving, and browser TypeScript support.
- `extensions/`: JavaScript and TypeScript extension examples with colocated tests.
- `test/`: acceptance tests, Docker integration tests, and fixtures.
- `Dockerfile` and `docker-compose.test.yml`: image construction and container-level verification.

## Commands

Use Deno 2.4 or later.

```bash
deno task dev
deno task start
deno task test:unit
deno task test:docker
deno task test
```

Run a single test file with CI-compatible isolation:

```bash
deno test -A --frozen --node-modules-dir=none path/to/file.test.ts
```

Run the repository checks before submitting a change:

```bash
deno check --frozen --node-modules-dir=none src/*.ts src/extensions/*.ts extensions/*/*.ts extensions/*/public/*.ts test/*.ts
deno lint src/ extensions/ test/
deno fmt --check src/ extensions/ test/
```

## Conventions

- Follow `deno.json`: two-space indentation, single quotes, a 140-character line width, and semicolons.
- Include the `.ts` extension in local TypeScript imports and manage npm dependencies in `package.json`.
- Keep `*.test.ts` files next to their implementations when practical; use `test/` for cross-process and container behavior.
- Update `deno.lock` only when dependencies change.
- Run `deno task test:docker` for changes to the Dockerfile, startup flow, Redis integration, or container behavior.

## Runtime Extensions

- `BULL_BOARD_EXTENSIONS` is an ordered JSON array; a directory specifier resolves to its `mod.ts` file.
- Loading, activation, or preload failures must prevent the HTTP server from listening.
- Extensions are trusted in-process code running under `deno run -A`, not sandboxed plugins.
- Browser-visible URLs must support `PROXY_PATH`; extensions should construct links through the context API.
- Shutdown must continue to release extensions, queues, the HTTP server, and Redis connections.
