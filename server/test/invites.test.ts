import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Account, call, inviteUser, makeApp, registerBody, setupAdmin, type TestApp } from './helpers.js';

let t: TestApp;
let admin: Account;
beforeEach(async () => {
  t = await makeApp();
  admin = await setupAdmin(t.app);
});
afterEach(async () => {
  await t.close();
});

const createInvite = async (body: unknown = {}) => {
  const res = await call(t.app, 'POST', '/api/invites', { cookie: admin.cookie, body });
  expect(res.statusCode).toBe(200);
  return res.json() as { token: string; expiresAt: string };
};

const check = async (token: string) =>
  (await call(t.app, 'GET', `/api/invites/check?token=${encodeURIComponent(token)}`)).json().valid as boolean;

describe('invites', () => {
  it('creates an invite with a 72h default expiry', async () => {
    const before = Date.now();
    const invite = await createInvite();
    expect(invite.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const hours = (Date.parse(invite.expiresAt) - before) / 3600_000;
    expect(hours).toBeGreaterThan(71.9);
    expect(hours).toBeLessThan(72.1);

    const custom = await createInvite({ expiresInHours: 1 });
    expect(Date.parse(custom.expiresAt) - before).toBeLessThan(3600_000 + 5000);
  });

  it('accepts a POST without a body', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { 'x-inked': '1', cookie: `inked_session=${admin.cookie}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('check, register, consume', async () => {
    const invite = await createInvite();
    expect(await check(invite.token)).toBe(true);
    expect(await check('not-a-real-token')).toBe(false);

    const body = { ...registerBody('Bob'), inviteToken: invite.token };
    const res = await call(t.app, 'POST', '/api/auth/register', { body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: body.userId, username: 'bob', isAdmin: false } });
    expect(res.cookies.some((c) => c.name === 'inked_session')).toBe(true);

    expect(await check(invite.token)).toBe(false);
    const reuse = await call(t.app, 'POST', '/api/auth/register', {
      body: { ...registerBody('carol'), inviteToken: invite.token },
    });
    expect(reuse.statusCode).toBe(403);
    expect(reuse.json().error).toBe('invalid_invite');

    const list = (await call(t.app, 'GET', '/api/invites', { cookie: admin.cookie })).json().invites;
    expect(list).toHaveLength(1);
    expect(list[0].usedBy).toBe('bob');
    expect(typeof list[0].usedAt).toBe('string');
  });

  it('rejects expired invites', async () => {
    const invite = await createInvite();
    t.app.db.prepare('UPDATE invites SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    expect(await check(invite.token)).toBe(false);
    const res = await call(t.app, 'POST', '/api/auth/register', {
      body: { ...registerBody('bob'), inviteToken: invite.token },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('invalid_invite');
  });

  it('lists unused invites without usedBy and deletes them', async () => {
    const invite = await createInvite();
    const list = (await call(t.app, 'GET', '/api/invites', { cookie: admin.cookie })).json().invites;
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(['createdAt', 'expiresAt', 'id']);

    const del = await call(t.app, 'DELETE', `/api/invites/${list[0].id}`, { cookie: admin.cookie });
    expect(del.json()).toEqual({ ok: true });
    expect(await check(invite.token)).toBe(false);
    expect((await call(t.app, 'DELETE', `/api/invites/${list[0].id}`, { cookie: admin.cookie })).statusCode).toBe(404);
    expect((await call(t.app, 'DELETE', `/api/invites/${randomUUID()}`, { cookie: admin.cookie })).statusCode).toBe(404);
  });

  it('rejects a taken username', async () => {
    await inviteUser(t.app, admin, 'bob');
    const invite = await createInvite();
    const res = await call(t.app, 'POST', '/api/auth/register', {
      body: { ...registerBody('BOB'), inviteToken: invite.token },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('username_taken');
    // The invite was not consumed by the failed attempt.
    expect(await check(invite.token)).toBe(true);
  });

  it('requires an invite token to register', async () => {
    const res = await call(t.app, 'POST', '/api/auth/register', { body: registerBody('bob') });
    expect(res.statusCode).toBe(400);
  });

  it('is admin only', async () => {
    const bob = await inviteUser(t.app, admin, 'bob');
    expect((await call(t.app, 'POST', '/api/invites', { cookie: bob.cookie, body: {} })).statusCode).toBe(403);
    expect((await call(t.app, 'GET', '/api/invites', { cookie: bob.cookie })).statusCode).toBe(403);
    expect((await call(t.app, 'GET', '/api/invites')).statusCode).toBe(401);
  });
});
