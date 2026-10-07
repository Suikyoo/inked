import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertKdfParams, deriveFromPassword } from 'inked-core';
import { InkedApi, normalizeBaseUrl } from '../src/api';
import { ApiError, NonApiResponse } from '../src/errors';
import { seedUser, startInked } from './helpers/inked';

describe('normalizeBaseUrl', () => {
  it.each([
    ['https://notes.example.com/', 'https://notes.example.com'],
    ['https://notes.example.com/inked//', 'https://notes.example.com/inked'],
    ['  https://notes.example.com  ', 'https://notes.example.com'],
    ['http://localhost:8088', 'http://localhost:8088'],
    ['http://127.0.0.1:8088/', 'http://127.0.0.1:8088'],
    ['http://[::1]:8088', 'http://[::1]:8088'],
  ])('%s → %s', (input, out) => expect(normalizeBaseUrl(input)).toBe(out));

  it.each([
    ['http://notes.example.com', /https/],
    ['https://notes.example.com/?x=1', /query/],
    ['https://notes.example.com/#top', /query/],
    ['notes.example.com', /Not a URL/],
    ['ftp://notes.example.com', /https/],
  ])('rejects %s', (input, msg) => expect(() => normalizeBaseUrl(input)).toThrow(msg));
});

describe('InkedApi against the real server', () => {
  let srv: Awaited<ReturnType<typeof startInked>>;
  beforeAll(async () => {
    srv = await startInked();
    await seedUser(srv.baseUrl, 'jude', 'correct horse battery');
  });
  afterAll(() => srv.close());

  it('signs in, keeps the session cookie, sends X-Inked-User, and stores the device cookie', async () => {
    const api = new InkedApi(srv.baseUrl);
    const { kdfSalt, kdfParams } = await api.params('jude');
    const keys = await deriveFromPassword('correct horse battery', kdfSalt, assertKdfParams(kdfParams));
    const { user } = await api.login('jude', keys.authKey);
    expect(api.userId).toBe(user.id);
    expect(api.deviceCookie).toMatch(/\./);
    const { vaults } = await api.listVaults();
    expect(Array.isArray(vaults)).toBe(true);
    await api.logout();
    await expect(api.listVaults()).rejects.toMatchObject({ status: 401 });
  });

  it('maps a wrong authKey to ApiError 401', async () => {
    const api = new InkedApi(srv.baseUrl);
    await expect(api.login('jude', Buffer.alloc(32).toString('base64url'))).rejects.toBeInstanceOf(ApiError);
  });
});

describe('InkedApi against odd responses', () => {
  const fake = (res: Response) => (async () => res) as unknown as typeof fetch;

  it('reports an HTML page as NonApiResponse', async () => {
    const api = new InkedApi('https://x.example', {
      fetch: fake(new Response('<html>challenge</html>', { status: 403, headers: { 'content-type': 'text/html' } })),
    });
    await expect(api.listVaults()).rejects.toBeInstanceOf(NonApiResponse);
  });

  it('reports a redirect as NonApiResponse', async () => {
    const api = new InkedApi('https://x.example', {
      fetch: fake(new Response(null, { status: 302, headers: { location: 'https://login.example' } })),
    });
    await expect(api.listVaults()).rejects.toBeInstanceOf(NonApiResponse);
  });

  it('reports a network failure as ApiError status 0', async () => {
    const api = new InkedApi('https://x.example', {
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    await expect(api.listVaults()).rejects.toMatchObject({ status: 0, code: 'network' });
  });
});
