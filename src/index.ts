import { BullAdapter } from '@bull-board/api/bullAdapter';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import LegacyQueue, { Queue as BullQueue } from 'bull';
import { Queue } from 'bullmq';
import type { Express } from 'express';
import { Cluster, Redis, RedisOptions } from 'ioredis';
import process from 'node:process';

import { createApplication } from './app.ts';
import config from './config.ts';
import { QueueManager } from './queues.ts';
import { assembleThenListen, closeHttpServer, createRefreshScheduler, createShutdown } from './runtime.ts';

const redisConfig = {
  port: config.REDIS_PORT,
  host: config.REDIS_HOST,
  db: config.REDIS_DB,
  password: config.REDIS_PASSWORD,
  ...(config.REDIS_USE_TLS === 'true' && { tls: {} }),
} satisfies RedisOptions;

function createRedisClient(): Redis | Cluster {
  return config.REDIS_IS_CLUSTER === 'true'
    ? new Cluster(
      [{ port: config.REDIS_PORT, host: config.REDIS_HOST }],
      {
        redisOptions: {
          password: config.REDIS_PASSWORD,
          tls: config.REDIS_USE_TLS === 'true' ? {} : undefined,
        },
      },
    )
    : new Redis(redisConfig);
}

const client = createRedisClient();
const isBullMQ = config.BULL_VERSION === 'BULLMQ';
const queueManager = new QueueManager<Queue | BullQueue, BullMQAdapter | BullAdapter>({
  client,
  prefix: config.BULL_PREFIX,
  version: config.BULL_VERSION,
  createQueue: (name) =>
    isBullMQ ? new Queue(name, { connection: client, prefix: config.BULL_PREFIX }) : new LegacyQueue(name, {
      createClient() {
        return client;
      },
      prefix: config.BULL_PREFIX,
    }),
  createAdapter: (queue) => isBullMQ ? new BullMQAdapter(queue as Queue) : new BullAdapter(queue as BullQueue),
  onQueueCloseError: (queueName, error) => console.error(`failed to close queue "${queueName}":`, error),
});

let extensionLifecycle: Awaited<ReturnType<typeof createApplication>>['extensionLifecycle'] | undefined;
let server: ReturnType<Express['listen']> | undefined;

try {
  const serverAdapter = new ExpressAdapter();
  const started = await assembleThenListen({
    assemble: () => createApplication({ config, redis: client, queues: queueManager, serverAdapter }),
    onAssembled: (application) => {
      extensionLifecycle = application.extensionLifecycle;
    },
    listen: (application) => listen(application.app, config.PORT),
  });
  const { application } = started;
  server = started.server;

  const refreshScheduler = createRefreshScheduler({
    refresh: () => queueManager.refresh(),
    replaceQueues: application.replaceQueues,
    onError: (error) => console.error('failed to refresh queues:', error),
  });
  refreshScheduler.start();

  const shutdown = createShutdown({
    stopRefresh: () => refreshScheduler.stop(),
    closeServer: () => closeHttpServer(server!),
    disposeExtensions: () => extensionLifecycle!.dispose(),
    closeQueues: () => queueManager.close(),
    disconnectRedis,
    onError: (stage, error) => console.error(`failed to shut down ${stage}:`, error),
  });
  const handleSignal = () => {
    console.log('shutting down...');
    void shutdown().then(() => console.log('bye'));
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  console.log(`bull-board is started http://localhost:${config.PORT}${config.HOME_PAGE}`);
  console.log('bull-board is fetching queue list, please wait...');
} catch (error) {
  if (server) await cleanup('server', () => closeHttpServer(server!));
  if (extensionLifecycle) await cleanup('extensions', () => extensionLifecycle!.dispose());
  await cleanup('queues', () => queueManager.close());
  await cleanup('redis', disconnectRedis);
  throw error;
}

function listen(app: Express, port: number): Promise<ReturnType<Express['listen']>> {
  return new Promise((resolve, reject) => {
    const listeningServer = app.listen(port);
    const onError = (error: Error) => {
      listeningServer.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      listeningServer.off('error', onError);
      resolve(listeningServer);
    };
    listeningServer.once('error', onError);
    listeningServer.once('listening', onListening);
  });
}

async function cleanup(stage: string, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(`failed to clean up ${stage}:`, error);
  }
}

function disconnectRedis(): Promise<void> {
  client.disconnect();
  return Promise.resolve();
}
