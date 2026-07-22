import assert from 'node:assert/strict';

import { bundleBrowserTypeScript } from './browser-typescript.ts';

Deno.test('bundles a real HTTP TypeScript entry with relative imports into executable browser ESM', async () => {
  const source = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, (request) => {
    switch (new URL(request.url).pathname) {
      case '/app.ts':
        return new Response(
          'import { message } from "./message.ts"; interface Viewer { name: string } export const render = (viewer: Viewer): string => message(viewer.name);',
          { headers: { 'content-type': 'application/typescript' } },
        );
      case '/message.ts':
        return new Response('export const message = (name: string): string => `Hello, ${name}!`;', {
          headers: { 'content-type': 'application/typescript' },
        });
      default:
        return new Response('missing', { status: 404 });
    }
  });

  try {
    const bundled = await bundleBrowserTypeScript(new URL(`http://127.0.0.1:${source.addr.port}/app.ts`));
    assert.doesNotMatch(bundled, /interface Viewer|name: string|: Viewer/);
    const module = await import(`data:text/javascript,${encodeURIComponent(bundled)}`);
    assert.equal(module.render({ name: 'TypeScript' }), 'Hello, TypeScript!');
  } finally {
    await source.shutdown();
  }
});

Deno.test('reports real TypeScript bundling failures with source diagnostics', async () => {
  const source = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, () => {
    return new Response('export const broken = ;', { headers: { 'content-type': 'application/typescript' } });
  });
  const entry = new URL(`http://127.0.0.1:${source.addr.port}/broken.ts`);
  try {
    await assert.rejects(() => bundleBrowserTypeScript(entry), (error: unknown) => {
      const message = String(error);
      assert.match(message, /broken\.ts/);
      assert.match(message, /exit code [1-9][0-9]*/);
      assert.doesNotMatch(message, /no error output$/);
      return true;
    });
  } finally {
    await source.shutdown();
  }
});
