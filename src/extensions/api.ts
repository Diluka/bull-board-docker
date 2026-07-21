import type { Queue as BullQueue } from 'bull';
import type { Queue } from 'bullmq';
import type { Router } from 'express';
import type { Cluster, Redis } from 'ioredis';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type RawQueue = BullQueue | Queue;

export interface ExtensionQueues {
  list(): readonly RawQueue[];
  get(name: string): RawQueue | undefined;
}

export interface ExtensionLink {
  text: string;
  path: `/${string}`;
}

export interface ExtensionContext {
  redis: Redis | Cluster;
  queues: ExtensionQueues;
  router: Router;
  proxyPath: string;
  url(path: `/${string}`): string;
  addLink(link: ExtensionLink): void;
}

export type ExtensionDisposer = () => void | Promise<void>;

export interface BullBoardExtension {
  id: string;
  apiVersion: 1;
  activate(context: ExtensionContext, options: JsonValue | undefined): void | ExtensionDisposer | Promise<void | ExtensionDisposer>;
}
