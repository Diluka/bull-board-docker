import assert from 'node:assert/strict';

import { bundleBrowserTypeScript, type BundleProcessOutput } from './browser-typescript.ts';

const encoder = new TextEncoder();

Deno.test('bundles a TypeScript URL with an isolated browser ESM command', async () => {
  const entry = new URL('https://extensions.example/public/app.ts');
  let executable = '';
  let args: readonly string[] = [];

  const bundled = await bundleBrowserTypeScript(entry, {
    execute: (receivedExecutable, receivedArgs) => {
      executable = receivedExecutable;
      args = receivedArgs;
      return Promise.resolve(output({ stdout: 'const ready = true;\nexport { ready };\n' }));
    },
    execPath: () => '/runtime/deno',
  });

  assert.equal(executable, '/runtime/deno');
  assert.deepEqual(args, [
    'bundle',
    '--no-config',
    '--no-lock',
    '--platform',
    'browser',
    '--format',
    'esm',
    '--allow-import',
    entry.href,
  ]);
  assert.equal(bundled, 'const ready = true;\nexport { ready };\n');
});

Deno.test('reports the TypeScript URL, exit code, and stderr when bundling fails', async () => {
  const entry = new URL('https://extensions.example/public/broken.ts');

  await assert.rejects(
    () =>
      bundleBrowserTypeScript(entry, {
        execute: () => Promise.resolve(output({ success: false, code: 1, stderr: 'Unexpected token' })),
        execPath: () => '/runtime/deno',
      }),
    (error: unknown) => {
      assert.match(String(error), /broken\.ts/);
      assert.match(String(error), /exit code 1/);
      assert.match(String(error), /Unexpected token/);
      return true;
    },
  );
});

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

function output(
  overrides: { success?: boolean; code?: number; stdout?: string; stderr?: string } = {},
): BundleProcessOutput {
  return {
    success: overrides.success ?? true,
    code: overrides.code ?? 0,
    stdout: encoder.encode(overrides.stdout ?? ''),
    stderr: encoder.encode(overrides.stderr ?? ''),
  };
}
