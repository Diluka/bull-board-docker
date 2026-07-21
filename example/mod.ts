import type { BullBoardExtension } from '../src/extensions/api.ts';

const extension: BullBoardExtension = {
  id: 'example',
  apiVersion: 1,
  activate(context) {
    context.addLink({ text: 'Example', path: '/' });
    context.router.get('/', (_request, response) => {
      const queues = context.queues.list();
      const names = queues.map((queue) => `<li>${escapeHtml(queue.name)}</li>`).join('');
      response.type('html').send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Example extension</title></head>
  <body>
    <h1>Example extension</h1>
    <p>Queue count: ${queues.length}</p>
    <ul>${names}</ul>
  </body>
</html>`);
    });
  },
};

export default extension;

function escapeHtml(value: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}
