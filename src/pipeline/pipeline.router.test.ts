import assert from 'node:assert/strict';
import path from 'node:path';
import express from 'express';
import type { PipelineRunDetails, PipelineRunSummary } from './pipeline.types.ts';
import { createPipelineRouter } from './pipeline.router.ts';

const run: PipelineRunSummary = {
  id: 'run/with spaces',
  name: 'report generation',
  pipelineName: 'social-analysis-report',
  status: 'RUNNING',
  error: '',
  pendingNodes: 1,
  failedNodes: 0,
  createdAt: 1,
  updatedAt: 2,
  completedAt: null,
  expiresAt: null,
};

const details: PipelineRunDetails = { run, nodes: [] };

Deno.test('pipeline router exposes list, details, 404, page and static assets', async () => {
  const app = express();
  app.set('views', path.join(import.meta.dirname!, '..', 'views'));
  app.set('view engine', 'ejs');
  app.use(
    createPipelineRouter({
      proxyPath: '/app/bull-board',
      repository: {
        listRuns: () => Promise.resolve([run]),
        getRun: (runId: string) => Promise.resolve(runId === run.id ? details : null),
      },
    }),
  );

  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });

  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;

    const listResponse = await fetch(`${origin}/api/pipelines`);
    assert.equal(listResponse.status, 200);
    assert.deepEqual(await listResponse.json(), { runs: [run] });

    const detailsResponse = await fetch(
      `${origin}/api/pipelines/${encodeURIComponent(run.id)}`,
    );
    assert.equal(detailsResponse.status, 200);
    assert.deepEqual(await detailsResponse.json(), details);

    const missingResponse = await fetch(`${origin}/api/pipelines/missing`);
    assert.equal(missingResponse.status, 404);
    await missingResponse.body?.cancel();

    const pageResponse = await fetch(`${origin}/pipelines`);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, /data-page="runs"/);
    assert.match(page, /\/app\/bull-board\/pipeline-assets\/pipeline-dashboard\.css/);

    const detailsPageResponse = await fetch(
      `${origin}/pipelines/${encodeURIComponent(run.id)}`,
    );
    const detailsPage = await detailsPageResponse.text();
    assert.match(detailsPage, /data-page="run"/);
    assert.match(detailsPage, /data-run-id="run\/with spaces"/);

    const assetResponse = await fetch(
      `${origin}/pipeline-assets/pipeline-dashboard.js`,
    );
    assert.equal(assetResponse.status, 200);
    assert.match(await assetResponse.text(), /loadPipelineDashboard/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
