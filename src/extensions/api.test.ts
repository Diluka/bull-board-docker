import type { ExtensionContext, ExtensionLink, ExtensionQueues, RawQueue } from './api.ts';
import type { ExtensionLoaderDependencies } from './loader.ts';

const rawQueues: readonly RawQueue[] = [];
const queues: ExtensionQueues = {
  list: () => rawQueues,
  get: () => undefined,
};
const link: ExtensionLink = { text: 'Queues', path: '/queues' };

function assertCompileTimeContracts() {
  const context = null as unknown as ExtensionContext;
  // @ts-expect-error Extension paths must be rooted.
  context.url('queues');
  // @ts-expect-error Extension links must be rooted.
  link.path = 'queues';

  // @ts-expect-error Hosts must explicitly mount routers and collect misc links.
  const dependencies: ExtensionLoaderDependencies = {
    redis: null as never,
    queues,
    proxyPath: '/',
  };
  void dependencies;
}

Deno.test('exposes readonly queues and rooted extension paths', () => {
  void queues;
  void link;
});
