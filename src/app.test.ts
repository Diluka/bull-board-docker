import assert from 'node:assert/strict';
import express, { type RequestHandler, type Router } from 'express';

import type { ExtensionContext } from './extensions/api.ts';
import { createApplication } from './app.ts';
import { prepareExtensions } from './extensions/loader.ts';

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

Deno.test('application imports before refresh, activates serially, creates Bull Board, then mounts extension and Board routers', async () => {
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
  const protectedRouter = express.Router();
  const useProtectedRouter = protectedRouter.use.bind(protectedRouter) as (...args: unknown[]) => Router;
  protectedRouter.use = ((...args: unknown[]) => {
    events.push(typeof args[0] === 'string' ? `mount:${args[0]}` : 'mount:board');
    return useProtectedRouter(...args);
  }) as typeof protectedRouter.use;
  const serverAdapter = {
    setBasePath(path: string) {
      events.push(`base:${path}`);
    },
    getRouter: () => boardRouter,
  };
  let boardOptions: Record<string, unknown> | undefined;
  let boardCreations = 0;

  const result = await createApplication(
    { config: testConfig(), redis: {} as never, queues, serverAdapter },
    runtimeOverrides({
      prepareExtensions() {
        const modules = new Map([
          ['npm:demo', {
            default: {
              id: 'demo',
              apiVersion: 1,
              activate(context: { router: Router; addLink(link: { text: string; path: `/${string}` }): void }) {
                events.push('activate:demo');
                context.router.get('/hello', (_req, res) => res.send('extension'));
                context.addLink({ text: 'Demo', path: '/hello' });
              },
            },
          }],
          ['npm:second', {
            default: {
              id: 'second',
              apiVersion: 1,
              activate() {
                events.push('activate:second');
              },
            },
          }],
        ]);
        return prepareExtensions(
          {
            importModule(specifier) {
              events.push(`import:${specifier}`);
              return Promise.resolve(modules.get(specifier));
            },
          },
          '["npm:demo", "npm:second"]',
        );
      },
      createProtectedRouter: () => protectedRouter,
      createBullBoard(options: Record<string, unknown>) {
        boardCreations++;
        events.push('board');
        boardOptions = options;
        return { replaceQueues: () => {} };
      },
    }),
  );

  assert.deepEqual(events, [
    'import:npm:demo',
    'import:npm:second',
    'refresh',
    'activate:demo',
    'activate:second',
    'base:/proxy',
    'board',
    'mount:/ext/demo',
    'mount:/ext/second',
    'mount:board',
  ]);
  assert.equal(boardCreations, 1);
  assert.equal(boardOptions?.queues, initialAdapters);
  assert.deepEqual(boardOptions?.options, { uiConfig: { miscLinks: [{ text: 'Demo', url: '/proxy/ext/demo/hello' }] } });
  const miscLinks = (boardOptions?.options as { uiConfig: { miscLinks: unknown[] } }).uiConfig.miscLinks;
  assert.ok(Object.isFrozen(miscLinks));
  assert.equal(await (await request(result.app, '/ext/demo/hello')).text(), 'extension');
  assert.equal((await request(result.app, '/proxy/ext/demo/hello')).status, 404);
  assert.equal(await (await request(result.app, '/')).text(), 'board');
});

Deno.test('application injects an accessible inline icon into the Bull Board extension menu', async () => {
  const boardRouter = express.Router();
  boardRouter.get('/', (_req, res) => res.type('html').send('<!doctype html><html><body><div id="root"></div></body></html>'));
  const result = await createApplication(
    {
      config: testConfig(),
      redis: {} as never,
      queues: { list: () => [], get: () => undefined, refresh: () => Promise.resolve([]) },
      serverAdapter: { setBasePath: () => {}, getRouter: () => boardRouter },
    },
    runtimeOverrides({
      prepareExtensions: () =>
        prepareExtensions({
          importModule: () =>
            Promise.resolve({
              default: {
                id: 'demo',
                apiVersion: 1,
                activate(context: ExtensionContext) {
                  context.addLink({ text: 'Demo', path: '/' });
                },
              },
            }),
        }, '["npm:demo"]'),
      createBullBoard: () => ({ replaceQueues: () => {} }),
    }),
  );

  const html = await (await request(result.app, '/')).text();
  assert.match(html, /data-bull-board-extension-menu-icon/);
  assert.match(html, /data-bull-board-extension-icon[^>]+viewBox="2 2 20 20"[^>]+fill="currentColor"/);
  assert.doesNotMatch(html, /data-bull-board-extension-icon[^>]+stroke=/);
  assert.match(html, /setAttribute\('aria-label', 'Extensions'\)/);
});

Deno.test('application does not refresh queues or activate when a later extension import fails', async () => {
  let refreshCalls = 0;
  let activateCalls = 0;
  await assert.rejects(
    () =>
      createApplication(
        {
          config: testConfig(),
          redis: {} as never,
          queues: {
            list: () => [],
            get: () => undefined,
            refresh: () => {
              refreshCalls++;
              return Promise.resolve([]);
            },
          },
          serverAdapter: { setBasePath: () => {}, getRouter: () => express.Router() },
        },
        runtimeOverrides({
          prepareExtensions: () =>
            prepareExtensions(
              {
                importModule: (specifier) =>
                  specifier === 'npm:first'
                    ? Promise.resolve({
                      default: {
                        id: 'first',
                        apiVersion: 1,
                        activate: () => {
                          activateCalls++;
                        },
                      },
                    })
                    : Promise.reject(new Error('later import failed')),
              },
              '["npm:first", "npm:missing"]',
            ),
        }),
      ),
    /later import failed/,
  );

  assert.equal(refreshCalls, 0);
  assert.equal(activateCalls, 0);
});

Deno.test('application does not refresh queues or activate when a later contract or duplicate id check fails', async () => {
  for (const failure of ['contract', 'duplicate'] as const) {
    let refreshCalls = 0;
    let activateCalls = 0;
    const first = {
      default: {
        id: 'first',
        apiVersion: 1,
        activate: () => {
          activateCalls++;
        },
      },
    };
    const second = failure === 'contract'
      ? { default: { id: 'second', apiVersion: 2, activate: () => {} } }
      : { default: { id: 'first', apiVersion: 1, activate: () => {} } };

    await assert.rejects(
      () =>
        createApplication(
          {
            config: testConfig(),
            redis: {} as never,
            queues: {
              list: () => [],
              get: () => undefined,
              refresh: () => {
                refreshCalls++;
                return Promise.resolve([]);
              },
            },
            serverAdapter: { setBasePath: () => {}, getRouter: () => express.Router() },
          },
          runtimeOverrides({
            prepareExtensions: () =>
              prepareExtensions({
                importModule: (specifier) => Promise.resolve(specifier === 'npm:first' ? first : second),
              }, '["npm:first", "npm:second"]'),
          }),
        ),
      failure === 'contract' ? /apiVersion 1/ : /Duplicate extension id "first"/,
    );

    assert.equal(refreshCalls, 0, `${failure} failure refreshed queues`);
    assert.equal(activateCalls, 0, `${failure} failure activated an extension`);
  }
});

Deno.test('metrics and login use internal paths before authentication while extensions stay protected', async () => {
  const extensionRouter = express.Router();
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
      prepareExtensions: () =>
        prepareExtensions({
          createRouter: () => extensionRouter,
          importModule: () =>
            Promise.resolve({
              default: {
                id: 'demo',
                apiVersion: 1,
                activate(context: ExtensionContext) {
                  context.router.get('/hello', (_req, res) => res.send('extension'));
                },
              },
            }),
        }, '["npm:demo"]'),
      createBullBoard: () => ({ replaceQueues: () => {} }),
    }),
  );

  assert.equal((await request(result.app, '/metrics')).status, 404);
  assert.equal((await request(result.app, '/metrics/missing')).status, 404);
  assert.equal(await (await request(result.app, '/login')).text(), 'login');
  assert.equal((await request(result.app, '/ext/demo/hello')).status, 401);
  assert.equal((await request(result.app, '/proxy/metrics')).status, 401);
});

Deno.test('application disposes activated extensions in reverse order when router mounting fails', async () => {
  const events: string[] = [];
  const modules = new Map([
    ['npm:a', { default: { id: 'a', apiVersion: 1, activate: () => () => events.push('dispose-a') } }],
    ['npm:b', { default: { id: 'b', apiVersion: 1, activate: () => () => events.push('dispose-b') } }],
  ]);
  const protectedRouter = express.Router();
  const useProtectedRouter = protectedRouter.use.bind(protectedRouter) as (...args: unknown[]) => Router;
  protectedRouter.use = ((...args: unknown[]) => {
    if (args[0] === '/ext/b') throw new Error('mount failed');
    return useProtectedRouter(...args);
  }) as typeof protectedRouter.use;

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
          prepareExtensions: () =>
            prepareExtensions({
              importModule: (specifier) => Promise.resolve(modules.get(specifier)),
            }, '["npm:a", "npm:b"]'),
          createProtectedRouter: () => protectedRouter,
          createBullBoard: () => ({ replaceQueues: () => {} }),
        }),
      ),
    /mount failed/,
  );
  assert.deepEqual(events, ['dispose-b', 'dispose-a']);
});
