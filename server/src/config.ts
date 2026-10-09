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
  llmOrigins: string[];
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

const DNS_HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const LOCAL_HTTP = new Set(['localhost', '127.0.0.1']);

/** INKED_LLM_ORIGINS: bare https origins (or localhost http for development) the browser may call for Ask. */
export function parseLlmOrigins(value: string | undefined): string[] {
  const out: string[] = [];
  for (const raw of (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error(`Invalid INKED_LLM_ORIGINS entry: ${raw}`);
    }
    const bare = u.origin === raw.replace(/\/$/, '') && u.pathname === '/' && !u.search && !u.hash && !u.username;
    const host = DNS_HOST.test(u.hostname) || isIP(u.hostname) === 4;
    const scheme = u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HTTP.has(u.hostname));
    if (!bare || !scheme || !host) {
      throw new Error(`Invalid INKED_LLM_ORIGINS entry: ${raw} (use bare https origins like https://api.openai.com; http only for localhost or 127.0.0.1)`);
    }
    if (!out.includes(u.origin)) out.push(u.origin);
  }
  return out;
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
    llmOrigins: parseLlmOrigins(env.INKED_LLM_ORIGINS),
  };
}
