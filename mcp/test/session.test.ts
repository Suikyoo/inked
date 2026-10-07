import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CredentialStale } from '../src/errors';
import { createCredential, Session } from '../src/session';
import { addVault, changePassword, seedUser, startInked } from './helpers/inked';

const PW = 'correct horse battery';

describe('Session', () => {
  let srv: Awaited<ReturnType<typeof startInked>>;
  beforeAll(async () => {
    srv = await startInked();
    await seedUser(srv.baseUrl, 'jude', PW);
    await addVault(srv.baseUrl, 'jude', PW, 'Work');
  });
  afterAll(() => srv.close());

  it('createCredential stores the master secret, not the password, and a device cookie', async () => {
    const cred = await createCredential({ baseUrl: srv.baseUrl + '/', username: 'Jude', password: PW });
    expect(cred.baseUrl).toBe(srv.baseUrl);
    expect(cred.username).toBe('jude');
    expect(JSON.stringify(cred)).not.toContain(PW);
    expect(Buffer.from(cred.masterSecret, 'base64url').length).toBe(32);
    expect(cred.deviceCookie).toBeTruthy();
  });

  it('createCredential rejects a wrong password with ApiError 401', async () => {
    await expect(createCredential({ baseUrl: srv.baseUrl, username: 'jude', password: 'wrong password!' })).rejects.toMatchObject({
      status: 401,
    });
  });

  it('starts from a credential and unwraps vault keys', async () => {
    const s = new Session(await createCredential({ baseUrl: srv.baseUrl, username: 'jude', password: PW }));
    await s.start();
    const { vaults } = await s.call(() => s.api.listVaults());
    await expect(s.vaultKey(vaults[0])).resolves.toBeDefined();
    await s.close();
  });

  it('re-logs in exactly once for several parallel 401s', async () => {
    const s = new Session(await createCredential({ baseUrl: srv.baseUrl, username: 'jude', password: PW }));
    await s.start();
    await s.api.logout(); // the server forgets this session; the next calls get 401
    let logins = 0;
    const realLogin = s.api.login.bind(s.api);
    s.api.login = async (u, k) => {
      logins++;
      return realLogin(u, k);
    };
    const results = await Promise.all([1, 2, 3, 4].map(() => s.call(() => s.api.listVaults())));
    expect(results).toHaveLength(4);
    expect(logins).toBe(1);
    await s.close();
  });

  it('reports a stale credential after a password change', async () => {
    const cred = await createCredential({ baseUrl: srv.baseUrl, username: 'jude', password: PW });
    await changePassword(srv.baseUrl, 'jude', PW, 'a brand new password');
    await expect(new Session(cred).start()).rejects.toBeInstanceOf(CredentialStale);
    await changePassword(srv.baseUrl, 'jude', 'a brand new password', PW); // restore for other tests
  });
});
