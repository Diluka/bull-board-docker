import { BullAdapter } from '@bull-board/api/bullAdapter';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import type { Queue as BullQueue } from 'bull';
import type { Queue } from 'bullmq';

export type QueueAdapter = BullMQAdapter | BullAdapter;

export function createQueueAdapter(
  queue: Queue | BullQueue,
  version: string,
  delimiter: string,
): QueueAdapter {
  return version === 'BULLMQ' ? new BullMQAdapter(queue as Queue, { delimiter }) : new BullAdapter(queue as BullQueue, { delimiter });
}
