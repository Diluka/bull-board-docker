import assert from 'node:assert/strict';
import type { Queue } from 'bullmq';

import { createQueueAdapter } from './queue-adapter.ts';

Deno.test('BullMQ adapter exposes the configured queue group delimiter', () => {
  const queue = {
    name: 'pipeline--social-analysis-crawl--crawl-source',
    metaValues: { version: 'bullmq:5' },
  } as unknown as Queue;

  const adapter = createQueueAdapter(queue, 'BULLMQ', '--');

  assert.equal(adapter.delimiter, '--');
  assert.equal(adapter.getName(), queue.name);
});

Deno.test('BullMQ adapter keeps queue grouping disabled by default', () => {
  const queue = {
    name: 'ordinary-queue',
    metaValues: { version: 'bullmq:5' },
  } as unknown as Queue;

  const adapter = createQueueAdapter(queue, 'BULLMQ', '');

  assert.equal(adapter.delimiter, '');
});
