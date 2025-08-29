import { createBullBoard } from '@bull-board/api';
import { BullAdapter } from '@bull-board/api/bullAdapter';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import LegacyQueue, { Queue as BullQueue } from 'bull';
import { Queue } from 'bullmq';
import { ensureLoggedIn } from 'connect-ensure-login';
import express from 'express';
import session from 'express-session';
import { Cluster, Redis, RedisOptions } from 'ioredis';
import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';
import passport from 'passport';

import config from './config.ts';
import { authRouter } from './login.ts';

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
      [
        {
          port: config.REDIS_PORT,
          host: config.REDIS_HOST,
        },
      ],
      {
        redisOptions: {
          password: config.REDIS_PASSWORD,
          tls: config.REDIS_USE_TLS === 'true' ? {} : undefined,
        },
      },
    )
    : new Redis(redisConfig);
}

const serverAdapter = new ExpressAdapter();
const client = createRedisClient();
const { replaceQueues, removeQueue } = createBullBoard({
  queues: [],
  serverAdapter,
});
const router = serverAdapter.getRouter();

const queueMap = new Map<string, Queue | BullQueue>();

async function updateQueues(): Promise<void> {
  const isBullMQ = (): boolean => config.BULL_VERSION === 'BULLMQ';
  const keys = await client.keys(`${config.BULL_PREFIX}:*:id`);
  const uniqKeys = new Set(
    keys
      // ':' may contain in BULL_PREFIX
      .map((key: string) => key.replace(config.BULL_PREFIX, 'bull'))
      .map((key: string) => key.replace(/^.+?:(.+?):id$/, '$1')),
  );
  const actualQueues = Array.from(uniqKeys).sort();

  for (const queueName of actualQueues) {
    if (!queueMap.has(queueName)) {
      queueMap.set(
        queueName,
        isBullMQ()
          ? new Queue(queueName, {
            connection: client,
            prefix: config.BULL_PREFIX,
          })
          : new LegacyQueue(queueName, {
            createClient() {
              return client;
            },
            prefix: config.BULL_PREFIX,
          }),
      );
    }
  }

  for (const [queueName, queue] of queueMap.entries()) {
    if (!actualQueues.includes(queueName)) {
      await queue.close();
      queueMap.delete(queueName);
    }
  }

  const adapters = [];
  for (const queue of queueMap.values()) {
    adapters.push(
      isBullMQ() ? new BullMQAdapter(queue as Queue) : new BullAdapter(queue as BullQueue),
    );
  }

  replaceQueues(adapters);
}

await updateQueues();

serverAdapter.setBasePath(config.PROXY_PATH);

const app = express();

app.set('views', import.meta.dirname + '/views');
app.set('view engine', 'ejs');

if (app.get('env') !== 'production') {
  console.log('bull-board config:', config);
  const { default: morgan } = await import('morgan');
  app.use(morgan('combined'));
}

const sessionOpts = {
  name: 'bull-board.sid',
  secret: Math.random().toString(),
  resave: false,
  saveUninitialized: false,
  cookie: {
    path: '/',
    httpOnly: false,
    secure: false,
  },
};

app.use(session(sessionOpts));
app.use(passport.initialize());
app.use(passport.session());
app.use(express.urlencoded({ extended: true }));

if (config.AUTH_ENABLED) {
  app.use(config.LOGIN_PAGE, authRouter);
  app.use(config.HOME_PAGE, ensureLoggedIn(config.PROXY_LOGIN_PAGE), router);
} else {
  app.use(config.HOME_PAGE, router);
}

let updateQueuesInterval: NodeJS.Timeout | null = null;

const gracefullyShutdown = async () => {
  console.log('shutting down...');
  if (updateQueuesInterval) {
    clearInterval(updateQueuesInterval);
  }
  console.log('closing queues...');
  for (const queue of queueMap.values()) {
    removeQueue(queue.name);
    await queue.close();
  }
  console.log('closing redis...');
  await client.disconnect();
  console.log('closing server...');
  server.close();
  console.log('bye');
  process.exit();
};

const server = app.listen(config.PORT, () => {
  console.log(
    `bull-board is started http://localhost:${config.PORT}${config.HOME_PAGE}`,
  );
  console.log(`bull-board is fetching queue list, please wait...`);

  // poor man queue update process
  updateQueuesInterval = setInterval(updateQueues, 60 * 1000);
  process.on('SIGINT', gracefullyShutdown);
  process.on('SIGTERM', gracefullyShutdown);
});
