import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertKdfParams,
  DEFAULT_KDF_PARAMS,
  deriveFromPassword,
  deriveRecoveryKeys,
  encryptVaultMeta,
  generateKdfSalt,
  generateRecoveryKey,
  generateUserKey,
  generateVaultKey,
  rewrapUserKey,
  aad,
  unwrapUserKey,
} from 'inked-core';
import { buildApp } from '../../../server/src/app.js';

export const SETUP_TOKEN = 'mcp-test-setup-token-0123456789abcdef';

/** The real Inked server on a random local port, with a throwaway data dir. */
export async function startInked() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'inked-mcp-srv-'));
  const app = await buildApp({
    dataDir,
    webDist: path.join(dataDir, 'no-web'),
    cookieSecure: false,
    trustProxy: false,
    setupToken: SETUP_TOKEN,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
    close: async () => {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

async function post(baseUrl: string, p: string, body: unknown, cookie?: string) {
  const res = await fetch(baseUrl + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Inked': '1', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${p} → ${res.status} ${JSON.stringify(json)}`);
  const session = res.headers.getSetCookie().find((c) => c.startsWith('inked_session='));
  return { json, cookie: session ? session.split(';')[0] : undefined };
}

/** First-run setup for `username`, with the same key material the web client makes. */
export async function seedUser(baseUrl: string, username: string, password: string) {
  const userId = crypto.randomUUID();
  const kdfSalt = generateKdfSalt();
  const kdfParams = { ...DEFAULT_KDF_PARAMS };
  const pw = await deriveFromPassword(password, kdfSalt, kdfParams);
  const rk = await deriveRecoveryKeys(generateRecoveryKey());
  const uk = await generateUserKey(userId, pw.passwordKEK, rk.recoveryKEK);
  await post(baseUrl, '/api/setup', {
    userId, username, kdfSalt, kdfParams, authKey: pw.authKey,
    wrappedUserKey: uk.wrappedUserKey, recoveryAuth: rk.recoveryAuth,
    wrappedUserKeyRecovery: uk.wrappedUserKeyRecovery, setupToken: SETUP_TOKEN,
  });
  return { userId };
}

async function signIn(baseUrl: string, username: string, password: string) {
  const params = (await (await fetch(`${baseUrl}/api/auth/params?username=${encodeURIComponent(username)}`)).json()) as {
    kdfSalt: string;
    kdfParams: unknown;
  };
  const kdfParams = assertKdfParams(params.kdfParams);
  const pw = await deriveFromPassword(password, params.kdfSalt, kdfParams);
  const { json, cookie } = await post(baseUrl, '/api/auth/login', { username, authKey: pw.authKey });
  const user = json.user as { id: string };
  const userKey = await unwrapUserKey(json.wrappedUserKey as string, pw.passwordKEK, user.id);
  return { cookie: cookie!, userId: user.id, userKey, pw, wrappedUserKey: json.wrappedUserKey as string };
}

/** Creates a vault named `name` (vault creation is never an MCP tool, so tests do it directly). */
export async function addVault(baseUrl: string, username: string, password: string, name: string, color = '#45A89E') {
  const s = await signIn(baseUrl, username, password);
  const id = crypto.randomUUID();
  const { vaultKey, wrappedKey } = await generateVaultKey(id, s.userKey);
  const encMeta = await encryptVaultMeta(vaultKey, id, { name, color });
  await post(baseUrl, '/api/vaults', { id, encMeta, wrappedKey }, s.cookie);
  return id;
}

/** Changes the password the way the web client does (re-wraps userKey; new salt). */
export async function changePassword(baseUrl: string, username: string, oldPassword: string, newPassword: string) {
  const s = await signIn(baseUrl, username, oldPassword);
  const kdfSalt = generateKdfSalt();
  const kdfParams = { ...DEFAULT_KDF_PARAMS };
  const next = await deriveFromPassword(newPassword, kdfSalt, kdfParams);
  const wrappedUserKey = await rewrapUserKey(
    s.wrappedUserKey,
    { kek: s.pw.passwordKEK, aad: aad.userKey(s.userId) },
    { kek: next.passwordKEK, aad: aad.userKey(s.userId) },
  );
  await post(
    baseUrl,
    '/api/auth/password',
    { currentAuthKey: s.pw.authKey, kdfSalt, kdfParams, authKey: next.authKey, wrappedUserKey },
    s.cookie,
  );
}
