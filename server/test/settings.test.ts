import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Account, call, fakeCipher, inviteUser, makeApp, setupAdmin, type TestApp } from './helpers.js';

let t: TestApp;
let alice: Account;
let bob: Account;
beforeEach(async () => {
  t = await makeApp();
  alice = await setupAdmin(t.app, 'alice');
  bob = await inviteUser(t.app, alice, 'bob');
});
afterEach(async () => {
  await t.close();
});

const get = (who: Account) => call(t.app, 'GET', '/api/me/settings', { cookie: who.cookie });
const put = (who: Account, body: unknown) => call(t.app, 'PUT', '/api/me/settings', { cookie: who.cookie, body });

describe('account settings', () => {
  it('is empty at first, then stores and returns the ciphertext', async () => {
    expect((await get(alice)).json()).toEqual({ encSettings: null, updatedAt: null });
    const ct = fakeCipher(200);
    const r = await put(alice, { encSettings: ct, baseUpdatedAt: null });
    expect(r.statusCode).toBe(200);
    const { updatedAt } = r.json();
    expect((await get(alice)).json()).toEqual({ encSettings: ct, updatedAt });
  });
  it('is per user', async () => {
    await put(alice, { encSettings: fakeCipher(), baseUpdatedAt: null });
    expect((await get(bob)).json()).toEqual({ encSettings: null, updatedAt: null });
  });
  it('answers 409 with the current row on a stale base', async () => {
    const first = (await put(alice, { encSettings: fakeCipher(), baseUpdatedAt: null })).json().updatedAt;
    const second = await put(alice, { encSettings: fakeCipher(), baseUpdatedAt: first });
    expect(second.statusCode).toBe(200);
    const stale = await put(alice, { encSettings: fakeCipher(), baseUpdatedAt: first });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'conflict', updatedAt: second.json().updatedAt });
    const fresh = await put(alice, { encSettings: fakeCipher(), baseUpdatedAt: null });
    expect(fresh.statusCode).toBe(409);
  });
  it('rejects a too-large or malformed value and requires sign-in', async () => {
    expect((await put(alice, { encSettings: fakeCipher(4000), baseUpdatedAt: null })).statusCode).toBe(400);
    expect((await put(alice, { encSettings: 'plain', baseUpdatedAt: null })).statusCode).toBe(400);
    expect((await call(t.app, 'GET', '/api/me/settings', {})).statusCode).toBe(401);
  });
  it('is deleted with the user', async () => {
    await put(bob, { encSettings: fakeCipher(), baseUpdatedAt: null });
    t.app.db.prepare('DELETE FROM users WHERE id = ?').run(bob.userId);
    expect(t.app.db.prepare('SELECT COUNT(*) AS n FROM user_settings').get()).toEqual({ n: 0 });
  });
});
