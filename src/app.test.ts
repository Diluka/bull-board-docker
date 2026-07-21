import assert from 'node:assert/strict';
import express, { type RequestHandler, type Router } from 'express';

import type { ExtensionLifecycle, ExtensionLoaderDependencies } from './extensions/loader.ts';
import { createApplication } from './app.ts';

function testConfig(overrides: Record<string, unknown> = {}) {
  return {
    AUTH_ENABLED: false,
    LOGIN_PAGE: '/login',
    METRICS_ENABLED: false,
    METRICS_VARS: {},
    PROXY_LOGIN_PAGE: '/proxy/login',
    PROXY_PATH: '/proxy',
    ...overrides,
  };
}

function noopMiddleware(): RequestHandler {
  return (_req, _res, next) => next();
}

function runtimeOverrides(overrides: Record<string, unknown> = {}) {
  return {
    isProduction: true,
    session: () => noopMiddleware(),
    passport: {
      initialize: () => noopMiddleware(),
      session: () => noopMiddleware(),
      authenticate: () => noopMiddleware(),
    },
    ensureLoggedIn: () => noopMiddleware(),
    authRouter: express.Router(),
    ...overrides,
  };
}

async function request(app: express.Express, path: string): Promise<Response> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    return await fetch(`http://127.0.0.1:${address.port}${path}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

Deno.test('application refreshes before extensions and creates Bull Board once with collected links', async () => {
  const events: string[] = [];
  const initialAdapters = [{ adapter: 'one' }];
  const queues = {
    list: () => [],
    get: () => undefined,
    refresh() {
      events.push('refresh');
      return Promise.resolve(initialAdapters);
    },
  };
  const boardRouter = express.Router();
  boardRouter.get('/', (_req, res) => res.send('board'));
  const serverAdapter = {
    setBasePath(path: string) {
      events.push(`base:${path}`);
    },
    getRouter: () => boardRouter,
  };
  let boardOptions: Record<string, unknown> | undefined;
  let boardCreations = 0;
  const lifecycle: ExtensionLifecycle = { dispose: () => Promise.resolve() };

  const result = await createApplication(
    { config: testConfig(), redis: {} as never, queues, serverAdapter },
    runtimeOverrides({
      loadExtensions(dependencies: ExtensionLoaderDependencies) {
        events.push('extensions');
        const router = express.Router();
        router.get('/hello', (_req, res) => res.send('extension'));
        dependencies.mountRouter('/ext/demo', router);
        dependencies.addMiscLink({ text: 'Demo', url: '/proxy/ext/demo/hello' });
        return Promise.resolve(lifecycle);
      },
      createBullBoard(options: Record<string, unknown>) {
        boardCreations++;
        events.push('board');
        boardOptions = options;
        return { replaceQueues: () => {} };
      },
    }),
  );

  assert.deepEqual(events, ['refresh', 'extensions', 'base:/proxy', 'board']);
  assert.equal(boardCreations, 1);
  assert.equal(boardOptions?.queues, initialAdapters);
  assert.deepEqual(boardOptions?.options, { uiConfig: { miscLinks: [{ text: 'Demo', url: '/proxy/ext/demo/hello' }] } });
  assert.equal(result.extensionLifecycle, lifecycle);
  assert.equal(await (await request(result.app, '/ext/demo/hello')).text(), 'extension');
  assert.equal((await request(result.app, '/proxy/ext/demo/hello')).status, 404);
  assert.equal(await (await request(result.app, '/')).text(), 'board');
});

Deno.test('metrics and login use internal paths before authentication while extensions stay protected', async () => {
  const extensionRouter = express.Router();
  extensionRouter.get('/hello', (_req, res) => res.send('extension'));
  const loginRouter = express.Router();
  loginRouter.get('/', (_req, res) => res.send('login'));
  const deny: RequestHandler = (_req, res) => {
    res.status(401).send('protected');
  };
  const boardRouter = express.Router();
  const queues = {
    list: () => [],
    get: () => undefined,
    refresh: () => Promise.resolve([]),
  };
  const result = await createApplication(
    {
      config: testConfig({ AUTH_ENABLED: true, METRICS_ENABLED: true }),
      redis: {} as never,
      queues,
      serverAdapter: { setBasePath: () => {}, getRouter: () => boardRouter },
    },
    runtimeOverrides({
      authRouter: loginRouter,
      ensureLoggedIn: () => deny,
      loadExtensions: (dependencies: ExtensionLoaderDependencies) => {
        dependencies.mountRouter('/ext/demo', extensionRouter);
        return Promise.resolve({ dispose: () => Promise.resolve() });
      },
      createBullBoard: () => ({ replaceQueues: () => {} }),
    }),
  );

  assert.equal((await request(result.app, '/metrics')).status, 404);
  assert.equal((await request(result.app, '/metrics/missing')).status, 404);
  assert.equal(await (await request(result.app, '/login')).text(), 'login');
  assert.equal((await request(result.app, '/ext/demo/hello')).status, 401);
  assert.equal((await request(result.app, '/proxy/metrics')).status, 401);
});

Deno.test('application disposes activated extensions when later assembly fails', async () => {
  const events: string[] = [];
  await assert.rejects(
    () =>
      createApplication(
        {
          config: testConfig(),
          redis: {} as never,
          queues: { list: () => [], get: () => undefined, refresh: () => Promise.resolve([]) },
          serverAdapter: { setBasePath: () => {}, getRouter: () => express.Router() },
        },
        runtimeOverrides({
          loadExtensions: () =>
            Promise.resolve({
              dispose: () => {
                events.push('dispose');
                return Promise.resolve();
              },
            }),
          createBullBoard: () => {
            throw new Error('board failed');
          },
        }),
      ),
    /board failed/,
  );
  assert.deepEqual(events, ['dispose']);
});
