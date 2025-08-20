// Restored Bull Board functionality for Deno runtime
// This maintains the original functionality while running on Deno

import { 
  createBullBoard, 
  BullAdapter, 
  BullMQAdapter,
  ExpressAdapter,
  Bull, 
  Queue, 
  IORedis,
  express,
  session,
  passport,
  LocalStrategy,
  serve,
  join,
  dirname
} from '../deps.ts';
import config from './config.ts';

// Redis client setup (same as original)
const redisConfig = {
  port: config.REDIS_PORT,
  host: config.REDIS_HOST,
  db: config.REDIS_DB,
  ...(config.REDIS_PASSWORD && { password: config.REDIS_PASSWORD }),
  tls: config.REDIS_USE_TLS === 'true',
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
    : new IORedis(redisConfig);
}

// Initialize Bull Board with real functionality using ExpressAdapter
const serverAdapter = new ExpressAdapter();
const client = createRedisClient();
const { replaceQueues, removeQueue } = createBullBoard({ 
  queues: [], 
  serverAdapter: serverAdapter
});
const router = serverAdapter.getRouter();

const queueMap = new Map();

// Real queue update function (same as original)
async function updateQueues(): Promise<void> {
  const isBullMQ = () => config.BULL_VERSION === 'BULLMQ';
  
  try {
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
            ? new Queue(queueName as string, { 
                connection: client, 
                prefix: config.BULL_PREFIX 
              })
            : new Bull(queueName as string, {
                createClient(type: any, redisOpts: any) {
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
  } catch (error) {
    console.error('Error updating queues:', error);
  }
}

// Authentication setup (adapted for Deno)
passport.use(
  new LocalStrategy(function(username: string, password: string, cb: any) {
    if (username === config.USER_LOGIN && password === config.USER_PASSWORD) {
      return cb(null, { user: 'bull-board' });
    }
    return cb(null, false);
  }),
);

passport.serializeUser((user: any, cb: any) => {
  cb(null, user);
});

passport.deserializeUser((user: any, cb: any) => {
  cb(null, user);
});

// Express app setup
const app = express();

// Session configuration
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

// Authentication router
const authRouter = express.Router();

authRouter
  .route('/')
  .get((req: any, res: any) => {
    const loginHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Bull Board Login</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 0; padding: 50px; background: #f5f5f5; }
          .login-container { max-width: 400px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          h1 { text-align: center; color: #333; margin-bottom: 30px; }
          .form-group { margin-bottom: 20px; }
          label { display: block; margin-bottom: 5px; color: #555; font-weight: bold; }
          input[type="text"], input[type="password"] { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
          button { width: 100%; padding: 12px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; }
          button:hover { background: #0056b3; }
        </style>
      </head>
      <body>
        <div class="login-container">
          <h1>Bull Board</h1>
          <form method="post" action="${config.LOGIN_PAGE}">
            <div class="form-group">
              <label for="username">Username:</label>
              <input type="text" id="username" name="username" required>
            </div>
            <div class="form-group">
              <label for="password">Password:</label>
              <input type="password" id="password" name="password" required>
            </div>
            <button type="submit">Login</button>
          </form>
        </div>
      </body>
      </html>
    `;
    res.send(loginHtml);
  })
  .post(
    passport.authenticate('local', {
      successRedirect: config.PROXY_HOME_PAGE,
      failureRedirect: config.PROXY_LOGIN_PAGE,
    }),
  );

// Middleware function to ensure login
function ensureLoggedIn(redirectTo: string) {
  return (req: any, res: any, next: any) => {
    if (!req.isAuthenticated || !req.isAuthenticated()) {
      return res.redirect(redirectTo);
    }
    next();
  };
}

// Set up routes
if (config.AUTH_ENABLED) {
  app.use(config.LOGIN_PAGE, authRouter);
  app.use(config.HOME_PAGE, ensureLoggedIn(config.PROXY_LOGIN_PAGE), router);
} else {
  app.use(config.HOME_PAGE, router);
}

// Initialize queues
await updateQueues();
serverAdapter.setBasePath(config.PROXY_PATH);

// Express app to Deno handler adapter
async function expressAppToDenoHandler(req: Request): Promise<Response> {
  return new Promise(async (resolve, reject) => {
    const url = new URL(req.url);
    let body = null;
    
    // Parse request body if present
    if (req.body && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH')) {
      try {
        const contentType = req.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          body = await req.json();
        } else if (contentType?.includes('application/x-www-form-urlencoded')) {
          body = await req.formData();
        } else {
          body = await req.text();
        }
      } catch (e) {
        // Ignore parsing errors
      }
    }

    // Create Node.js-like request object
    const nodeReq = {
      method: req.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(req.headers.entries()),
      body: body,
      isAuthenticated: () => false, // Will be overridden by passport
      user: null,
      session: {},
    } as any;

    // Create Node.js-like response object
    const chunks: Uint8Array[] = [];
    let responseHeaders: Record<string, string> = {};
    let statusCode = 200;
    
    const nodeRes = {
      statusCode: 200,
      
      setHeader(name: string, value: string) {
        responseHeaders[name] = value;
      },
      
      getHeader(name: string) {
        return responseHeaders[name];
      },
      
      writeHead(code: number, headers?: Record<string, string>) {
        statusCode = code;
        if (headers) {
          Object.assign(responseHeaders, headers);
        }
      },
      
      write(chunk: string | Uint8Array) {
        if (typeof chunk === 'string') {
          chunks.push(new TextEncoder().encode(chunk));
        } else {
          chunks.push(chunk);
        }
      },
      
      end(chunk?: string | Uint8Array) {
        if (chunk) {
          this.write(chunk);
        }
        
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const responseBody = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          responseBody.set(chunk, offset);
          offset += chunk.length;
        }
        
        resolve(new Response(responseBody, {
          status: statusCode,
          headers: responseHeaders,
        }));
      },

      send(data: any) {
        this.setHeader('Content-Type', 'text/html');
        this.end(data);
      },

      json(data: any) {
        this.setHeader('Content-Type', 'application/json');
        this.end(JSON.stringify(data));
      },

      redirect(url: string) {
        this.writeHead(302, { 'Location': url });
        this.end();
      }
    } as any;

    try {
      // Process the request through Express app
      await new Promise<void>((resolveMiddleware) => {
        app(nodeReq, nodeRes, () => {
          resolveMiddleware();
        });
      });
    } catch (error) {
      reject(error);
    }
  });
}

// Graceful shutdown
let updateQueuesInterval: number | null = null;

const gracefullyShutdown = async (): Promise<void> => {
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
  console.log('bye');
  Deno.exit();
};

// Start server
console.log(`bull-board is started http://localhost:${config.PORT}${config.HOME_PAGE}`);
console.log(`bull-board is fetching queue list, please wait...`);

// Update queues periodically
updateQueuesInterval = setInterval(updateQueues, 60 * 1000);

// Handle graceful shutdown
const signals: Deno.Signal[] = ["SIGINT", "SIGTERM"];
for (const signal of signals) {
  Deno.addSignalListener(signal, gracefullyShutdown);
}

// Start the server with Express app handler
await serve(expressAppToDenoHandler, { port: config.PORT });