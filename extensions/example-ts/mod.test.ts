import assert from 'node:assert/strict';
import express from 'express';

import type { ExtensionContext, ExtensionLink, RawQueue } from '../../src/extensions/api.ts';
import extension from './mod.ts';

Deno.test('TypeScript example preloads its browser entry and serves queue snapshots', async () => {
  const router = express.Router();
  const links: ExtensionLink[] = [];
  let pageMount: Parameters<ExtensionContext['pages']['mount']>[0] | undefined;
  const queues = [{ name: 'typed-queue' }] as RawQueue[];
  const context: ExtensionContext = {
    redis: {} as ExtensionContext['redis'],
    queues: {
      list: () => queues,
      get: (name) => queues.find((queue) => queue.name === name),
    },
    router,
    pages: {
      mount: (options) => {
        pageMount = options;
      },
    },
    proxyPath: '/app/bull-board',
    url: (path) => `/app/bull-board/ext/example-ts${path}`,
    addLink: (link) => links.push(link),
  };

  assert.equal(extension.id, 'example-ts');
  assert.equal(extension.apiVersion, 1);
  await extension.activate(context, undefined);

  assert.deepEqual(pageMount, {
    root: new URL('./public/', import.meta.url),
    preload: ['index.html', 'app.ts', 'styles.css'],
  });
  assert.deepEqual(links, [{ text: 'TypeScript Example', path: '/' }]);

  const response = await request(router, '/api/queues');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { queueCount: 1, queues: ['typed-queue'] });
});

Deno.test('TypeScript example uses a native module entry with a relative typed import', async () => {
  const publicDirectory = new URL('./public/', import.meta.url);
  const [html, entry, queueView, styles] = await Promise.all([
    Deno.readTextFile(new URL('index.html', publicDirectory)),
    Deno.readTextFile(new URL('app.ts', publicDirectory)),
    Deno.readTextFile(new URL('queue-view.ts', publicDirectory)),
    Deno.readTextFile(new URL('styles.css', publicDirectory)),
  ]);

  assert.match(html, /<script[^>]+type=["']module["'][^>]+src=["']\.\/app\.ts["']/);
  assert.match(html, /aria-live=["']polite["']/);
  assert.match(html, /<button[^>]*id=["']refresh-button["']/);
  assert.match(entry, /from ['"]\.\/queue-view\.ts['"]/);
  assert.match(entry, /interface QueueSnapshot/);
  assert.match(entry, /fetch\(['"]\.\/api\/queues['"]\)/);
  assert.match(queueView, /readonly string\[\]/);
  assert.match(queueView, /document\.createElement\(/);
  assert.doesNotMatch(entry + queueView, /innerHTML/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /repeating-linear-gradient/);
});

async function request(router: express.Router, path: string): Promise<Response> {
  const app = express();
  app.use('/ext/example-ts', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    return await fetch(`http://127.0.0.1:${address.port}/ext/example-ts${path}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
