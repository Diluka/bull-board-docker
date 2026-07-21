import type { BullBoardExtension } from 'bull-board-docker/extensions';

const extension: BullBoardExtension = {
  id: 'invalid-typescript',
  apiVersion: 1,
  activate(context) {
    context.pages.mount({
      root: new URL('./public/', import.meta.url),
      preload: ['app.ts'],
    });
  },
};

export default extension;
