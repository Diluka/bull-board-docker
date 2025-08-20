// Login functionality is now handled directly in index.ts
// This file can be removed or kept for reference

import config from './config.ts';

export function validateCredentials(username: string, password: string): boolean {
  return username === config.USER_LOGIN && password === config.USER_PASSWORD;
}