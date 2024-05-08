const { createBullBoard } = require('@bull-board/api');
const { BullAdapter } = require('@bull-board/api/bullAdapter');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const Queue = require('bull');
const bullmq = require('bullmq');
const express = require('express');
const IORedis = require('ioredis');
const session = require('express-session');
const passport = require('passport');
const { ensureLoggedIn } = require('connect-ensure-login');

const { authRouter } = require('./login');
const config = require('./config');

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
  const keys = await client.keys(`${config.BULL_PREFIX}:*`);
  const uniqKeys = new Set(
    keys
      // ':' may contain in BULL_PREFIX
      .map((key) => key.replace(config.BULL_PREFIX), 'bull')
      .map((key) => key.replace(/^.+?:(.+?):.+?$/, '$1')),
  );
  const actualQueues = Array.from(uniqKeys).sort();

  for (const queueName of actualQueues) {
    if (!queueMap.has(queueName)) {
      queueMap.set(
        queueName,
        isBullMQ()
          ? new bullmq.Queue(queueName, { connection: createRedisClient(), prefix: config.BULL_PREFIX })
          : new Queue(queueName, {
              createClient(type, redisOpts) {
                return createRedisClient();
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

updateQueues();

serverAdapter.setBasePath(config.PROXY_PATH);

const app = express();

app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');

if (app.get('env') !== 'production') {
  console.log('bull-board condig:', config);
  const morgan = require('morgan');
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
  for (const queue of queueMap.values()) {
    removeQueue(queue.name);
    await queue.close();
  }
  await client.disconnect();
  server.close();
};

const server = app.listen(config.PORT, () => {
  console.log(`bull-board is started http://localhost:${config.PORT}${config.HOME_PAGE}`);
  console.log(`bull-board is fetching queue list, please wait...`);

  // poor man queue update process
  updateQueuesInterval = setInterval(updateQueues, 60 * 1000);
  process.on('SIGINT', gracefullyShutdown);
  process.on('SIGTERM', gracefullyShutdown);
});
