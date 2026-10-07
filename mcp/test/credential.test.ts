import { chmodSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deleteCredential, loadCredential, saveCredential, type Credential } from '../src/credential';

const dir = () => mkdtempSync(path.join(tmpdir(), 'inked-mcp-cred-'));
const cred: Credential = {
  version: 1,
  baseUrl: 'https://notes.example.com',
  username: 'jude',
  userId: '6f1c2c1e-0000-4000-8000-000000000001',
  masterSecret: Buffer.alloc(32, 7).toString('base64url'),
  deviceCookie: 'abc.def',
};

describe('credential', () => {
  it('round-trips', () => {
    const f = path.join(dir(), 'credential.json');
    saveCredential(cred, f);
    expect(loadCredential(f)).toEqual(cred);
  });

  it.skipIf(process.platform === 'win32')('is written user-only and refused when others can read it', () => {
    const f = path.join(dir(), 'credential.json');
    saveCredential(cred, f);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    writeFileSync(f, JSON.stringify(cred), { mode: 0o644 });
    chmodSync(f, 0o644);
    expect(() => loadCredential(f)).toThrow(/readable by other users.*chmod 600/);
  });

  it('says to log in when missing', () => {
    expect(() => loadCredential(path.join(dir(), 'none.json'))).toThrow(/No Inked credential.*inked-mcp login/);
  });

  it.each([
    ['{ truncated', 'bad JSON'],
    [JSON.stringify({ ...cred, version: 2 }), 'wrong version'],
    [JSON.stringify({ ...cred, masterSecret: Buffer.alloc(16).toString('base64url') }), 'short secret'],
    [JSON.stringify({ ...cred, baseUrl: 42 }), 'wrong type'],
  ])('reports a damaged file (%s → %s)', (content) => {
    const f = path.join(dir(), 'credential.json');
    writeFileSync(f, content, { mode: 0o600 });
    expect(() => loadCredential(f)).toThrow('Inked credential file is damaged. Run `inked-mcp login`.');
  });

  it('deletes', () => {
    const f = path.join(dir(), 'credential.json');
    saveCredential(cred, f);
    expect(deleteCredential(f)).toBe(true);
    expect(deleteCredential(f)).toBe(false);
  });
});
