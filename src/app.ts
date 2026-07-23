import { createBullBoard as createDefaultBullBoard } from '@bull-board/api';
import type { IMiscLink } from '@bull-board/api/typings/app';
import { Queue } from 'bullmq';
import { ensureLoggedIn as defaultEnsureLoggedIn } from 'connect-ensure-login';
import express, { type Express, type RequestHandler, type Router } from 'express';
import createSession from 'express-session';
import type { Cluster, Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import passport from 'passport';

import type { ExtensionQueues } from './extensions/api.ts';
import { type ExtensionLifecycle, prepareExtensions as prepareDefaultExtensions } from './extensions/loader.ts';
import { injectExtensionMenuIcon } from './extensions/menu-icon.ts';
import { authRouter as defaultAuthRouter } from './login.ts';

export interface ApplicationConfig {
  AUTH_ENABLED: boolean;
  BULL_DELIMITER: string;
  LOGIN_PAGE: string;
  METRICS_ENABLED: boolean;
  METRICS_VARS: Record<string, string>;
  PROXY_LOGIN_PAGE: string;
  PROXY_PATH: string;
}

export interface ApplicationQueues extends ExtensionQueues {
  refresh(): Promise<readonly unknown[]>;
}

export interface ApplicationServerAdapter {
  setBasePath(path: string): unknown;
  getRouter(): Router;
}

export interface ApplicationOptions {
  config: ApplicationConfig;
  redis: Redis | Cluster;
  queues: ApplicationQueues;
  serverAdapter: ApplicationServerAdapter;
}

interface BoardOptions {
  queues: readonly unknown[];
  serverAdapter: ApplicationServerAdapter;
  options: {
    uiConfig: {
      miscLinks: readonly IMiscLink[];
      overview: { groupByDelimiter: boolean };
    };
  };
}

interface ApplicationRuntime {
  prepareExtensions: typeof prepareDefaultExtensions;
  createProtectedRouter(): Router;
  createBullBoard(options: BoardOptions): { replaceQueues(queues: readonly unknown[]): void };
  ensureLoggedIn(redirectTo: string): RequestHandler;
  authRouter: Router;
  session(options: Parameters<typeof createSession>[0]): RequestHandler;
  passport: Pick<typeof passport, 'initialize' | 'session' | 'authenticate'>;
  isProduction?: boolean;
}

export interface CreatedApplication {
  app: Express;
  extensionLifecycle: ExtensionLifecycle;
  replaceQueues(queues: readonly unknown[]): void;
}

export async function createApplication(
  options: ApplicationOptions,
  overrides: Partial<ApplicationRuntime> = {},
): Promise<CreatedApplication> {
  const runtime: ApplicationRuntime = {
    prepareExtensions: prepareDefaultExtensions,
    createProtectedRouter: () => express.Router(),
    createBullBoard: (boardOptions) => {
      const result = createDefaultBullBoard(boardOptions as unknown as Parameters<typeof createDefaultBullBoard>[0]);
      return { replaceQueues: (queues) => result.replaceQueues(queues as Parameters<typeof result.replaceQueues>[0]) };
    },
    ensureLoggedIn: defaultEnsureLoggedIn,
    authRouter: defaultAuthRouter,
    session: createSession,
    passport,
    ...overrides,
  };

  const preparedExtensions = await runtime.prepareExtensions();
  const initialAdapters = await options.queues.refresh();
  const extensionLifecycle = await preparedExtensions.activate({
    redis: options.redis,
    queues: options.queues,
    proxyPath: options.config.PROXY_PATH,
  });

  try {
    options.serverAdapter.setBasePath(options.config.PROXY_PATH);
    const { replaceQueues } = runtime.createBullBoard({
      queues: initialAdapters,
      serverAdapter: options.serverAdapter,
      options: {
        uiConfig: {
          miscLinks: extensionLifecycle.miscLinks,
          overview: {
            groupByDelimiter: Boolean(options.config.BULL_DELIMITER),
          },
        },
      },
    });
    const protectedRouter = runtime.createProtectedRouter();
    extensionLifecycle.mountRouters((path, router) => protectedRouter.use(path, router));
    const boardRouter = options.serverAdapter.getRouter();
    if (extensionLifecycle.miscLinks.length > 0) {
      protectedRouter.use(injectExtensionMenuIcon(), boardRouter);
    } else {
      protectedRouter.use(boardRouter);
    }

    const app = express();
    app.set('views', import.meta.dirname + '/views');
    app.set('view engine', 'ejs');

    const isProduction = runtime.isProduction ?? app.get('env') === 'production';
    if (!isProduction) {
      console.log('bull-board config:', options.config);
      const { default: morgan } = await import('morgan');
      app.use(morgan('combined'));
    }

    app.use(runtime.session({
      name: 'bull-board.sid',
      secret: randomBytes(32).toString('hex'),
      resave: false,
      saveUninitialized: false,
      cookie: {
        path: '/',
        httpOnly: true,
        secure: false,
      },
    }));
    app.use(runtime.passport.initialize());
    app.use(runtime.passport.session());
    app.use(express.urlencoded({ extended: true }));

    if (options.config.METRICS_ENABLED) {
      const metricsAuth: RequestHandler = options.config.AUTH_ENABLED
        ? runtime.passport.authenticate('basic')
        : (_req, _res, next) => next();
      app.get('/metrics', metricsAuth, allQueueMetrics(options));
      app.get<{ queueName: string }>('/metrics/:queueName', metricsAuth, singleQueueMetrics(options));
    }

    if (options.config.AUTH_ENABLED) app.use(options.config.LOGIN_PAGE, runtime.authRouter);
    if (options.config.AUTH_ENABLED) {
      app.use('/', runtime.ensureLoggedIn(options.config.PROXY_LOGIN_PAGE), protectedRouter);
    } else {
      app.use('/', protectedRouter);
    }

    return { app, extensionLifecycle, replaceQueues };
  } catch (error) {
    try {
      await extensionLifecycle.dispose();
    } catch (disposeError) {
      throw new AggregateError([error, disposeError], 'Application assembly and extension cleanup failed');
    }
    throw error;
  }
}

function allQueueMetrics(options: ApplicationOptions): RequestHandler {
  return async (_req, res) => {
    try {
      const allMetrics: string[] = [];
      for (const queue of options.queues.list()) {
        if (queue instanceof Queue) allMetrics.push(await queue.exportPrometheusMetrics(options.config.METRICS_VARS));
      }
      if (allMetrics.length === 0) {
        res.status(404).send('No BullMQ queues found');
        return;
      }
      res.set('Content-Type', 'text/plain');
      res.send(allMetrics.join('\n'));
    } catch (error) {
      res.status(500).send(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };
}

function singleQueueMetrics(options: ApplicationOptions): RequestHandler<{ queueName: string }> {
  return async (req, res) => {
    try {
      const queue = options.queues.get(req.params.queueName);
      if (!queue) {
        res.status(404).send(`Queue "${req.params.queueName}" not found`);
        return;
      }
      if (!(queue instanceof Queue)) {
        res.status(400).send('Metrics only available for BullMQ queues');
        return;
      }
      const metrics = await queue.exportPrometheusMetrics(options.config.METRICS_VARS);
      res.set('Content-Type', 'text/plain');
      res.send(metrics);
    } catch (error) {
      res.status(500).send(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };
}
