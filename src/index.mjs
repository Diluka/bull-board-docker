import { createBullBoard } from '@bull-board/api';
import { BullAdapter } from '@bull-board/api/bullAdapter.js';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';
import { ExpressAdapter } from '@bull-board/express';
import LegacyQueue from 'bull';
import { Queue } from 'bullmq';
import { ensureLoggedIn } from 'connect-ensure-login';
import express from 'express';
import session from 'express-session';
import IORedis from 'ioredis';
import { dirname } from 'node:path';
import { clearInterval, setInterval } from 'node:timers';
import { fileURLToPath } from 'node:url';
import passport from 'passport';
import config from './config.mjs';
import { authRouter } from './login.mjs';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const redisConfig = {
  redis: {
    port: config.REDIS_PORT,
    host: config.REDIS_HOST,
    db: config.REDIS_DB,
    ...(config.REDIS_PASSWORD && { password: config.REDIS_PASSWORD }),
    tls: config.REDIS_USE_TLS === 'true',
  },
};

function createRedisClient() {
  return config.REDIS_IS_CLUSTER === 'true'
    ? new IORedis.Cluster(
      [
        {
          port: config.REDIS_PORT,
          host: config.REDIS_HOST,
        },
      ],
      {
        redisOptions: {
          ...(config.REDIS_PASSWORD && { password: config.REDIS_PASSWORD }),
          tls: config.REDIS_USE_TLS === 'true',
        },
      },
    )
    : new IORedis(redisConfig.redis);
}

const serverAdapter = new ExpressAdapter();
const client = createRedisClient();
const { replaceQueues, removeQueue } = createBullBoard({ queues: [], serverAdapter });
const router = serverAdapter.getRouter();

const queueMap = new Map();

async function updateQueues() {
  const isBullMQ = () => config.BULL_VERSION === 'BULLMQ';
  const keys = await client.keys(`${config.BULL_PREFIX}:*:id`);
  const uniqKeys = new Set(
    keys
      // ':' may contain in BULL_PREFIX
      .map((key) => key.replace(config.BULL_PREFIX), 'bull')
      .map((key) => key.replace(/^.+?:(.+?):id$/, '$1')),
  );
  const actualQueues = Array.from(uniqKeys).sort();

  for (const queueName of actualQueues) {
    if (!queueMap.has(queueName)) {
      queueMap.set(
        queueName,
        isBullMQ()
          ? new Queue(queueName, { connection: client, prefix: config.BULL_PREFIX })
          : new LegacyQueue(queueName, {
            createClient(type, redisOpts) {
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
    adapters.push(isBullMQ() ? new BullMQAdapter(queue) : new BullAdapter(queue));
  }

  replaceQueues(adapters);
}

await updateQueues();

serverAdapter.setBasePath(config.PROXY_PATH);

const app = express();

app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');

if (app.get('env') !== 'production') {
  console.log('bull-board condig:', config);
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
app.use(passport.initialize({}));
app.use(passport.session({}));
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '50mb' }));

if (config.AUTH_ENABLED) {
  app.use(config.LOGIN_PAGE, authRouter);
  app.use(config.HOME_PAGE, ensureLoggedIn(config.PROXY_LOGIN_PAGE), router);
} else {
  app.use(config.HOME_PAGE, router);
}

let updateQueuesInterval = null;
const gracefullyShutdown = async () => {
  console.log('shutting down...');
  clearInterval(updateQueuesInterval);
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
  console.log(`bull-board is started http://localhost:${config.PORT}${config.HOME_PAGE}`);
  console.log(`bull-board is fetching queue list, please wait...`);

  // poor man queue update process
  updateQueuesInterval = setInterval(updateQueues, 60 * 1000);
  process.on('SIGINT', gracefullyShutdown);
  process.on('SIGTERM', gracefullyShutdown);
});
