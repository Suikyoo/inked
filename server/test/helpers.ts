import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';

export interface TestApp {
  app: FastifyInstance;
  dataDir: string;
  close: () => Promise<void>;
}

export async function makeApp(opts: { webDist?: string; trustProxy?: false | number | string } = {}): Promise<TestApp> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'inked-test-'));
  const app = await buildApp({
    dataDir,
    webDist: opts.webDist ?? path.join(dataDir, 'no-web'),
    cookieSecure: false,
    trustProxy: opts.trustProxy ?? false,
  });
  return {
    app,
    dataDir,
    close: async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** A correctly shaped (but meaningless) ciphertext: "v1." + base64url(bytes). */
export const fakeCipher = (bytes = 60) => `v1.${randomBytes(bytes).toString('base64url')}`;

/** base64url of 32 random bytes, the shape of authKey / recoveryAuth. */
export const key32 = () => randomBytes(32).toString('base64url');

export const kdfParams = { alg: 'argon2id', m: 65536, t: 3, p: 1 };

export interface Account {
  username: string;
  authKey: string;
  recoveryAuth: string;
  cookie: string;
  userId: string;
}

export function registerBody(username: string) {
  return {
    userId: randomUUID(),
    username,
    kdfSalt: randomBytes(16).toString('base64url'),
    kdfParams,
    authKey: key32(),
    wrappedUserKey: fakeCipher(60),
    recoveryAuth: key32(),
    wrappedUserKeyRecovery: fakeCipher(60),
  };
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Inject a request with the CSRF header set (unless overridden) and an optional session cookie. */
export function call(
  app: FastifyInstance,
  method: Method,
  url: string,
  options: { body?: unknown; cookie?: string; headers?: Record<string, string>; ip?: string } = {},
) {
  const headers: Record<string, string> = { 'x-inked': '1', ...options.headers };
  if (options.cookie) headers.cookie = `inked_session=${options.cookie}`;
  const req: InjectOptions = { method, url, headers };
  if (options.body !== undefined) req.payload = options.body as InjectOptions['payload'];
  if (options.ip) req.remoteAddress = options.ip;
  return app.inject(req);
}

export function sessionCookie(res: { cookies: Array<{ name: string; value: string }> }): string {
  const cookie = res.cookies.find((c) => c.name === 'inked_session');
  if (!cookie?.value) throw new Error('no session cookie in response');
  return cookie.value;
}

/** Runs first-time setup and returns the admin account. */
export async function setupAdmin(app: FastifyInstance, username = 'admin'): Promise<Account> {
  const body = registerBody(username);
  const res = await call(app, 'POST', '/api/setup', { body });
  if (res.statusCode !== 200) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  return { username, authKey: body.authKey, recoveryAuth: body.recoveryAuth, cookie: sessionCookie(res), userId: body.userId };
}

/** Creates an invite as `admin` and registers `username` with it. */
export async function inviteUser(app: FastifyInstance, admin: Account, username: string): Promise<Account> {
  const invite = await call(app, 'POST', '/api/invites', { cookie: admin.cookie, body: {} });
  const body = { ...registerBody(username), inviteToken: invite.json().token };
  const res = await call(app, 'POST', '/api/auth/register', { body });
  if (res.statusCode !== 200) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
  return { username, authKey: body.authKey, recoveryAuth: body.recoveryAuth, cookie: sessionCookie(res), userId: body.userId };
}
