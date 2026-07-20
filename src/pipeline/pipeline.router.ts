import path from 'node:path';
import express from 'express';
import type { PipelineRunReader } from './pipeline.types.ts';

export interface PipelineRouterOptions {
  proxyPath: string;
  repository: PipelineRunReader;
}

export function createPipelineRouter(options: PipelineRouterOptions): express.Router {
  const router = express.Router();
  const assetsPath = path.join(import.meta.dirname!, '..', 'public');

  router.use('/pipeline-assets', express.static(assetsPath));

  router.get('/api/pipelines', async (_request, response) => {
    response.json({ runs: await options.repository.listRuns() });
  });

  router.get('/api/pipelines/:runId', async (request, response) => {
    const details = await options.repository.getRun(request.params.runId);
    if (!details) {
      response.status(404).json({
        error: `Pipeline run ${request.params.runId} not found`,
      });
      return;
    }
    response.json(details);
  });

  router.get('/pipelines', (_request, response) => {
    response.render('pipeline-dashboard', {
      proxyPath: options.proxyPath,
      page: 'runs',
      runId: '',
    });
  });

  router.get('/pipelines/:runId', (request, response) => {
    response.render('pipeline-dashboard', {
      proxyPath: options.proxyPath,
      page: 'run',
      runId: request.params.runId,
    });
  });

  return router;
}
