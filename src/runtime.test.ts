import assert from 'node:assert/strict';

import { createRefreshScheduler, createShutdown } from './runtime.ts';

Deno.test('refresh scheduler shares an in-flight refresh and replaces the complete queue set once', async () => {
  let scans = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  const replacements: readonly string[][] = [];
  const scheduler = createRefreshScheduler<string>({
    async refresh() {
      scans++;
      await blocked;
      return ['one', 'two'];
    },
    replaceQueues: (queues) => (replacements as string[][]).push([...queues]),
    onError: () => assert.fail('refresh should not fail'),
  });

  const first = scheduler.refreshNow();
  const second = scheduler.refreshNow();
  assert.equal(first, second);
  assert.equal(scans, 1);
  release();
  await first;

  assert.deepEqual(replacements, [['one', 'two']]);
});

Deno.test('scheduled refresh failures are reported without unhandled rejection and later ticks recover', async () => {
  let tick: (() => void) | undefined;
  let attempts = 0;
  const errors: unknown[] = [];
  const replacements: readonly string[][] = [];
  const scheduler = createRefreshScheduler<string>({
    refresh: () => attempts++ === 0 ? Promise.reject(new Error('scan failed')) : Promise.resolve(['recovered']),
    replaceQueues: (queues) => (replacements as string[][]).push([...queues]),
    onError: (error) => errors.push(error),
    setInterval: (callback) => {
      tick = callback;
      return 1;
    },
    clearInterval: () => {},
  });

  scheduler.start();
  tick!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  tick!();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /scan failed/);
  assert.deepEqual(replacements, [['recovered']]);
});

Deno.test('stopping refresh clears scheduling and waits for an in-flight refresh', async () => {
  const events: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  const scheduler = createRefreshScheduler<string>({
    async refresh() {
      events.push('refresh:start');
      await blocked;
      events.push('refresh:end');
      return [];
    },
    replaceQueues: () => {},
    onError: () => {},
    setInterval: () => 1,
    clearInterval: () => events.push('interval:clear'),
  });
  scheduler.start();
  void scheduler.refreshNow();

  const stopped = scheduler.stop();
  await Promise.resolve();
  assert.deepEqual(events, ['refresh:start', 'interval:clear']);
  release();
  await stopped;
  assert.deepEqual(events, ['refresh:start', 'interval:clear', 'refresh:end']);
});

Deno.test('shutdown is shared, ordered, and continues after disposer and queue failures', async () => {
  const events: string[] = [];
  const errors: [string, unknown][] = [];
  const shutdown = createShutdown({
    stopRefresh: () => {
      events.push('refresh');
      return Promise.resolve();
    },
    closeServer: () => {
      events.push('server');
      return Promise.resolve();
    },
    disposeExtensions: () => {
      events.push('extensions');
      return Promise.reject(new Error('dispose failed'));
    },
    closeQueues: () => {
      events.push('queues');
      return Promise.reject(new Error('queue failed'));
    },
    disconnectRedis: () => {
      events.push('redis');
      return Promise.resolve();
    },
    onError: (stage, error) => errors.push([stage, error]),
  });

  const first = shutdown();
  const second = shutdown();
  assert.equal(first, second);
  await first;

  assert.deepEqual(events, ['refresh', 'server', 'extensions', 'queues', 'redis']);
  assert.deepEqual(errors.map(([stage]) => stage), ['extensions', 'queues']);
});
