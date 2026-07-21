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
