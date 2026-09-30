import assert from 'node:assert/strict';
import LegacyQueue, { type Queue as BullQueue } from 'bull';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { QueueManager } from '../src/queues.ts';

const client = new Redis({
  host: Deno.env.get('TEST_REDIS_HOST') ?? 'redis',
  port: Number(Deno.env.get('TEST_REDIS_PORT') ?? 6379),
});

try {
  for (const version of ['BULLMQ', 'BULL']) {
    const prefix = `discovery:${version.toLowerCase()}`;
    const suffix = version === 'BULLMQ' ? 'meta' : 'id';
    const names = Array.from({ length: 60 }, (_, index) => `queue-${index}`).sort();
    const keys = names.map((name) => `${prefix}:${name}:${suffix}`);
    const manager = new QueueManager<Queue | BullQueue, string>({
      client,
      prefix,
      version,
      createQueue: (name) =>
        version === 'BULLMQ'
          ? new Queue(name, { connection: client, prefix })
          : new LegacyQueue(name, { prefix, createClient: () => client }),
      createAdapter: (queue) => queue.name,
    });
    try {
      assert.deepEqual(await manager.refresh(), []);
      for (const key of keys) {
        if (version === 'BULLMQ') await client.hset(key, 'opts.maxLenEvents', '10000');
        else await client.set(key, '0');
      }

      assert.deepEqual(await manager.refresh(), names);
      await Promise.all(
        manager.list().map(async (queue) => {
          if (queue instanceof Queue) {
            await queue.waitUntilReady();
            assert.ok(await queue.getVersion());
          } else {
            await queue.isReady();
          }
        }),
      );
      const retained = manager.get(names[0]);
      await client.del(keys[1]);
      assert.deepEqual(await manager.refresh(), names.filter((name) => name !== names[1]));
      assert.equal(manager.get(names[0]), retained);
      assert.equal(manager.get(names[1]), undefined);
      console.log(`Redis ${version}: discovered, reused and removed queues`);
    } finally {
      await manager.close();
      for (const key of keys) await client.del(key);
    }
  }
} finally {
  await client.quit();
}
