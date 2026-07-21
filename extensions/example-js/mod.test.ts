import assert from 'node:assert/strict';
import express from 'express';

import type { ExtensionContext, ExtensionLink, RawQueue } from '../../src/extensions/api.ts';
import extension from './mod.ts';

async function request(router: express.Router, path: string): Promise<Response> {
  const app = express();
  app.use('/ext/example-js', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    return await fetch(`http://127.0.0.1:${address.port}/ext/example-js${path}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

Deno.test('JavaScript example mounts its static page and serves fresh queue snapshots', async () => {
  const router = express.Router();
  const links: ExtensionLink[] = [];
  let pageMount: Parameters<ExtensionContext['pages']['mount']>[0] | undefined;
  const queues = [{ name: 'alpha' }, { name: '<beta & gamma>' }] as RawQueue[];
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
    url: (path) => `/app/bull-board/ext/example-js${path}`,
    addLink: (link) => links.push(link),
  };

  assert.equal(extension.id, 'example-js');
  assert.equal(extension.apiVersion, 1);
  await extension.activate(context, undefined);

  assert.deepEqual(pageMount, {
    root: new URL('./public/', import.meta.url),
    preload: ['index.html', 'app.js', 'styles.css'],
  });
  assert.deepEqual(links, [{ text: 'JavaScript Example', path: '/' }]);

  const firstResponse = await request(router, '/api/queues');
  assert.equal(firstResponse.status, 200);
  assert.deepEqual(await firstResponse.json(), {
    queueCount: 2,
    queues: ['alpha', '<beta & gamma>'],
  });

  queues.push({ name: 'omega' } as RawQueue);
  const secondResponse = await request(router, '/api/queues');
  assert.equal(secondResponse.status, 200);
  assert.deepEqual(await secondResponse.json(), {
    queueCount: 3,
    queues: ['alpha', '<beta & gamma>', 'omega'],
  });
});

Deno.test('JavaScript example has accessible AJAX queue UI assets', async () => {
  const publicDirectory = new URL('./public/', import.meta.url);
  const [html, script, styles] = await Promise.all([
    Deno.readTextFile(new URL('index.html', publicDirectory)),
    Deno.readTextFile(new URL('app.js', publicDirectory)),
    Deno.readTextFile(new URL('styles.css', publicDirectory)),
  ]);

  assert.match(html, /aria-live=["']polite["']/);
  assert.match(html, /<ul[^>]*id=["']queue-list["']/);
  assert.match(html, /<button[^>]*id=["']refresh-button["']/);
  assert.match(html, /href=["']\.\/styles\.css["']/);
  assert.match(html, /src=["']\.\/app\.js["']/);
  assert.match(script, /fetch\(['"]\.\/api\/queues['"]\)/);
  assert.match(script, /document\.createElement\(/);
  assert.match(script, /\.textContent\s*=/);
  assert.doesNotMatch(script, /innerHTML/);
  assert.match(styles, /:root/);
  assert.match(styles, /reveal/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /repeating-linear-gradient/);
});
