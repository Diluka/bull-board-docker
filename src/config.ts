import { config } from 'dotenv';
import path from 'node:path';

config();

function normalizePath(pathStr?: string): string {
  return (pathStr || '').replace(/\/$/, '');
}

const PROXY_PATH = normalizePath(process.env.PROXY_PATH);
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
  REDIS_PORT: Number(process.env.REDIS_PORT) || 6379,
  REDIS_HOST: process.env.REDIS_HOST || 'localhost',
  REDIS_DB: process.env.REDIS_DB || '0',
  REDIS_PASSWORD: process.env.REDIS_PASSWORD,
  REDIS_USE_TLS: process.env.REDIS_USE_TLS,
  REDIS_IS_CLUSTER: process.env.REDIS_IS_CLUSTER,
  BULL_PREFIX: process.env.BULL_PREFIX || 'bull',
  BULL_VERSION: process.env.BULL_VERSION || 'BULLMQ',
  PORT: Number(process.env.PORT) || 3000,
  PROXY_PATH,
  USER_LOGIN: process.env.USER_LOGIN,
  USER_PASSWORD: process.env.USER_PASSWORD,

  AUTH_ENABLED: Boolean(process.env.USER_LOGIN && process.env.USER_PASSWORD),
  HOME_PAGE,
  LOGIN_PAGE,
  PROXY_HOME_PAGE: path.join(PROXY_PATH, HOME_PAGE),
  PROXY_LOGIN_PAGE: path.join(PROXY_PATH, LOGIN_PAGE),
};

export default configObject;