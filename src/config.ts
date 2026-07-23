import 'dotenv/config';
import path from 'node:path';
import process from 'node:process';

function normalizePath(pathStr?: string) {
  return (pathStr || '').replace(/\/$/, '');
}

function getMetricsVars(): Record<string, string> {
  const metricsVars: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('METRICS_VAR_') && value) {
      const varName = key.replace(/^METRICS_VAR_/, '');
      metricsVars[varName] = value;
    }
  }
  return metricsVars;
}

const PROXY_PATH = normalizePath(process.env.PROXY_PATH);
const HOME_PAGE = '/';
const LOGIN_PAGE = '/login';

export default {
  REDIS_PORT: parseInt(process.env.REDIS_PORT || '6379'),
  REDIS_HOST: process.env.REDIS_HOST || 'localhost',
  REDIS_DB: parseInt(process.env.REDIS_DB || '0'),
  REDIS_PASSWORD: process.env.REDIS_PASSWORD,
  REDIS_USE_TLS: process.env.REDIS_USE_TLS,
  REDIS_IS_CLUSTER: process.env.REDIS_IS_CLUSTER,
  BULL_PREFIX: process.env.BULL_PREFIX || 'bull',
  BULL_VERSION: process.env.BULL_VERSION || 'BULLMQ',
  BULL_DELIMITER: process.env.BULL_DELIMITER || '',
  METRICS_ENABLED: process.env.METRICS_ENABLED === 'true',
  METRICS_VARS: getMetricsVars(),
  PORT: parseInt(process.env.PORT || '3000'),
  PROXY_PATH,
  USER_LOGIN: process.env.USER_LOGIN,
  USER_PASSWORD: process.env.USER_PASSWORD,

  AUTH_ENABLED: Boolean(process.env.USER_LOGIN && process.env.USER_PASSWORD),
  HOME_PAGE,
  LOGIN_PAGE,
  PROXY_HOME_PAGE: path.join(PROXY_PATH, HOME_PAGE),
  PROXY_LOGIN_PAGE: path.join(PROXY_PATH, LOGIN_PAGE),
} as const;
