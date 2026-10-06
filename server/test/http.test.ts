import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { call, key32, makeApp, setupAdmin, setupBody, type TestApp } from './helpers.js';

let t: TestApp | undefined;
let webDist: string | undefined;
afterEach(async () => {
  await t?.close();
  if (webDist) rmSync(webDist, { recursive: true, force: true });
  t = undefined;
  webDist = undefined;
});

const EXPECTED_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
};

describe('CSRF header', () => {
  it('is required on non-GET requests', async () => {
    t = await makeApp();
    const missing = await t.app.inject({ method: 'POST', url: '/api/setup', payload: setupBody('admin') });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error).toBe('csrf');

    const wrong = await call(t.app, 'POST', '/api/setup', { body: setupBody('admin'), headers: { 'x-inked': '0' } });
    expect(wrong.statusCode).toBe(403);

    // Nothing was created.
    expect((await call(t.app, 'GET', '/api/status')).json()).toEqual({ needsSetup: true });

    const admin = await setupAdmin(t.app);
    const del = await t.app.inject({
      method: 'DELETE',
      url: '/api/vaults/00000000-0000-4000-8000-000000000000',
      headers: { cookie: `inked_session=${admin.cookie}` },
    });
    expect(del.statusCode).toBe(403);
  });

  it('is not required on GET', async () => {
    t = await makeApp();
    const res = await t.app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
  });
});

describe('security headers', () => {
  it('are on API responses, errors and 404s', async () => {
    t = await makeApp();
    const responses = [
      await call(t.app, 'GET', '/api/status'),
      await call(t.app, 'GET', '/api/me'),
      await call(t.app, 'GET', '/api/does-not-exist'),
      await t.app.inject({ method: 'POST', url: '/api/setup' }),
    ];
    for (const res of responses) {
      expect(res.headers).toMatchObject(EXPECTED_HEADERS);
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('treats an empty JSON body as no body', async () => {
    t = await makeApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { 'x-inked': '1', 'content-type': 'application/json' },
      payload: '',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('rejects malformed JSON with 400', async () => {
    t = await makeApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-inked': '1', 'content-type': 'application/json' },
      payload: '{nope',
    });
    expect(res.statusCode).toBe(400);
    expect(typeof res.json().error).toBe('string');
  });
});

describe('server secret', () => {
  it('is created once, 32 bytes, and reused', async () => {
    t = await makeApp();
    const file = path.join(t.dataDir, 'server-secret');
    expect(existsSync(file)).toBe(true);
    const secret = readFileSync(file);
    expect(secret.length).toBe(32);
    const before = (await call(t.app, 'GET', '/api/auth/params?username=ghost')).json();
    await t.app.close();

    // Reopen the same data dir: same secret, so the same fake salt.
    const { buildApp } = await import('../src/app.js');
    const reopened = await buildApp({ dataDir: t.dataDir, webDist: path.join(t.dataDir, 'none'), cookieSecure: false });
    const after = (await call(reopened, 'GET', '/api/auth/params?username=ghost')).json();
    expect(after).toEqual(before);
    expect(readFileSync(file).equals(secret)).toBe(true);
    await reopened.close();
    rmSync(t.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    t = undefined;
  });
});

describe('SPA hosting', () => {
  function makeWebDist() {
    const dir = mkdtempSync(path.join(tmpdir(), 'inked-web-'));
    mkdirSync(path.join(dir, 'assets'));
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Inked</title>');
    writeFileSync(path.join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
    return dir;
  }

  it('serves files and falls back to index.html for client routes', async () => {
    webDist = makeWebDist();
    t = await makeApp({ webDist });

    const root = await t.app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<title>Inked</title>');
    expect(root.headers['cache-control']).toBe('no-cache');
    expect(root.headers).toMatchObject(EXPECTED_HEADERS);

    const deep = await t.app.inject({ method: 'GET', url: '/v/123/n/456' });
    expect(deep.statusCode).toBe(200);
    expect(deep.headers['content-type']).toMatch(/text\/html/);
    expect(deep.body).toContain('<title>Inked</title>');
    expect(deep.headers['cache-control']).toBe('no-cache');
    expect(deep.headers).toMatchObject(EXPECTED_HEADERS);

    const asset = await t.app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('console.log(1)');
    expect(asset.headers['cache-control']).toContain('immutable');

    const api = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: 'not_found' });
  });

  it('is API-only when there is no web build', async () => {
    t = await makeApp();
    const res = await t.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });
});

describe('trusted proxy', () => {
  async function hammer(app: TestApp['app'], username: string, xff: string, n: number) {
    const codes: number[] = [];
    for (let i = 0; i < n; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-inked': '1', 'x-forwarded-for': xff.replace('#', String(i)) },
        payload: { username, authKey: key32() },
      });
      codes.push(r.statusCode);
    }
    return codes;
  }

  for (const [label, trustProxy] of [['one trusted hop', 1], ['a CIDR covering the proxy', '127.0.0.0/8']] as const) {
    it(`with ${label}, the lockout keys on the real client IP, not a forged X-Forwarded-For (I2)`, async () => {
      t = await makeApp({ trustProxy });
      const acct = await setupAdmin(t.app);
      // The proxy appends the real client (always 203.0.113.9) after the forged value.
      const codes = await hammer(t.app, acct.username, '198.51.100.#, 203.0.113.9', 8);
      expect(codes.slice(5)).toEqual([429, 429, 429]);
      // A different real client is not locked out by that.
      const other = await hammer(t.app, acct.username, '198.51.100.1, 203.0.113.10', 1);
      expect(other).toEqual([401]);
    });
  }
});
