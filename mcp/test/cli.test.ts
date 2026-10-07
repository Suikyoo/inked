import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../src/cli';
import { addVault, changePassword, seedUser, startInked } from './helpers/inked';

const PW = 'correct horse battery';

function fakeIO(answers: string[], password: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    ask: async () => answers.shift() ?? '',
    askHidden: async () => password,
  };
  return { io, out, err };
}

describe('inked-mcp CLI', () => {
  let srv: Awaited<ReturnType<typeof startInked>>;
  let home: string;
  beforeAll(async () => {
    srv = await startInked();
    await seedUser(srv.baseUrl, 'jude', PW);
    await addVault(srv.baseUrl, 'jude', PW, 'Work');
  });
  afterAll(() => srv.close());
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'inked-cli-'));
    process.env.INKED_MCP_HOME = home;
  });

  it('login saves a credential without the password; status prints the resolved policy', async () => {
    const a = fakeIO([srv.baseUrl, 'jude'], PW);
    expect(await main(['login'], a.io)).toBe(0);
    const saved = readFileSync(path.join(home, 'credential.json'), 'utf8');
    expect(saved).not.toContain(PW);
    const s = fakeIO([], '');
    expect(await main(['status'], s.io)).toBe(0);
    const text = s.out.join('\n');
    expect(text).toContain(`Signed in as jude at ${srv.baseUrl}`);
    expect(text).toContain('Vaults: all (*)');
    expect(text).toContain('Actions: note.read, search, tree.read, vault.list');
    expect(text).toContain('Writes per minute: 120');
  });

  it('login reports a wrong password without saving', async () => {
    const a = fakeIO([srv.baseUrl, 'jude'], 'not the password');
    expect(await main(['login'], a.io)).toBe(1);
    expect(a.err.join('\n')).toContain('Wrong username or password.');
    expect(existsSync(path.join(home, 'credential.json'))).toBe(false);
  });

  it('status and serve stop with a clear error on a bad config', async () => {
    await main(['login'], fakeIO([srv.baseUrl, 'jude'], PW).io);
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, vaults: ['Nope'], actions: ['@read'] }));
    const s = fakeIO([], '');
    expect(await main(['status'], s.io)).toBe(1);
    expect(s.err.join('\n')).toContain('Vault "Nope" not found');
    const v = fakeIO([], '');
    expect(await main(['serve'], v.io, { connect: async () => undefined })).toBe(1);
  });

  it('serve reports a stale credential after a password change', async () => {
    await main(['login'], fakeIO([srv.baseUrl, 'jude'], PW).io);
    await changePassword(srv.baseUrl, 'jude', PW, 'another password here');
    const v = fakeIO([], '');
    expect(await main(['serve'], v.io, { connect: async () => undefined })).toBe(1);
    expect(v.err.join('\n')).toContain('Inked credential is stale (password changed?). Run `inked-mcp login`.');
    await changePassword(srv.baseUrl, 'jude', 'another password here', PW);
  });

  it('logout deletes the credential and explains revocation', async () => {
    await main(['login'], fakeIO([srv.baseUrl, 'jude'], PW).io);
    const l = fakeIO([], '');
    expect(await main(['logout'], l.io)).toBe(0);
    expect(existsSync(path.join(home, 'credential.json'))).toBe(false);
    expect(l.out.join('\n')).toContain('change your Inked password');
  });

  it('login refuses plain http to a public host with a readable message', async () => {
    const a = fakeIO(['http://notes.example.com', 'jude'], PW);
    expect(await main(['login'], a.io)).toBe(1);
    expect(a.err.join('\n')).toContain('must use https://');
  });

  it('prints usage for an unknown command', async () => {
    const u = fakeIO([], '');
    expect(await main(['frobnicate'], u.io)).toBe(2);
    expect(u.err.join('\n')).toContain('Usage: inked-mcp');
  });
});
