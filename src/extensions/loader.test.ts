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
    addMiscLink: () => {},
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
          assert.equal(context.url('/runs'), '/proxy/ext/second/runs');
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

Deno.test('keeps extension URLs rooted while preserving query, fragment, and encoded filenames', async () => {
  await loadExtensions(
    dependencies({
      importModule: () =>
        Promise.resolve({
          default: {
            id: 'safe',
            apiVersion: 1,
            activate(context: ExtensionContext) {
              assert.equal(context.url('/jobs'), '/proxy/ext/safe/jobs');
              assert.equal(context.url('/'), '/proxy/ext/safe/');
              assert.equal(context.url('/reports/%2efile%20name?tab=jobs#top'), '/proxy/ext/safe/reports/%2efile%20name?tab=jobs#top');
            },
          },
        }),
    }),
    '["npm:safe"]',
  );
});

Deno.test('rejects extension URLs that WHATWG normalizes outside the extension mount', async () => {
  await loadExtensions(
    dependencies({
      importModule: () =>
        Promise.resolve({
          default: {
            id: 'safe',
            apiVersion: 1,
            activate(context: ExtensionContext) {
              for (
                const path of [
                  '/%2e%2e/%2e%2e/metrics',
                  '/%2E%2E/%2E%2E/metrics',
                  '/.%2e/metrics',
                  '/%2e./metrics',
                  '/../metrics',
                  '/..\\metrics',
                  'https://attacker.example/metrics',
                ]
              ) {
                assert.throws(() => context.url(path as `/${string}`), /Extension URL .* escapes extension mount/);
              }
            },
          },
        }),
    }),
    '["npm:safe"]',
  );
});

Deno.test('rejects unsafe links during activation and rolls back earlier extensions', async () => {
  const events: string[] = [];
  const modules = new Map([
    ['npm:first', { default: { id: 'first', apiVersion: 1, activate: () => () => events.push('dispose-first') } }],
    ['npm:unsafe', {
      default: {
        id: 'unsafe',
        apiVersion: 1,
        activate(context: ExtensionContext) {
          context.addLink({ text: 'Metrics', path: '/%2e%2e/%2e%2e/metrics' });
        },
      },
    }],
  ]);

  await assert.rejects(
    () =>
      loadExtensions(
        dependencies({ importModule: (specifier: string) => Promise.resolve(modules.get(specifier)) }),
        '["npm:first", "npm:unsafe"]',
      ),
    /index 1 \(npm:unsafe\).*Extension URL .* escapes extension mount/,
  );
  assert.deepEqual(events, ['dispose-first']);
});

Deno.test('rejects links added after activation has completed', async () => {
  let context: ExtensionContext | undefined;
  await loadExtensions(
    dependencies({
      importModule: () =>
        Promise.resolve({
          default: {
            id: 'late-link',
            apiVersion: 1,
            activate(extensionContext: ExtensionContext) {
              context = extensionContext;
            },
          },
        }),
    }),
    '["npm:late-link"]',
  );
  const activatedContext = context;
  assert.ok(activatedContext);
  assert.throws(() => activatedContext.addLink({ text: 'Late', path: '/late' }), /only add links while activating/);
});

Deno.test('rolls back mounted extensions when mounting a later router fails', async () => {
  const events: string[] = [];
  let mounts = 0;
  const modules = new Map([
    ['npm:a', { default: { id: 'a', apiVersion: 1, activate: () => () => events.push('dispose-a') } }],
    ['npm:b', { default: { id: 'b', apiVersion: 1, activate: () => () => events.push('dispose-b') } }],
  ]);
  await assert.rejects(
    () =>
      loadExtensions(
        dependencies({
          importModule: (specifier: string) => Promise.resolve(modules.get(specifier)),
          mountRouter: () => {
            mounts++;
            if (mounts === 2) throw new Error('mount failed');
          },
        }),
        '["npm:a", "npm:b"]',
      ),
    /mount failed/,
  );
  assert.deepEqual(events, ['dispose-b', 'dispose-a']);
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

Deno.test('rejects invalid activate returns with extension identity and rolls back', async () => {
  const events: string[] = [];
  const modules = new Map([
    ['npm:a', { default: { id: 'a', apiVersion: 1, activate: () => () => events.push('dispose-a') } }],
    ['npm:b', { default: { id: 'b', apiVersion: 1, activate: () => 'invalid' } }],
  ]);

  await assert.rejects(
    () =>
      loadExtensions(
        dependencies({ importModule: (specifier: string) => Promise.resolve(modules.get(specifier)) }),
        '["npm:a", "npm:b"]',
      ),
    /index 1 \(npm:b\).*id "b"/,
  );
  assert.deepEqual(events, ['dispose-a']);
});

Deno.test('annotates module import failures with their configuration entry', async () => {
  await assert.rejects(
    () =>
      loadExtensions(
        dependencies({ importModule: () => Promise.reject(new Error('module unavailable')) }),
        '[{"specifier":"npm:missing", "options":{"secret":"do-not-print"}}]',
      ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /index 0 \(npm:missing\).*module unavailable/);
      assert.doesNotMatch(error.message, /do-not-print/);
      return true;
    },
  );
});

Deno.test('annotates activation failures with their configuration entry', async () => {
  await assert.rejects(
    () =>
      loadExtensions(
        dependencies({
          importModule: () =>
            Promise.resolve({
              default: {
                id: 'broken',
                apiVersion: 1,
                activate: () => {
                  throw new Error('activation exploded');
                },
              },
            }),
        }),
        '[{"specifier":"npm:broken", "options":{"secret":"do-not-print"}}]',
      ),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /index 0 \(npm:broken\).*activation exploded/);
      assert.doesNotMatch(error.message, /do-not-print/);
      return true;
    },
  );
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

Deno.test('shares one in-flight disposal promise and its failure with concurrent callers', async () => {
  const events: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lifecycle = await loadExtensions(
    dependencies({
      importModule: () =>
        Promise.resolve({
          default: {
            id: 'blocked',
            apiVersion: 1,
            activate: () => async () => {
              events.push('start');
              await blocked;
              events.push('finish');
              throw new Error('dispose failed');
            },
          },
        }),
    }),
    '["npm:blocked"]',
  );

  const first = lifecycle.dispose();
  const second = lifecycle.dispose();
  assert.equal(first, second);
  release();
  await assert.rejects(() => first, AggregateError);
  await assert.rejects(() => second, AggregateError);
  assert.equal(lifecycle.dispose(), first);
  assert.deepEqual(events, ['start', 'finish']);
});
