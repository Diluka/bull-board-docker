/// <reference lib="dom" />

import { renderQueues } from './queue-view.ts';

interface QueueSnapshot {
  queueCount: number;
  queues: string[];
}

const refreshButton = element<HTMLButtonElement>('refresh-button');
const queueStatus = element<HTMLParagraphElement>('queue-status');
const queueList = element<HTMLUListElement>('queue-list');

async function refreshQueues(): Promise<void> {
  refreshButton.disabled = true;
  queueStatus.textContent = 'Reading the current queue signal.';

  try {
    const response = await fetch('./api/queues');
    if (!response.ok) throw new Error(`Queue API returned ${response.status}`);

    const data: unknown = await response.json();
    if (!isQueueSnapshot(data)) throw new Error('Queue API returned an invalid payload');

    renderQueues(queueList, data.queues);
    queueStatus.textContent = data.queueCount === 0
      ? 'No queue signals are present.'
      : `${data.queueCount} typed queue signal${data.queueCount === 1 ? '' : 's'} received.`;
  } catch (error) {
    queueList.replaceChildren();
    queueStatus.textContent = 'The queue signal could not be read. Try refreshing.';
    console.error('Unable to load queues', error);
  } finally {
    refreshButton.disabled = false;
  }
}

function element<ElementType extends HTMLElement>(id: string): ElementType {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Missing required element #${id}`);
  return value as ElementType;
}

function isQueueSnapshot(value: unknown): value is QueueSnapshot {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<QueueSnapshot>;
  return typeof candidate.queueCount === 'number' &&
    Array.isArray(candidate.queues) &&
    candidate.queues.every((name) => typeof name === 'string');
}

refreshButton.addEventListener('click', refreshQueues);
void refreshQueues();
