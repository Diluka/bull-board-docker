export interface PipelineRunSummary {
  id: string;
  name: string;
  pipelineName: string;
  status: string;
  error: string;
  pendingNodes: number;
  failedNodes: number;
  createdAt: number | null;
  updatedAt: number | null;
  completedAt: number | null;
  expiresAt: number | null;
}

export interface PipelineNodeSnapshot {
  id: string;
  runId: string;
  pipelineName: string;
  invocationId: string;
  scopeId: string;
  name: string;
  stepName: string;
  stage: string;
  status: string;
  parentNodeIds: string[];
  queueName: string;
  jobId: string;
  attempt: number;
  maxAttempts: number;
  progress: Record<string, unknown>;
  forkName: string;
  error: string;
  createdAt: number | null;
  updatedAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
}

export interface PipelineRunDetails {
  run: PipelineRunSummary;
  nodes: PipelineNodeSnapshot[];
}

export interface PipelineRunReader {
  listRuns(limit?: number): Promise<PipelineRunSummary[]>;
  getRun(runId: string): Promise<PipelineRunDetails | null>;
}
