import assert from 'node:assert/strict';
import { PipelineRedisClient, PipelineRunRepository } from './pipeline-run.repository.ts';

class FakeRedis implements PipelineRedisClient {
  readonly hashes = new Map<string, Record<string, string>>();
  readonly sortedSets = new Map<string, string[]>();
  readonly removed: Array<{ key: string; members: string[] }> = [];

  hgetall(key: string): Promise<Record<string, string>> {
    return Promise.resolve(this.hashes.get(key) ?? {});
  }

  zrange(key: string): Promise<string[]> {
    return Promise.resolve(this.sortedSets.get(key) ?? []);
  }

  zrevrange(key: string): Promise<string[]> {
    return Promise.resolve([...(this.sortedSets.get(key) ?? [])].reverse());
  }

  zrem(key: string, ...members: string[]): Promise<number> {
    this.removed.push({ key, members });
    return Promise.resolve(members.length);
  }
}

Deno.test('PipelineRunRepository parses current invocation node snapshots', async () => {
  const redis = new FakeRedis();
  const repository = new PipelineRunRepository(redis, () => 2_000);

  redis.sortedSets.set('pietra:pipeline:runs', ['run-1']);
  redis.hashes.set('pietra:pipeline:run:run-1', {
    id: 'run-1',
    name: 'report generation',
    pipelineName: 'social-analysis-report',
    status: 'RUNNING',
    pendingNodes: '2',
    failedNodes: '1',
    createdAt: '1000',
    updatedAt: '1500',
    completedAt: '',
    expiresAt: '',
    error: 'source failed',
  });
  redis.sortedSets.set('pietra:pipeline:run:run-1:nodes', ['node-1']);
  redis.hashes.set('pietra:pipeline:run:run-1:node:node-1', {
    id: 'node-1',
    runId: 'run-1',
    pipelineName: 'social-analysis-crawl',
    invocationId: 'invocation-1',
    scopeId: 'scope-1',
    name: 'crawl-source',
    stepName: 'crawl-source',
    stage: 'crawl-source',
    status: 'FAILED',
    parentNodeIds: '["parent-1"]',
    queueName: 'pietra-pipeline--social-analysis-crawl--crawl-source',
    jobId: 'job-1',
    attempt: '3',
    maxAttempts: '3',
    progress: '{"pages":4}',
    forkName: 'sources',
    error: 'provider failed',
    createdAt: '1100',
    updatedAt: '1500',
    startedAt: '1200',
    completedAt: '1500',
  });

  assert.deepEqual(await repository.listRuns(), [
    {
      id: 'run-1',
      name: 'report generation',
      pipelineName: 'social-analysis-report',
      status: 'RUNNING',
      error: 'source failed',
      pendingNodes: 2,
      failedNodes: 1,
      createdAt: 1_000,
      updatedAt: 1_500,
      completedAt: null,
      expiresAt: null,
    },
  ]);

  assert.deepEqual(await repository.getRun('run-1'), {
    run: (await repository.listRuns())[0],
    nodes: [
      {
        id: 'node-1',
        runId: 'run-1',
        pipelineName: 'social-analysis-crawl',
        invocationId: 'invocation-1',
        scopeId: 'scope-1',
        name: 'crawl-source',
        stepName: 'crawl-source',
        stage: 'crawl-source',
        status: 'FAILED',
        parentNodeIds: ['parent-1'],
        queueName: 'pietra-pipeline--social-analysis-crawl--crawl-source',
        jobId: 'job-1',
        attempt: 3,
        maxAttempts: 3,
        progress: { pages: 4 },
        forkName: 'sources',
        error: 'provider failed',
        createdAt: 1_100,
        updatedAt: 1_500,
        startedAt: 1_200,
        completedAt: 1_500,
      },
    ],
  });
});

Deno.test('PipelineRunRepository removes missing and expired runs from the index', async () => {
  const redis = new FakeRedis();
  const repository = new PipelineRunRepository(redis, () => 2_000);

  redis.sortedSets.set('pietra:pipeline:runs', ['active', 'expired', 'missing']);
  redis.hashes.set('pietra:pipeline:run:active', {
    id: 'active',
    pipelineName: 'active-pipeline',
    status: 'RUNNING',
    expiresAt: '1',
  });
  redis.hashes.set('pietra:pipeline:run:expired', {
    id: 'expired',
    pipelineName: 'expired-pipeline',
    status: 'COMPLETED',
    expiresAt: '1999',
  });

  assert.deepEqual((await repository.listRuns()).map((run) => run.id), ['active']);
  assert.deepEqual(redis.removed, [
    {
      key: 'pietra:pipeline:runs',
      members: ['missing', 'expired'],
    },
  ]);
});

Deno.test('PipelineRunRepository tolerates malformed optional node fields', async () => {
  const redis = new FakeRedis();
  const repository = new PipelineRunRepository(redis);

  redis.hashes.set('pietra:pipeline:run:run-2', {
    id: 'run-2',
    pipelineName: 'root-pipeline',
  });
  redis.sortedSets.set('pietra:pipeline:run:run-2:nodes', ['missing-node', 'node-2']);
  redis.hashes.set('pietra:pipeline:run:run-2:node:node-2', {
    id: 'node-2',
    parentNodeIds: 'not-json',
    progress: '["not-an-object"]',
    attempt: 'not-a-number',
  });

  const details = await repository.getRun('run-2');
  assert.equal(details?.nodes.length, 1);
  assert.deepEqual(details?.nodes[0].parentNodeIds, []);
  assert.deepEqual(details?.nodes[0].progress, {});
  assert.equal(details?.nodes[0].attempt, 0);
  assert.equal(details?.nodes[0].maxAttempts, 1);
  assert.equal(details?.nodes[0].pipelineName, 'root-pipeline');
  assert.equal(await repository.getRun('missing-run'), null);
});
