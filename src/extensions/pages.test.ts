import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import express, { type Express } from 'express';

import { createExtensionPages } from './pages.ts';

Deno.test('serves preloaded pages, nested indexes, and supported asset media types', async () => {
  const app = express();
  const router = express.Router();
  app.use(router);
  const loads: string[] = [];
  const controller = createExtensionPages('example', router, () => true, {
    loadText: async (url) => {
      loads.push(url.pathname);
      return new Map([
        ['/public/index.html', '<!doctype html><h1>Example</h1>'],
        ['/public/app.js', 'console.log("example")'],
        ['/public/styles.css', 'body { color: green; }'],
        ['/public/nested/index.html', '<p>Nested</p>'],
      ]).get(url.pathname) ?? Promise.reject(new Error(`missing ${url.pathname}`));
    },
  });

  controller.pages.mount({
    root: new URL('https://extensions.example/public/'),
    preload: ['index.html', 'app.js', 'styles.css'],
  });
  await controller.completeActivation();

  assert.equal(await text(await request(app, '/')), '<!doctype html><h1>Example</h1>');
  assert.equal((await request(app, '/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await request(app, '/nested/')).status, 200);
  assert.equal((await request(app, '/image.png')).status, 404);
  assert.deepEqual(loads, ['/public/index.html', '/public/app.js', '/public/styles.css', '/public/nested/index.html']);
});

Deno.test('only permits one mount while the extension is activating', () => {
  const router = express.Router();
  const inactive = createExtensionPages('example', router, () => false, { loadText: async () => '' });
  assert.throws(
    () => inactive.pages.mount({ root: new URL('https://extensions.example/public/') }),
    /only mount pages while activating/,
  );

  const active = createExtensionPages('example', router, () => true, { loadText: async () => '' });
  active.pages.mount({ root: new URL('https://extensions.example/public/') });
  assert.throws(
    () => active.pages.mount({ root: new URL('https://extensions.example/other/') }),
    /only mount one page root/,
  );
});

Deno.test('rejects unsafe roots and preload paths before registering a page mount', () => {
  const controller = createExtensionPages('example', express.Router(), () => true, { loadText: async () => '' });
  for (
    const root of [
      'ftp://extensions.example/public/',
      'https://user@extensions.example/public/',
      'https://extensions.example/public/?version=1',
      'https://extensions.example/public/#fragment',
      'https://extensions.example/public',
    ]
  ) {
    assert.throws(() => controller.pages.mount({ root: new URL(root) }), /page root/i);
  }

  for (
    const preload of [
      ['/index.html'],
      ['//extensions.example/index.html'],
      ['../index.html'],
      ['nested/../index.html'],
      ['nested/../../index.html'],
      ['%2e%2e/index.html'],
      ['nested/%2e%2e/index.html'],
      ['nested\\index.html'],
      ['nested/%5cindex.html'],
      ['nested/%00index.html'],
      ['index.html?x=1'],
    ]
  ) {
    const pages = createExtensionPages('example', express.Router(), () => true, { loadText: async () => '' });
    assert.throws(
      () => pages.pages.mount({ root: new URL('https://extensions.example/public/'), preload }),
      /preload/i,
    );
  }
});

Deno.test('loads a real file URL page root with Deno text imports', async () => {
  const directory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(join(directory, 'index.html'), '<!doctype html><h1>File</h1>');
    const app = express();
    const router = express.Router();
    app.use(router);
    const controller = createExtensionPages('example', router, () => true);
    controller.pages.mount({ root: new URL('./', pathToFileURL(join(directory, 'placeholder')).href) });
    await controller.completeActivation();

    assert.equal(await text(await request(app, '/')), '<!doctype html><h1>File</h1>');
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test('rejects noncanonical request asset paths before URL normalization', async () => {
  const app = express();
  const router = express.Router();
  app.use(router);
  const loads: string[] = [];
  const controller = createExtensionPages('example', router, () => true, {
    loadText: async (url) => {
      loads.push(url.href);
      return '<p>safe</p>';
    },
  });
  controller.pages.mount({ root: new URL('https://extensions.example/public/') });
  await controller.completeActivation();

  for (
    const path of [
      '/nested/../index.html',
      '/%2e%2e/private.html',
      '/nested/%2e%2e/%2e%2e/private.html',
      '//extensions.example/index.html',
      '/nested\\index.html',
      '/nested/%5cindex.html',
      '/nested/%00index.html',
      '/index.html?version=1',
    ]
  ) {
    assert.equal((await rawRequest(app, path)).status, 404, path);
  }
  assert.deepEqual(loads, []);
});

Deno.test('serves map and SVG assets with exact types while rejecting HTM without loading it', async () => {
  const app = express();
  const router = express.Router();
  app.use(router);
  const loads: string[] = [];
  const controller = createExtensionPages('example', router, () => true, {
    loadText: async (url) => {
      loads.push(url.pathname);
      return url.pathname.endsWith('.map') ? '{"version":3}' : '<svg xmlns="http://www.w3.org/2000/svg" />';
    },
  });
  controller.pages.mount({ root: new URL('https://extensions.example/public/') });
  await controller.completeActivation();

  assert.equal((await request(app, '/app.js.map')).headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal((await request(app, '/app.js.map', { method: 'HEAD' })).headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal((await request(app, '/logo.svg')).headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.equal((await request(app, '/logo.svg', { method: 'HEAD' })).headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.equal((await request(app, '/legacy.htm')).status, 404);
  assert.deepEqual(loads, ['/public/app.js.map', '/public/logo.svg']);
});

Deno.test('handles GET and HEAD without overriding explicit routes', async () => {
  const app = express();
  const router = express.Router();
  app.use(router);
  router.get('/explicit', (_request, response) => response.send('explicit route'));
  const controller = createExtensionPages('example', router, () => true, { loadText: async () => '<p>fallback</p>' });
  controller.pages.mount({ root: new URL('https://extensions.example/public/') });
  await controller.completeActivation();

  assert.equal(await text(await request(app, '/explicit')), 'explicit route');
  const head = await request(app, '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await request(app, '/', { method: 'POST' })).status, 404);
});

Deno.test('does not install a fallback when preloading fails', async () => {
  const app = express();
  const router = express.Router();
  app.use(router);
  const controller = createExtensionPages('example', router, () => true, {
    loadText: async () => Promise.reject(new Error('preload failed')),
  });
  controller.pages.mount({ root: new URL('https://extensions.example/public/'), preload: ['index.html'] });

  await assert.rejects(() => controller.completeActivation(), /preload failed/);
  assert.equal((await request(app, '/')).status, 404);
});

Deno.test('deduplicates concurrent loads and retries rejected lazy loads', async () => {
  const app = express();
  const router = express.Router();
  app.use(router);
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  let markSecondStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => markSecondStarted = resolve);
  const controller = createExtensionPages('example', router, () => true, {
    loadText: async () => {
      calls++;
      if (calls === 1) throw new Error('temporary failure');
      if (calls === 2) {
        markSecondStarted();
        await blocked;
      }
      return '<p>loaded</p>';
    },
  });
  controller.pages.mount({ root: new URL('https://extensions.example/public/') });
  await controller.completeActivation();

  assert.equal((await request(app, '/')).status, 404);
  const first = request(app, '/');
  const second = request(app, '/');
  await secondStarted;
  assert.equal(calls, 2);
  release();
  assert.equal(await text(await first), '<p>loaded</p>');
  assert.equal(await text(await second), '<p>loaded</p>');
  assert.equal(calls, 2);
});

Deno.test('keeps page mounts and asset caches isolated between controllers', async () => {
  const first = express();
  const firstRouter = express.Router();
  first.use(firstRouter);
  const second = express();
  const secondRouter = express.Router();
  second.use(secondRouter);
  const firstController = createExtensionPages('first', firstRouter, () => true, { loadText: async () => '<p>first</p>' });
  const secondController = createExtensionPages('second', secondRouter, () => true, { loadText: async () => '<p>second</p>' });
  firstController.pages.mount({ root: new URL('https://extensions.example/first/') });
  secondController.pages.mount({ root: new URL('https://extensions.example/second/') });
  await Promise.all([firstController.completeActivation(), secondController.completeActivation()]);

  assert.equal(await text(await request(first, '/')), '<p>first</p>');
  assert.equal(await text(await request(second, '/')), '<p>second</p>');
});

Deno.test('uses Deno text imports for HTTP assets and caches the default loader result', async () => {
  let requests = 0;
  const source = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) => {
    requests++;
    assert.equal(new URL(request.url).pathname, '/public/index.html');
    return new Response('<!doctype html><h1>HTTP</h1>', { headers: { 'content-type': 'text/html' } });
  });
  const app = express();
  const router = express.Router();
  app.use(router);
  const controller = createExtensionPages('example', router, () => true);
  controller.pages.mount({ root: new URL(`http://127.0.0.1:${source.addr.port}/public/`) });
  try {
    await controller.completeActivation();

    assert.equal(await text(await request(app, '/')), '<!doctype html><h1>HTTP</h1>');
    assert.equal(await text(await request(app, '/')), '<!doctype html><h1>HTTP</h1>');
    assert.equal(requests, 1);
  } finally {
    await source.shutdown();
  }
});

async function request(app: Express, path: string, init: RequestInit = {}): Promise<Response> {
  return withServer(app, async (port) => await fetch(`http://127.0.0.1:${port}${path}`, init));
}

async function rawRequest(app: Express, path: string): Promise<Response> {
  return withServer(app, (port) =>
    new Promise<Response>((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port, path }, (response) => {
        const chunks: Uint8Array[] = [];
        response.on('data', (chunk: Uint8Array) => chunks.push(chunk));
        response.on('end', () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode,
              headers: response.headers as Record<string, string>,
            }),
          ));
      });
      request.once('error', reject);
      request.end();
    }));
}

async function withServer<Result>(app: Express, operation: (port: number) => Promise<Result>): Promise<Result> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return await operation(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function text(response: Response): Promise<string> {
  return response.text();
}
