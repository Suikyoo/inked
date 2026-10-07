import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { fromBase64Url } from 'inked-core';
import { credentialPath } from './home';

/**
 * What `inked-mcp login` saves. `masterSecret` is account-equivalent for reading and writing data
 * (it derives authKey and passwordKEK) but cannot reveal the password; it dies on a password change.
 */
export interface Credential {
  version: 1;
  baseUrl: string;
  username: string;
  userId: string;
  masterSecret: string;
  deviceCookie: string | null;
}

const DAMAGED = 'Inked credential file is damaged. Run `inked-mcp login`.';

/** On Windows, mode bits do nothing: replace the file's ACL with full control for this user only. */
function restrictWindowsAcl(file: string): void {
  const domain = process.env.USERDOMAIN;
  const user = domain ? `${domain}\\${userInfo().username}` : userInfo().username;
  execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' });
}

export function saveCredential(c: Credential, file = credentialPath()): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600); // an existing file keeps its old mode through writeFileSync
  if (process.platform === 'win32') restrictWindowsAcl(file);
}

function isCredential(v: unknown): v is Credential {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.version !== 1) return false;
  for (const k of ['baseUrl', 'username', 'userId', 'masterSecret']) if (typeof o[k] !== 'string') return false;
  if (o.deviceCookie !== null && typeof o.deviceCookie !== 'string') return false;
  try {
    return fromBase64Url(o.masterSecret as string).length === 32;
  } catch {
    return false;
  }
}

export function loadCredential(file = credentialPath()): Credential {
  if (!existsSync(file)) throw new Error('No Inked credential. Run `inked-mcp login` first.');
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0) {
    throw new Error(`Credential file ${file} is readable by other users. Run: chmod 600 "${file}"`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(DAMAGED);
  }
  if (!isCredential(raw)) throw new Error(DAMAGED);
  return raw;
}

export function deleteCredential(file = credentialPath()): boolean {
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
