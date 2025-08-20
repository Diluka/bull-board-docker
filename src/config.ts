import { join } from '../deps.ts';

// Load environment variables from .env file if it exists
try {
  const envText = await Deno.readTextFile('.env');
  const lines = envText.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        const value = valueParts.join('=');
        Deno.env.set(key, value);
      }
    }
  }
} catch {
  // .env file doesn't exist, continue with system env vars
}

function normalizePath(pathStr?: string): string {
  return (pathStr || '').replace(/\/$/, '');
}

const PROXY_PATH = normalizePath(Deno.env.get('PROXY_PATH'));
const HOME_PAGE = '/';
const LOGIN_PAGE = '/login';

interface Config {
  REDIS_PORT: number;
  REDIS_HOST: string;
  REDIS_DB: string;
  REDIS_PASSWORD?: string | undefined;
  REDIS_USE_TLS?: string | undefined;
  REDIS_IS_CLUSTER?: string | undefined;
  BULL_PREFIX: string;
  BULL_VERSION: string;
  PORT: number;
  PROXY_PATH: string;
  USER_LOGIN?: string | undefined;
  USER_PASSWORD?: string | undefined;
  AUTH_ENABLED: boolean;
  HOME_PAGE: string;
  LOGIN_PAGE: string;
  PROXY_HOME_PAGE: string;
  PROXY_LOGIN_PAGE: string;
}

const configObject: Config = {
  REDIS_PORT: Number(Deno.env.get('REDIS_PORT')) || 6379,
  REDIS_HOST: Deno.env.get('REDIS_HOST') || 'localhost',
  REDIS_DB: Deno.env.get('REDIS_DB') || '0',
  REDIS_PASSWORD: Deno.env.get('REDIS_PASSWORD'),
  REDIS_USE_TLS: Deno.env.get('REDIS_USE_TLS'),
  REDIS_IS_CLUSTER: Deno.env.get('REDIS_IS_CLUSTER'),
  BULL_PREFIX: Deno.env.get('BULL_PREFIX') || 'bull',
  BULL_VERSION: Deno.env.get('BULL_VERSION') || 'BULLMQ',
  PORT: Number(Deno.env.get('PORT')) || 3000,
  PROXY_PATH,
  USER_LOGIN: Deno.env.get('USER_LOGIN'),
  USER_PASSWORD: Deno.env.get('USER_PASSWORD'),

  AUTH_ENABLED: Boolean(Deno.env.get('USER_LOGIN') && Deno.env.get('USER_PASSWORD')),
  HOME_PAGE,
  LOGIN_PAGE,
  PROXY_HOME_PAGE: join(PROXY_PATH, HOME_PAGE),
  PROXY_LOGIN_PAGE: join(PROXY_PATH, LOGIN_PAGE),
};

export default configObject;