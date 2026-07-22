import type { Queue as BullQueue } from 'bull';
import type { Queue } from 'bullmq';
import type { Router } from 'express';
import type { Cluster, Redis } from 'ioredis';

export type RawQueue = BullQueue | Queue;

export interface ExtensionQueues {
  list(): readonly RawQueue[];
  get(name: string): RawQueue | undefined;
}

export interface ExtensionLink {
  text: string;
  path: `/${string}`;
}

export interface ExtensionPageMountOptions {
  /** A trailing-slash file, HTTP, or HTTPS URL containing the page assets. */
  root: URL;
  /** Assets loaded before listening; TypeScript entries are bundled for the browser. */
  preload?: readonly string[];
}

export interface ExtensionPages {
  mount(options: ExtensionPageMountOptions): void;
}

export interface ExtensionContext {
  redis: Redis | Cluster;
  queues: ExtensionQueues;
  router: Router;
  pages: ExtensionPages;
  proxyPath: string;
  url(path: `/${string}`): string;
  addLink(link: ExtensionLink): void;
}

export type ExtensionDisposer = () => void | Promise<void>;

export interface BullBoardExtension {
  readonly id: string;
  readonly apiVersion: 1;
  activate(context: ExtensionContext, options: unknown): void | ExtensionDisposer | Promise<void | ExtensionDisposer>;
}
