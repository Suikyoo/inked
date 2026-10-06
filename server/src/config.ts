import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  webDist: string;
  cookieSecure: boolean;
  trustProxy: false | number | string;
}

// The server package root (one level above src/ or dist/).
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function validProxyEntry(entry: string): boolean {
  const [addr, prefix, ...rest] = entry.split('/');
  const family = isIP(addr);
  if (!family || rest.length) return false;
  if (prefix === undefined) return true;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

export function parseTrustProxy(value: string | undefined): false | number | string {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  // "true" would make Fastify trust every hop, so a client could forge its IP. One hop is what a single reverse proxy needs.
  if (v === 'true' || v === 'yes' || v === 'on') return 1;
  if (/^\d+$/.test(v)) return Number(v);
  const parts = v.split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length && parts.every(validProxyEntry)) return parts.join(',');
  throw new Error(`Invalid TRUST_PROXY: ${value} (use a hop count like 1, or proxy IPs/CIDRs)`);
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
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}
