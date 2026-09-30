import assert from 'node:assert/strict';
import { Cluster } from 'ioredis';

import { QueueManager } from './queues.ts';

interface FakeQueue {
  name: string;
  close(): Promise<void>;
}

function queueHarness(options: { prefix?: string; version?: string } = {}) {
  let keys: string[] = [];
  const closed: string[] = [];
  const patterns: string[] = [];
  const created: FakeQueue[] = [];
  const manager = new QueueManager<FakeQueue, string>({
    client: {
      scan(_cursor: string, _match: 'MATCH', pattern: string) {
        patterns.push(pattern);
        return Promise.resolve<[string, string[]]>(['0', keys]);
      },
    },
    prefix: options.prefix ?? 'bull',
    version: options.version ?? 'BULLMQ',
    createQueue(name) {
      const queue = {
        name,
        close() {
          closed.push(name);
          return Promise.resolve();
        },
      };
      created.push(queue);
      return queue;
    },
    createAdapter: (queue) => `adapter:${queue.name}`,
  });
  return { manager, closed, created, patterns, setKeys: (next: string[]) => keys = next };
}

Deno.test('refresh discovers sorted queues using the configured prefix and BullMQ suffix', async () => {
  const harness = queueHarness({ prefix: 'tenant:bull' });
  harness.setKeys(['tenant:bull:zeta:meta', 'tenant:bull:alpha:meta', 'tenant:bull:alpha:meta']);

  const adapters = await harness.manager.refresh();

  assert.deepEqual(adapters, ['adapter:alpha', 'adapter:zeta']);
  assert.deepEqual(harness.manager.list().map((queue) => queue.name), ['alpha', 'zeta']);
  assert.deepEqual(harness.patterns, ['tenant:bull:*:meta']);
});

Deno.test('refresh uses the Bull id suffix without losing colons from the prefix', async () => {
  const harness = queueHarness({ prefix: 'tenant:bull', version: 'BULL' });
  harness.setKeys(['tenant:bull:second:id', 'tenant:bull:first:id']);

  await harness.manager.refresh();

  assert.deepEqual(harness.manager.list().map((queue) => queue.name), ['first', 'second']);
  assert.deepEqual(harness.patterns, ['tenant:bull:*:id']);
});

Deno.test('Cluster keeps the existing KEYS discovery path and preserves its snapshot on failure', async () => {
  const client = new Cluster([], { lazyConnect: true });
  let keys: string[] | Error = ['bull:zeta:meta', 'bull:alpha:meta', 'bull:alpha:meta'];
  client.keys = (pattern) => {
    assert.equal(pattern, 'bull:*:meta');
    return keys instanceof Error ? Promise.reject(keys) : Promise.resolve(keys);
  };
  client.scan = () => Promise.reject(new Error('Cluster discovery must keep using KEYS'));
  const closed: string[] = [];
  const manager = new QueueManager<FakeQueue, string>({
    client,
    prefix: 'bull',
    version: 'BULLMQ',
    createQueue: (name) => ({ name, close: () => Promise.resolve().then(() => closed.push(name)).then(() => {}) }),
    createAdapter: (queue) => `adapter:${queue.name}`,
  });
  try {
    assert.deepEqual(await manager.refresh(), ['adapter:alpha', 'adapter:zeta']);
    const snapshot = manager.list();
    keys = new Error('keys failed');
    await assert.rejects(() => manager.refresh(), /keys failed/);
    assert.deepEqual(manager.list(), snapshot);
    assert.deepEqual(closed, []);
  } finally {
    await manager.close();
    client.disconnect();
  }
});

function scanClient(pages: Record<string, [string, string[]] | Error>, pattern = 'bull:*:meta') {
  const cursors: string[] = [];
  return {
    cursors,
    scan(cursor: string, match: 'MATCH', actualPattern: string, count: 'COUNT', size: number): Promise<[string, string[]]> {
      assert.deepEqual([match, actualPattern, count, size], ['MATCH', pattern, 'COUNT', 500]);
      cursors.push(cursor);
      const page = pages[cursor];
      assert.ok(page, `unexpected cursor ${cursor}`);
      return page instanceof Error ? Promise.reject(page) : Promise.resolve(page);
    },
  };
}

Deno.test('refresh scans all pages through empty results and deduplicates before creating sorted queues', async () => {
  for (const version of ['BULLMQ', 'BULL']) {
    const suffix = version === 'BULLMQ' ? 'meta' : 'id';
    const client = scanClient({
      '0': ['42', [`tenant:bull:zeta:${suffix}`]],
      '42': ['9007199254740993', []],
      '9007199254740993': ['0', [
        `tenant:bull:alpha:${suffix}`,
        `tenant:bull:zeta:${suffix}`,
        `other:bull:wrong:${suffix}`,
        'tenant:bull:wrong:jobs',
      ]],
    }, `tenant:bull:*:${suffix}`);
    const created: string[] = [];
    const manager = new QueueManager<FakeQueue, string>({
      client,
      prefix: 'tenant:bull',
      version,
      createQueue(name) {
        created.push(name);
        return { name, close: () => Promise.resolve() };
      },
      createAdapter: (queue) => `adapter:${queue.name}`,
    });

    assert.deepEqual(await manager.refresh(), ['adapter:alpha', 'adapter:zeta']);
    assert.deepEqual(created, ['alpha', 'zeta']);
    assert.deepEqual(client.cursors, ['0', '42', '9007199254740993']);
    await manager.close();
  }
});

Deno.test('a failed scan page preserves existing queues and retries from cursor zero', async () => {
  const pages: Record<string, [string, string[]] | Error> = { '0': ['0', ['bull:old:meta']] };
  const client = scanClient(pages);
  const created: string[] = [];
  const closed: string[] = [];
  const manager = new QueueManager<FakeQueue, string>({
    client,
    prefix: 'bull',
    version: 'BULLMQ',
    createQueue(name) {
      created.push(name);
      return { name, close: () => Promise.resolve().then(() => closed.push(name)).then(() => {}) };
    },
    createAdapter: (queue) => `adapter:${queue.name}`,
  });
  await manager.refresh();
  const old = manager.get('old');
  pages['0'] = ['8', ['bull:new:meta']];
  pages['8'] = new Error('scan failed');

  await assert.rejects(() => manager.refresh(), /scan failed/);
  assert.deepEqual(manager.list(), [old]);
  assert.deepEqual(created, ['old']);
  assert.deepEqual(closed, []);

  pages['8'] = ['0', ['bull:old:meta']];
  assert.deepEqual(await manager.refresh(), ['adapter:new', 'adapter:old']);
  assert.equal(manager.get('old'), old);
  assert.deepEqual(client.cursors, ['0', '0', '8', '0', '8']);
  await manager.close();
});

Deno.test('close and concurrent refresh wait for the final scan page before replacing and releasing queues', async () => {
  let release!: (page: [string, string[]]) => void;
  const blockedPage = new Promise<[string, string[]]>((resolve) => release = resolve);
  let scanning = false;
  const cursors: string[] = [];
  const closed: string[] = [];
  const manager = new QueueManager<FakeQueue, string>({
    client: {
      scan(cursor) {
        cursors.push(cursor);
        if (!scanning) return Promise.resolve<[string, string[]]>(['0', ['bull:old:meta']]);
        return cursor === '0' ? Promise.resolve<[string, string[]]>(['4', ['bull:new:meta']]) : blockedPage;
      },
    },
    prefix: 'bull',
    version: 'BULLMQ',
    createQueue: (name) => ({ name, close: () => Promise.resolve().then(() => closed.push(name)).then(() => {}) }),
    createAdapter: (queue) => `adapter:${queue.name}`,
  });
  await manager.refresh();
  const old = manager.get('old');
  scanning = true;
  const refresh = manager.refresh();
  await Promise.resolve();
  assert.equal(manager.refresh(), refresh);
  const closing = manager.close();
  let finishedClosing = false;
  void closing.then(() => finishedClosing = true);
  await Promise.resolve();
  assert.deepEqual(manager.list(), [old]);
  assert.deepEqual(closed, []);
  assert.equal(finishedClosing, false);
  await assert.rejects(() => manager.refresh(), /QueueManager is closed/);

  release(['0', ['bull:last:meta']]);
  assert.deepEqual(await refresh, ['adapter:last', 'adapter:new']);
  await closing;
  assert.deepEqual(cursors, ['0', '0', '4']);
  assert.deepEqual(closed, ['old', 'last', 'new']);
  assert.deepEqual(manager.list(), []);
});

Deno.test('refresh adds and removes queues while list and get stay live', async () => {
  const harness = queueHarness();
  harness.setKeys(['bull:one:meta', 'bull:two:meta']);
  await harness.manager.refresh();
  const firstSnapshot = harness.manager.list();
  const one = harness.manager.get('one');

  harness.setKeys(['bull:two:meta', 'bull:three:meta']);
  const adapters = await harness.manager.refresh();

  assert.equal(firstSnapshot.length, 2);
  assert.equal(firstSnapshot[0], one);
  assert.equal(harness.manager.get('one'), undefined);
  assert.equal(harness.manager.get('two'), firstSnapshot[1]);
  assert.equal(harness.manager.get('three'), harness.created[2]);
  assert.deepEqual(harness.manager.list().map((queue) => queue.name), ['three', 'two']);
  assert.deepEqual(adapters, ['adapter:three', 'adapter:two']);
  assert.deepEqual(harness.closed, ['one']);
});

Deno.test('concurrent refresh callers share one scan and one adapter result', async () => {
  let scans = 0;
  let release!: (page: [string, string[]]) => void;
  const blockedPage = new Promise<[string, string[]]>((resolve) => release = resolve);
  const manager = new QueueManager<FakeQueue, string>({
    client: {
      scan() {
        scans++;
        return blockedPage;
      },
    },
    prefix: 'bull',
    version: 'BULLMQ',
    createQueue: (name) => ({ name, close: () => Promise.resolve() }),
    createAdapter: (queue) => `adapter:${queue.name}`,
  });

  const first = manager.refresh();
  const second = manager.refresh();
  assert.equal(first, second);
  assert.equal(scans, 1);
  release(['0', ['bull:one:meta']]);

  assert.equal(await first, await second);
  assert.deepEqual(await first, ['adapter:one']);
});

Deno.test('close waits for every queue, continues after failures, and is idempotent', async () => {
  const events: string[] = [];
  const manager = new QueueManager<FakeQueue, string>({
    client: { scan: () => Promise.resolve<[string, string[]]>(['0', ['bull:a:meta', 'bull:b:meta']]) },
    prefix: 'bull',
    version: 'BULLMQ',
    createQueue: (name) => ({
      name,
      close() {
        events.push(name);
        return name === 'a' ? Promise.reject(new Error('a failed')) : Promise.resolve();
      },
    }),
    createAdapter: (queue) => `adapter:${queue.name}`,
  });
  await manager.refresh();

  const first = manager.close();
  const second = manager.close();

  assert.equal(first, second);
  await assert.rejects(() => first, AggregateError);
  assert.deepEqual(events, ['a', 'b']);
  assert.deepEqual(manager.list(), []);
});

Deno.test('refresh publishes a complete replacement while failed removed queues stay pending for retry', async () => {
  let keys = ['bull:a:meta', 'bull:b:meta'];
  const closeAttempts = new Map<string, number>();
  const closeErrors: [string, unknown][] = [];
  const options = {
    client: { scan: () => Promise.resolve<[string, string[]]>(['0', keys]) },
    prefix: 'bull',
    version: 'BULLMQ',
    createQueue: (name: string): FakeQueue => ({
      name,
      close() {
        const attempt = (closeAttempts.get(name) ?? 0) + 1;
        closeAttempts.set(name, attempt);
        return name === 'b' && attempt === 1 ? Promise.reject(new Error('b close failed')) : Promise.resolve();
      },
    }),
    createAdapter: (queue: FakeQueue) => `adapter:${queue.name}`,
    onQueueCloseError: (name: string, error: unknown) => closeErrors.push([name, error]),
  };
  const manager = new QueueManager<FakeQueue, string>(options);
  await manager.refresh();

  keys = ['bull:c:meta'];
  const adapters = await manager.refresh();

  assert.deepEqual(adapters, ['adapter:c']);
  assert.deepEqual(manager.list().map((queue) => queue.name), ['c']);
  assert.deepEqual(closeErrors.map(([name, error]) => [name, String(error)]), [['b', 'Error: b close failed']]);
  assert.equal(closeAttempts.get('a'), 1);
  assert.equal(closeAttempts.get('b'), 1);

  await manager.refresh();
  assert.equal(closeAttempts.get('b'), 2);
});

Deno.test('create failure preserves the published snapshot and closes every queue created for the failed refresh', async () => {
  let keys = ['bull:a:meta'];
  const closed: string[] = [];
  const manager = new QueueManager<FakeQueue, string>({
    client: { scan: () => Promise.resolve<[string, string[]]>(['0', keys]) },
    prefix: 'bull',
    version: 'BULLMQ',
    createQueue(name) {
      if (name === 'c') throw new Error('create c failed');
      return { name, close: () => Promise.resolve().then(() => closed.push(name)).then(() => {}) };
    },
    createAdapter: (queue) => `adapter:${queue.name}`,
  });
  await manager.refresh();
  const publishedA = manager.get('a');

  keys = ['bull:a:meta', 'bull:b:meta', 'bull:c:meta'];
  await assert.rejects(() => manager.refresh(), /create c failed/);

  assert.deepEqual(manager.list().map((queue) => queue.name), ['a']);
  assert.equal(manager.get('a'), publishedA);
  assert.equal(manager.get('b'), undefined);
  assert.deepEqual(closed, ['b']);
});

Deno.test('adapter failure preserves the snapshot and aggregates cleanup failures for new queues', async () => {
  let keys = ['bull:a:meta'];
  let failAdapter = false;
  let bCloseAttempts = 0;
  const manager = new QueueManager<FakeQueue, string>({
    client: { scan: () => Promise.resolve<[string, string[]]>(['0', keys]) },
    prefix: 'bull',
    version: 'BULLMQ',
    createQueue: (name) => ({
      name,
      close() {
        if (name === 'b') {
          bCloseAttempts++;
          return Promise.reject(new Error('cleanup b failed'));
        }
        return Promise.resolve();
      },
    }),
    createAdapter(queue) {
      if (failAdapter && queue.name === 'b') throw new Error('adapter b failed');
      return `adapter:${queue.name}`;
    },
  });
  await manager.refresh();
  const publishedA = manager.get('a');

  keys = ['bull:a:meta', 'bull:b:meta'];
  failAdapter = true;
  await assert.rejects(
    () => manager.refresh(),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors.map(String), ['Error: adapter b failed', 'Error: cleanup b failed']);
      return true;
    },
  );

  assert.deepEqual(manager.list().map((queue) => queue.name), ['a']);
  assert.equal(manager.get('a'), publishedA);
  assert.equal(manager.get('b'), undefined);
  assert.equal(bCloseAttempts, 1);
  await assert.rejects(() => manager.close(), AggregateError);
  assert.equal(bCloseAttempts, 2);
});
