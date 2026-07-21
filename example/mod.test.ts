import assert from 'node:assert/strict';
import express from 'express';

import type { ExtensionContext, ExtensionLink, RawQueue } from '../src/extensions/api.ts';
import extension from './mod.ts';

async function request(router: express.Router): Promise<Response> {
  const app = express();
  app.use('/ext/example', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    return await fetch(`http://127.0.0.1:${address.port}/ext/example/`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

Deno.test('example extension registers its root page and navigation link from raw queues', async () => {
  const router = express.Router();
  const links: ExtensionLink[] = [];
  const queues = [{ name: 'alpha' }, { name: '<beta & gamma>' }] as RawQueue[];
  const context: ExtensionContext = {
    redis: {} as ExtensionContext['redis'],
    queues: {
      list: () => queues,
      get: (name) => queues.find((queue) => queue.name === name),
    },
    router,
    proxyPath: '/app/bull-board',
    url: (path) => `/app/bull-board/ext/example${path}`,
    addLink: (link) => links.push(link),
  };

  assert.equal(extension.id, 'example');
  assert.equal(extension.apiVersion, 1);
  await extension.activate(context, undefined);

  assert.deepEqual(links, [{ text: 'Example', path: '/' }]);
  const response = await request(router);
  assert.equal(response.status, 200);
  const page = await response.text();
  assert.match(page, /Queue count:\s*2/);
  assert.match(page, /<li>alpha<\/li>/);
  assert.match(page, /<li>&lt;beta &amp; gamma&gt;<\/li>/);
  assert.doesNotMatch(page, /<beta & gamma>/);
});
