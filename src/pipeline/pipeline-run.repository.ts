import type { PipelineNodeSnapshot, PipelineRunDetails, PipelineRunReader, PipelineRunSummary } from './pipeline.types.ts';

const PIPELINE_RUNS_KEY = 'pietra:pipeline:runs';

export interface PipelineRedisClient {
  hgetall(key: string): Promise<Record<string, string>>;
  zrange(key: string, start: number, end: number): Promise<string[]>;
  zrevrange(key: string, start: number, end: number): Promise<string[]>;
  zrem(key: string, ...members: string[]): Promise<number>;
}

export class PipelineRunRepository implements PipelineRunReader {
  constructor(
    private readonly redis: PipelineRedisClient,
    private readonly now: () => number = Date.now,
  ) {}

  async listRuns(limit = 100): Promise<PipelineRunSummary[]> {
    const runIds = await this.redis.zrevrange(PIPELINE_RUNS_KEY, 0, -1);
    const runs = await Promise.all(
      runIds.map(async (runId) => this.parseRun(await this.redis.hgetall(this.runKey(runId)))),
    );
    const staleRunIds = runIds.filter((_runId, index) => this.isStale(runs[index]));

    if (staleRunIds.length > 0) {
      await this.redis.zrem(PIPELINE_RUNS_KEY, ...staleRunIds);
    }

    const staleRunIdSet = new Set(staleRunIds);
    return runs
      .flatMap((run, index) => run && !staleRunIdSet.has(runIds[index]) ? [run] : [])
      .slice(0, Math.max(0, limit));
  }

  async getRun(runId: string): Promise<PipelineRunDetails | null> {
    const run = this.parseRun(await this.redis.hgetall(this.runKey(runId)));
    if (!run) return null;

    const nodeIds = await this.redis.zrange(this.nodesKey(runId), 0, -1);
    const nodes = await Promise.all(
      nodeIds.map(async (nodeId) =>
        this.parseNode(
          await this.redis.hgetall(this.nodeKey(runId, nodeId)),
          run.pipelineName,
        )
      ),
    );

    return {
      run,
      nodes: nodes.filter((node): node is PipelineNodeSnapshot => node !== null),
    };
  }

  private isStale(run: PipelineRunSummary | null): boolean {
    if (!run) return true;
    const finished = run.status === 'COMPLETED' || run.status === 'FAILED';
    return finished && run.expiresAt !== null && run.expiresAt <= this.now();
  }

  private parseRun(data: Record<string, string>): PipelineRunSummary | null {
    if (!data.id) return null;

    return {
      id: data.id,
      name: data.name || data.pipelineName || data.id,
      pipelineName: data.pipelineName || data.name || data.id,
      status: data.status || 'PENDING',
      error: data.error || '',
      pendingNodes: this.number(data.pendingNodes) ?? 0,
      failedNodes: this.number(data.failedNodes) ?? 0,
      createdAt: this.number(data.createdAt),
      updatedAt: this.number(data.updatedAt),
      completedAt: this.number(data.completedAt),
      expiresAt: this.number(data.expiresAt),
    };
  }

  private parseNode(
    data: Record<string, string>,
    fallbackPipelineName: string,
  ): PipelineNodeSnapshot | null {
    if (!data.id) return null;
    const stepName = data.stepName || data.stage || data.name || data.id;

    return {
      id: data.id,
      runId: data.runId || '',
      pipelineName: data.pipelineName || fallbackPipelineName,
      invocationId: data.invocationId || '',
      scopeId: data.scopeId || '',
      name: data.name || stepName,
      stepName,
      stage: data.stage || stepName,
      status: data.status || 'PENDING',
      parentNodeIds: this.stringArray(data.parentNodeIds),
      queueName: data.queueName || '',
      jobId: data.jobId || '',
      attempt: this.number(data.attempt) ?? 0,
      maxAttempts: this.number(data.maxAttempts) ?? 1,
      progress: this.jsonObject(data.progress),
      forkName: data.forkName || '',
      error: data.error || '',
      createdAt: this.number(data.createdAt),
      updatedAt: this.number(data.updatedAt),
      startedAt: this.number(data.startedAt),
      completedAt: this.number(data.completedAt),
    };
  }

  private number(value: string | undefined): number | null {
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private stringArray(value: string | undefined): string[] {
    if (!value) return [];
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }

  private jsonObject(value: string | undefined): Record<string, unknown> {
    if (!value) return {};
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }

  private runKey(runId: string): string {
    return `pietra:pipeline:run:${runId}`;
  }

  private nodesKey(runId: string): string {
    return `${this.runKey(runId)}:nodes`;
  }

  private nodeKey(runId: string, nodeId: string): string {
    return `${this.runKey(runId)}:node:${nodeId}`;
  }
}
