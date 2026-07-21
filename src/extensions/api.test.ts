import type { BullBoardExtension, ExtensionContext, ExtensionLink, ExtensionQueues, RawQueue } from './api.ts';
import type { ExtensionLoaderDependencies } from './loader.ts';

const rawQueues: readonly RawQueue[] = [];
const queues: ExtensionQueues = {
  list: () => rawQueues,
  get: () => undefined,
};
const link: ExtensionLink = { text: 'Queues', path: '/queues' };
type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2 ? true : false;
const optionsAreUnknown: Equal<Parameters<BullBoardExtension['activate']>[1], unknown> = true;

function assertCompileTimeContracts() {
  const context = null as unknown as ExtensionContext;
  // @ts-expect-error Extension paths must be rooted.
  context.url('queues');
  // @ts-expect-error Extension links must be rooted.
  link.path = 'queues';

  const extension = null as unknown as BullBoardExtension;
  // @ts-expect-error Validated extension identity is readonly.
  extension.id = 'changed';
  // @ts-expect-error The fixed API version is readonly.
  extension.apiVersion = 1;

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
  void optionsAreUnknown;
});
