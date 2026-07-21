import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ExtensionContext, JsonValue } from './api.ts';
import { loadExtensions, parseExtensionConfig, resolveExtensionSpecifier } from './loader.ts';

Deno.test('treats missing, blank, and empty extension configuration as empty', () => {
  assert.deepEqual(parseExtensionConfig(undefined), []);
  assert.deepEqual(parseExtensionConfig('  \n\t '), []);
  assert.deepEqual(parseExtensionConfig('[]'), []);
});

Deno.test('validates the complete extension configuration without exposing options', () => {
  const invalid = [
    '{',
    '{}',
    '[null]',
    '[""]',
    '[{"specifier":"", "options":{"secret":"do-not-print"}}]',
    '[42]',
  ];

  for (const value of invalid) {
    try {
      parseExtensionConfig(value);
      throw new Error(`expected ${value} to fail`);
    } catch (error) {
      assert.ok(error instanceof Error);
      assert.ok(error.message.toLowerCase().includes('extension') || error.message.includes('JSON array'));
      assert.ok(!error.message.includes('do-not-print'));
    }
  }
});

Deno.test('identifies an invalid entry by index and its supplied specifier', () => {
  assert.throws(
    () => parseExtensionConfig('[{"specifier":""}]'),
    /index 0 \(\)/,
  );
});

Deno.test('parses string and object extension entries', () => {
  assert.deepEqual(parseExtensionConfig('["./one.ts", {"specifier":"npm:example", "options":{"enabled":true}}]'), [
    { specifier: './one.ts', options: undefined },
    { specifier: 'npm:example', options: { enabled: true } },
  ]);
});

Deno.test('resolves relative, absolute, file URL, and directory specifiers to canonical file URLs', async () => {
  const cwd = await Deno.makeTempDir();
  const file = join(cwd, 'extension.ts');
  const directory = join(cwd, 'directory');
  await Deno.writeTextFile(file, 'export default {}');
  await Deno.mkdir(directory);
  await Deno.writeTextFile(join(directory, 'mod.ts'), 'export default {}');

  assert.equal(await resolveExtensionSpecifier('./extension.ts', cwd), pathToFileURL(file).href);
  assert.equal(await resolveExtensionSpecifier(file, cwd), pathToFileURL(file).href);
  assert.equal(await resolveExtensionSpecifier(pathToFileURL(file).href, cwd), pathToFileURL(file).href);
  assert.equal(await resolveExtensionSpecifier('./directory', cwd), pathToFileURL(join(directory, 'mod.ts')).href);
});

Deno.test('resolves symlinked extension targets when supported', async () => {
  const cwd = await Deno.makeTempDir();
  const target = join(cwd, 'target.ts');
  const link = join(cwd, 'link.ts');
  await Deno.writeTextFile(target, 'export default {}');
  try {
    await Deno.symlink(target, link);
  } catch (error) {
    if (error instanceof Deno.errors.PermissionDenied || String(error).includes('特权') || String(error).includes('privilege')) return;
    throw error;
  }
  assert.equal(await resolveExtensionSpecifier(link, cwd), pathToFileURL(link).href);
});

Deno.test('passes approved remote specifiers through and rejects unapproved schemes', async () => {
  const cwd = Deno.cwd();
  for (const specifier of ['npm:example', 'jsr:@scope/module', 'https://example.com/mod.ts']) {
    assert.equal(await resolveExtensionSpecifier(specifier, cwd), specifier);
  }
  for (const specifier of ['http://example.com/mod.ts', 'data:text/javascript,export default {}', 'blob:thing', 'git:repo']) {
    await assert.rejects(() => resolveExtensionSpecifier(specifier, cwd), /Unsupported extension specifier/);
  }
});

Deno.test('reports missing local extension files with their specifier', async () => {
  const cwd = await Deno.makeTempDir();
  await assert.rejects(() => resolveExtensionSpecifier('./missing.ts', cwd), /\.\/missing\.ts/);
});

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    redis: {} as never,
    queues: { list: () => [], get: () => undefined },
    proxyPath: '/proxy',
    createRouter: () => ({}) as never,
    mountRouter: () => {},
    importModule: () => Promise.resolve({ default: { id: 'valid', apiVersion: 1, activate: () => {} } }),
    ...overrides,
  };
}

Deno.test('loads defaults only, validates their contract, and rejects duplicate IDs', async () => {
  for (
    const module of [
      {},
      { default: {} },
      { default: { id: 'Invalid ID', apiVersion: 1, activate: () => {} } },
      { default: { id: 'valid', apiVersion: 2, activate: () => {} } },
      { default: { id: 'valid', apiVersion: 1, activate: true } },
    ]
  ) {
    await assert.rejects(() => loadExtensions(dependencies({ importModule: () => Promise.resolve(module) }), '["npm:one"]'));
  }

  await assert.rejects(
    () => loadExtensions(dependencies(), '["npm:one", "npm:two"]'),
    /Duplicate extension id "valid"/,
  );
});

Deno.test('activates extensions serially with isolated routers and context-bound URLs and links', async () => {
  const events: string[] = [];
  const routers: unknown[] = [];
  const mounts: string[] = [];
  const links: unknown[] = [];
  const modules = new Map([
    ['npm:first', {
      default: {
        id: 'first',
        apiVersion: 1,
        activate(context: ExtensionContext, options: JsonValue | undefined) {
          events.push(`first:${JSON.stringify(options)}`);
          routers.push(context.router);
          assert.equal(context.url('/jobs'), '/proxy/ext/first/jobs');
          assert.equal(context.url('/'), '/proxy/ext/first/');
          context.addLink({ text: 'First', path: '/jobs' });
        },
      },
    }],
    ['npm:second', {
      default: {
        id: 'second',
        apiVersion: 1,
        async activate(context: ExtensionContext) {
          await Promise.resolve();
          events.push('second');
          routers.push(context.router);
          assert.equal(context.url('runs'), '/proxy/ext/second/runs');
        },
      },
    }],
  ]);
  await loadExtensions(
    dependencies({
      createRouter: () => ({}) as never,
      mountRouter: (path: string) => mounts.push(path),
      addMiscLink: (link: unknown) => links.push(link),
      importModule: (specifier: string) => Promise.resolve(modules.get(specifier)),
    }),
    '[{"specifier":"npm:first", "options":{"mode":"on"}}, "npm:second"]',
  );

  assert.deepEqual(events, ['first:{"mode":"on"}', 'second']);
  assert.notEqual(routers[0], routers[1]);
  assert.deepEqual(mounts, ['/ext/first', '/ext/second']);
  assert.deepEqual(links, [{ text: 'First', url: '/proxy/ext/first/jobs' }]);
});

Deno.test('rolls back activated extensions in reverse order and dispose remains idempotent', async () => {
  const events: string[] = [];
  const modules = new Map([
    ['npm:a', { default: { id: 'a', apiVersion: 1, activate: () => () => events.push('dispose-a') } }],
    ['npm:b', { default: { id: 'b', apiVersion: 1, activate: () => () => events.push('dispose-b') } }],
    ['npm:c', {
      default: {
        id: 'c',
        apiVersion: 1,
        activate: () => {
          throw new Error('boom');
        },
      },
    }],
    ['npm:d', { default: { id: 'd', apiVersion: 1, activate: () => events.push('activate-d') } }],
  ]);
  await assert.rejects(
    () =>
      loadExtensions(
        dependencies({ importModule: (specifier: string) => Promise.resolve(modules.get(specifier)) }),
        '["npm:a", "npm:b", "npm:c", "npm:d"]',
      ),
    /boom/,
  );
  assert.deepEqual(events, ['dispose-b', 'dispose-a']);

  const lifecycle = await loadExtensions(
    dependencies({
      importModule: () => Promise.resolve({ default: { id: 'done', apiVersion: 1, activate: () => () => events.push('dispose-done') } }),
    }),
    '["npm:done"]',
  );
  await lifecycle.dispose();
  await lifecycle.dispose();
  assert.deepEqual(events, ['dispose-b', 'dispose-a', 'dispose-done']);
});

Deno.test('continues disposal after failures and reports all disposer errors', async () => {
  const events: string[] = [];
  let number = 0;
  const lifecycle = await loadExtensions(
    dependencies({
      importModule: () => {
        number++;
        const id = `extension-${number}`;
        return Promise.resolve({
          default: {
            id,
            apiVersion: 1,
            activate: () => () => {
              events.push(id);
              throw new Error(id);
            },
          },
        });
      },
    }),
    '["npm:a", "npm:b"]',
  );
  await assert.rejects(() => lifecycle.dispose(), AggregateError);
  assert.deepEqual(events, ['extension-2', 'extension-1']);
});
