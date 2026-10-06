import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  webDist: string;
  cookieSecure: boolean;
  trustProxy: boolean;
}

// The server package root (one level above src/ or dist/).
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }
  return {
    port,
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || './data'),
    webDist: env.WEB_DIST ? path.resolve(env.WEB_DIST) : path.resolve(serverRoot, '../web/dist'),
    cookieSecure: bool(env.COOKIE_SECURE, false),
    trustProxy: bool(env.TRUST_PROXY, false),
  };
}
