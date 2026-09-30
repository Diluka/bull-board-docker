import assert from 'node:assert/strict';
import LegacyQueue, { type Queue as BullQueue } from 'bull';
import { Queue } from 'bullmq';
import { Cluster, Redis } from 'ioredis';

import { QueueManager } from '../src/queues.ts';

const standalone = new Redis({
  host: Deno.env.get('TEST_REDIS_HOST') ?? 'redis',
  port: Number(Deno.env.get('TEST_REDIS_PORT') ?? 6379),
});
const cluster = new Cluster([{
  host: Deno.env.get('TEST_REDIS_CLUSTER_HOST') ?? 'redis-cluster',
  port: Number(Deno.env.get('TEST_REDIS_CLUSTER_PORT') ?? 7000),
}], { lazyConnect: true });

try {
  for (const client of [standalone, cluster]) {
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
        if (client instanceof Cluster) {
          const masters = client.nodes('master');
          assert.equal(masters.length, 3);
          for (const master of masters) {
            let cursor = '0';
            let found = 0;
            do {
              const [nextCursor, page] = await master.scan(cursor, 'MATCH', `${prefix}:*:${suffix}`, 'COUNT', 500);
              found += page.length;
              cursor = nextCursor;
            } while (cursor !== '0');
            assert.ok(found > 0, 'the fixture must seed queues on every cluster master');
          }
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
        console.log(`${client instanceof Cluster ? 'Cluster' : 'Redis'} ${version}: discovered, reused and removed queues`);
      } finally {
        await manager.close();
        for (const key of keys) await client.del(key);
      }
    }
  }
} finally {
  await Promise.all([standalone.quit(), cluster.quit()]);
}
