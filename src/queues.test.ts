import assert from 'node:assert/strict';

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
      keys(pattern: string) {
        patterns.push(pattern);
        return Promise.resolve(keys);
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
  let release!: (keys: string[]) => void;
  const blockedKeys = new Promise<string[]>((resolve) => release = resolve);
  const manager = new QueueManager<FakeQueue, string>({
    client: {
      keys() {
        scans++;
        return blockedKeys;
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
  release(['bull:one:meta']);

  assert.equal(await first, await second);
  assert.deepEqual(await first, ['adapter:one']);
});

Deno.test('close waits for every queue, continues after failures, and is idempotent', async () => {
  const events: string[] = [];
  const manager = new QueueManager<FakeQueue, string>({
    client: { keys: () => Promise.resolve(['bull:a:meta', 'bull:b:meta']) },
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
    client: { keys: () => Promise.resolve(keys) },
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
    client: { keys: () => Promise.resolve(keys) },
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
    client: { keys: () => Promise.resolve(keys) },
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
