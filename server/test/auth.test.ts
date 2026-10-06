import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cryptoMod from '../src/crypto.js';
import { type Account, call, fakeCipher, key32, makeApp, registerBody, sessionCookie, setupAdmin, setupBody, TEST_SETUP_TOKEN, type TestApp } from './helpers.js';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
});
afterEach(async () => {
  await t.close();
});

describe('setup', () => {
  it('reports needsSetup until the first user exists', async () => {
    expect((await call(t.app, 'GET', '/api/status')).json()).toEqual({ needsSetup: true });
    await setupAdmin(t.app);
    expect((await call(t.app, 'GET', '/api/status')).json()).toEqual({ needsSetup: false });
  });

  it('creates an admin, sets a session cookie and lowercases the username', async () => {
    const body = setupBody('Alice.Admin');
    const res = await call(t.app, 'POST', '/api/setup', { body });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: body.userId, username: 'alice.admin', isAdmin: true } });
    const cookie = res.cookies.find((c) => c.name === 'inked_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    expect(cookie.path).toBe('/');
    expect(cookie.secure).toBeFalsy();
  });

  it('only works once', async () => {
    await setupAdmin(t.app);
    const res = await call(t.app, 'POST', '/api/setup', { body: setupBody('second') });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('already_setup');
  });

  it('validates the body', async () => {
    const bad = [
      { ...setupBody('ab') }, // too short
      { ...setupBody('has space') },
      { ...setupBody('valid'), userId: 'not-a-uuid' },
      { ...setupBody('valid'), wrappedUserKey: 'v2.abc' },
      { ...setupBody('valid'), authKey: 'short' },
      { ...setupBody('valid'), kdfParams: { alg: 'pbkdf2', m: 65536, t: 3, p: 1 } },
    ];
    for (const body of bad) {
      const res = await call(t.app, 'POST', '/api/setup', { body });
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error).toBe('invalid_request');
    }
  });
});

describe('setup hardening', () => {
  it('setup requires the one-time setup token (M8)', async () => {
    const body = registerBody('admin');
    const bad = await call(t.app, 'POST', '/api/setup', { body: { ...body, setupToken: 'nope-nope-nope' } });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error).toBe('invalid_setup_token');
    const missing = await call(t.app, 'POST', '/api/setup', { body });
    expect(missing.statusCode).toBe(400);
    const ok = await call(t.app, 'POST', '/api/setup', { body: { ...body, setupToken: TEST_SETUP_TOKEN } });
    expect(ok.statusCode).toBe(200);
  });

  it('rejects weak kdf params (M5)', async () => {
    const weak = [
      { alg: 'argon2id', m: 19456, t: 2, p: 1 },
      { alg: 'argon2id', m: 65536, t: 2, p: 1 },
      { alg: 'argon2id', m: 65536, t: 3, p: 9 },
      { alg: 'argon2id', m: 2097152, t: 3, p: 1 },
    ];
    for (const kdfParams of weak) {
      const r = await call(t.app, 'POST', '/api/setup', { body: { ...setupBody('admin'), kdfParams } });
      expect(r.statusCode, JSON.stringify(kdfParams)).toBe(400);
    }
  });

  it('register with a bad invite fails before any scrypt hashing (M4)', async () => {
    const admin = await setupAdmin(t.app);
    const spy = vi.spyOn(cryptoMod, 'hashSecret');
    try {
      for (let i = 0; i < 10; i++) {
        const r = await call(t.app, 'POST', '/api/auth/register', {
          body: { ...registerBody(`u${i}xx`), inviteToken: 'x'.repeat(32) },
        });
        expect(r.statusCode).toBe(403);
        expect(r.json().error).toBe('invalid_invite');
      }
      expect(spy).not.toHaveBeenCalled();
      // Control: a valid invite does hash, so the spy really observes the register path.
      const invite = await call(t.app, 'POST', '/api/invites', { cookie: admin.cookie, body: {} });
      const ok = await call(t.app, 'POST', '/api/auth/register', {
        body: { ...registerBody('good'), inviteToken: invite.json().token },
      });
      expect(ok.statusCode).toBe(200);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('login', () => {
  let admin: Account;
  beforeEach(async () => {
    admin = await setupAdmin(t.app, 'admin');
  });

  it('succeeds with the right authKey and returns the wrapped user key', async () => {
    const res = await call(t.app, 'POST', '/api/auth/login', { body: { username: 'ADMIN', authKey: admin.authKey } });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.user).toEqual({ id: admin.userId, username: 'admin', isAdmin: true });
    expect(json.wrappedUserKey).toMatch(/^v1\./);

    const me = await call(t.app, 'GET', '/api/me', { cookie: sessionCookie(res) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(json);
  });

  it('fails identically for a wrong key and an unknown user', async () => {
    const wrong = await call(t.app, 'POST', '/api/auth/login', { body: { username: 'admin', authKey: key32() } });
    const unknown = await call(t.app, 'POST', '/api/auth/login', { body: { username: 'nobody', authKey: key32() } });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.json().error).toBe('invalid_credentials');
  });

  it('locks out an (ip, username) pair after 5 failures', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await call(t.app, 'POST', '/api/auth/login', {
        body: { username: 'admin', authKey: key32() },
        ip: '10.0.0.1',
      });
      expect(res.statusCode).toBe(401);
    }
    // Even the right key is refused while locked.
    const locked = await call(t.app, 'POST', '/api/auth/login', {
      body: { username: 'admin', authKey: admin.authKey },
      ip: '10.0.0.1',
    });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toBe('locked');
    expect(locked.json().retryAfter).toBeGreaterThan(0);
    expect(locked.json().retryAfter).toBeLessThanOrEqual(60);
    expect(locked.headers['retry-after']).toBe(String(locked.json().retryAfter));

    // A different IP is unaffected.
    const other = await call(t.app, 'POST', '/api/auth/login', {
      body: { username: 'admin', authKey: admin.authKey },
      ip: '10.0.0.2',
    });
    expect(other.statusCode).toBe(200);
  });

  it('locks out a parallel burst of wrong logins (I1)', async () => {
    const responses = await Promise.all(
      Array.from({ length: 40 }, () =>
        call(t.app, 'POST', '/api/auth/login', { body: { username: 'admin', authKey: key32() } }),
      ),
    );
    const codes = responses.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(5);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(35);
  });

  const login = (authKey: string, ip: string) =>
    call(t.app, 'POST', '/api/auth/login', { body: { username: 'admin', authKey }, ip });

  it('caps an account across many IPs', async () => {
    for (let i = 0; i < 30; i++) expect((await login(key32(), `10.1.0.${i}`)).statusCode).toBe(401);
    expect((await login(admin.authKey, '10.2.0.1')).statusCode).toBe(429);
  });

  it('does not spend the account budget on requests the per-IP limiter rejects', async () => {
    for (let i = 0; i < 5; i++) expect((await login(key32(), '10.3.0.1')).statusCode).toBe(401);
    for (let i = 0; i < 40; i++) expect((await login(key32(), '10.3.0.1')).statusCode).toBe(429);
    // 5 of 30 spent; exactly 25 remain for other IPs.
    for (let i = 0; i < 25; i++) expect((await login(key32(), `10.4.0.${i}`)).statusCode).toBe(401);
    expect((await login(admin.authKey, '10.5.0.1')).statusCode).toBe(429);
  });

  it('resets both limiters on a successful login', async () => {
    for (let i = 0; i < 4; i++) await login(key32(), '10.6.0.1');
    expect((await login(admin.authKey, '10.6.0.1')).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login(key32(), '10.6.0.1')).statusCode).toBe(401);

    for (let i = 0; i < 20; i++) await login(key32(), `10.7.0.${i}`);
    expect((await login(admin.authKey, '10.8.0.1')).statusCode).toBe(200);
    for (let i = 0; i < 25; i++) expect((await login(key32(), `10.9.0.${i}`)).statusCode).toBe(401);
  });

  it('logout ends the session', async () => {
    const out = await call(t.app, 'POST', '/api/auth/logout', { cookie: admin.cookie });
    expect(out.json()).toEqual({ ok: true });
    expect((await call(t.app, 'GET', '/api/me', { cookie: admin.cookie })).statusCode).toBe(401);
  });

  it('requires a session for /api/me', async () => {
    const res = await call(t.app, 'GET', '/api/me');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
    expect((await call(t.app, 'GET', '/api/me', { cookie: 'garbage' })).statusCode).toBe(401);
  });
});

describe('auth params', () => {
  it('returns the stored salt for a real user', async () => {
    const body = setupBody('alice');
    await call(t.app, 'POST', '/api/setup', { body });
    const res = await call(t.app, 'GET', '/api/auth/params?username=Alice');
    expect(res.json()).toEqual({ kdfSalt: body.kdfSalt, kdfParams: body.kdfParams });
  });

  it('returns a stable fake salt for unknown users, shaped like a real one', async () => {
    const body = setupBody('alice');
    await call(t.app, 'POST', '/api/setup', { body });
    const real = (await call(t.app, 'GET', '/api/auth/params?username=alice')).json();
    const fake1 = await call(t.app, 'GET', '/api/auth/params?username=mallory');
    const fake2 = await call(t.app, 'GET', '/api/auth/params?username=mallory');
    const other = (await call(t.app, 'GET', '/api/auth/params?username=trent')).json();

    expect(fake1.statusCode).toBe(200);
    expect(fake1.json()).toEqual(fake2.json());
    expect(other.kdfSalt).not.toBe(fake1.json().kdfSalt);
    expect(Object.keys(fake1.json())).toEqual(Object.keys(real));
    expect(fake1.json().kdfSalt).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(fake1.json().kdfSalt.length).toBe(real.kdfSalt.length);
    expect(JSON.stringify(fake1.json().kdfParams)).toBe(JSON.stringify(real.kdfParams));
  });

  it('rejects malformed usernames', async () => {
    expect((await call(t.app, 'GET', '/api/auth/params?username=a b')).statusCode).toBe(400);
    expect((await call(t.app, 'GET', '/api/auth/params')).statusCode).toBe(400);
  });
});

describe('password change', () => {
  it('replaces the authKey and signs out other sessions', async () => {
    const admin = await setupAdmin(t.app);
    const other = sessionCookie(
      await call(t.app, 'POST', '/api/auth/login', { body: { username: admin.username, authKey: admin.authKey } }),
    );
    const next = registerBody(admin.username);

    const wrong = await call(t.app, 'POST', '/api/auth/password', {
      cookie: admin.cookie,
      body: { currentAuthKey: key32(), kdfSalt: next.kdfSalt, kdfParams: next.kdfParams, authKey: next.authKey, wrappedUserKey: next.wrappedUserKey },
    });
    expect(wrong.statusCode).toBe(403);

    const ok = await call(t.app, 'POST', '/api/auth/password', {
      cookie: admin.cookie,
      body: { currentAuthKey: admin.authKey, kdfSalt: next.kdfSalt, kdfParams: next.kdfParams, authKey: next.authKey, wrappedUserKey: next.wrappedUserKey },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });

    const oldLogin = await call(t.app, 'POST', '/api/auth/login', { body: { username: admin.username, authKey: admin.authKey } });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await call(t.app, 'POST', '/api/auth/login', { body: { username: admin.username, authKey: next.authKey } });
    expect(newLogin.statusCode).toBe(200);
    expect(newLogin.json().wrappedUserKey).toBe(next.wrappedUserKey);

    const params = (await call(t.app, 'GET', `/api/auth/params?username=${admin.username}`)).json();
    expect(params.kdfSalt).toBe(next.kdfSalt);

    expect((await call(t.app, 'GET', '/api/me', { cookie: admin.cookie })).statusCode).toBe(200);
    expect((await call(t.app, 'GET', '/api/me', { cookie: other })).statusCode).toBe(401);
  });

  it('requires a session', async () => {
    await setupAdmin(t.app);
    const res = await call(t.app, 'POST', '/api/auth/password', { body: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('recovery key rotation', () => {
  it('rotates the recovery key; the old one stops working', async () => {
    const admin = await setupAdmin(t.app);
    const newAuth = key32();
    const newWrapped = fakeCipher();

    const bad = await call(t.app, 'POST', '/api/auth/recovery-key', {
      cookie: admin.cookie,
      body: { currentAuthKey: key32(), recoveryAuth: newAuth, wrappedUserKeyRecovery: newWrapped },
    });
    expect(bad.statusCode).toBe(403);

    const ok = await call(t.app, 'POST', '/api/auth/recovery-key', {
      cookie: admin.cookie,
      body: { currentAuthKey: admin.authKey, recoveryAuth: newAuth, wrappedUserKeyRecovery: newWrapped },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });

    const old = await call(t.app, 'POST', '/api/auth/recover/start', { body: { username: admin.username, recoveryAuth: admin.recoveryAuth } });
    expect(old.statusCode).toBe(401);
    const fresh = await call(t.app, 'POST', '/api/auth/recover/start', { body: { username: admin.username, recoveryAuth: newAuth } });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().wrappedUserKeyRecovery).toBe(newWrapped);
  });

  it('requires a session', async () => {
    await setupAdmin(t.app);
    const res = await call(t.app, 'POST', '/api/auth/recovery-key', { body: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('recovery', () => {
  it('start returns the recovery-wrapped key only for a valid proof', async () => {
    const body = setupBody('alice');
    await call(t.app, 'POST', '/api/setup', { body });

    const bad = await call(t.app, 'POST', '/api/auth/recover/start', { body: { username: 'alice', recoveryAuth: key32() } });
    const unknown = await call(t.app, 'POST', '/api/auth/recover/start', { body: { username: 'bob', recoveryAuth: key32() } });
    expect(bad.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(bad.json()).toEqual(unknown.json());

    const ok = await call(t.app, 'POST', '/api/auth/recover/start', { body: { username: 'alice', recoveryAuth: body.recoveryAuth } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ userId: body.userId, wrappedUserKeyRecovery: body.wrappedUserKeyRecovery });
  });

  it('finish sets a new password, ends old sessions and starts a new one', async () => {
    const body = setupBody('alice');
    const setup = await call(t.app, 'POST', '/api/setup', { body });
    const oldCookie = sessionCookie(setup);
    const next = registerBody('alice');
    const finishBody = {
      username: 'alice',
      kdfSalt: next.kdfSalt,
      kdfParams: next.kdfParams,
      authKey: next.authKey,
      wrappedUserKey: next.wrappedUserKey,
    };

    const bad = await call(t.app, 'POST', '/api/auth/recover/finish', { body: { ...finishBody, recoveryAuth: key32() } });
    expect(bad.statusCode).toBe(401);

    const ok = await call(t.app, 'POST', '/api/auth/recover/finish', {
      body: { ...finishBody, recoveryAuth: body.recoveryAuth },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      user: { id: body.userId, username: 'alice', isAdmin: true },
      wrappedUserKey: next.wrappedUserKey,
    });
    expect((await call(t.app, 'GET', '/api/me', { cookie: sessionCookie(ok) })).statusCode).toBe(200);
    expect((await call(t.app, 'GET', '/api/me', { cookie: oldCookie })).statusCode).toBe(401);

    const oldLogin = await call(t.app, 'POST', '/api/auth/login', { body: { username: 'alice', authKey: body.authKey } });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await call(t.app, 'POST', '/api/auth/login', { body: { username: 'alice', authKey: next.authKey } });
    expect(newLogin.statusCode).toBe(200);
  });
});
