export function renderQueues(list: HTMLUListElement, queues: readonly string[]): void {
  const items = queues.map((name, index) => {
    const item = document.createElement('li');
    const sequence = document.createElement('span');
    const label = document.createElement('span');
    item.className = 'queue-item';
    sequence.className = 'queue-sequence';
    sequence.textContent = String(index + 1).padStart(2, '0');
    label.className = 'queue-name';
    label.textContent = name;
    item.append(sequence, label);
    return item;
  });
  list.replaceChildren(...items);
}
