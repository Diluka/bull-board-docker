import type { BullBoardExtension } from 'bull-board-docker/extensions';

const extension: BullBoardExtension = {
  id: 'example-ts',
  apiVersion: 1,
  activate(context) {
    context.pages.mount({
      root: new URL('./public/', import.meta.url),
      preload: ['index.html', 'app.ts', 'styles.css'],
    });
    context.addLink({ text: 'TypeScript Example', path: '/' });
    context.router.get('/api/queues', (_request, response) => {
      const queues = context.queues.list();
      response.json({ queueCount: queues.length, queues: queues.map((queue) => queue.name) });
    });
  },
};

export default extension;
