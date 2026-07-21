const refreshButton = document.getElementById('refresh-button');
const queueStatus = document.getElementById('queue-status');
const queueList = document.getElementById('queue-list');

function renderQueues(queues) {
  queueList.replaceChildren();

  for (const name of queues) {
    const item = document.createElement('li');
    item.className = 'queue-item';
    item.textContent = name;
    queueList.append(item);
  }
}

async function refreshQueues() {
  refreshButton.disabled = true;
  queueStatus.textContent = 'Loading current queue register.';

  try {
    const response = await fetch('./api/queues');
    if (!response.ok) {
      throw new Error(`Queue API returned ${response.status}`);
    }

    const data = await response.json();
    const queues = Array.isArray(data.queues) ? data.queues : [];
    renderQueues(queues);
    queueStatus.textContent = queues.length === 0
      ? 'No queues are registered right now.'
      : `${data.queueCount} queue${data.queueCount === 1 ? '' : 's'} in the register.`;
  } catch (error) {
    queueList.replaceChildren();
    queueStatus.textContent = 'Could not load the queue register. Try refreshing.';
    console.error('Unable to load queues', error);
  } finally {
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener('click', refreshQueues);
void refreshQueues();
