import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const HASH_BYTES = 32;

function scryptAsync(secret: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, HASH_BYTES, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export const randomToken = (bytes: number): string => randomBytes(bytes).toString('base64url');

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface SecretHash {
  salt: string;
  hash: string;
}

/** scrypt-hash a client-derived key (base64url, e.g. authKey or recoveryAuth) with a fresh per-user salt. */
export async function hashSecret(secretB64: string): Promise<SecretHash> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(Buffer.from(secretB64, 'base64url'), salt);
  return { salt: salt.toString('base64url'), hash: hash.toString('base64url') };
}

export async function verifySecret(secretB64: string, stored: SecretHash): Promise<boolean> {
  const expected = Buffer.from(stored.hash, 'base64url');
  const actual = await scryptAsync(Buffer.from(secretB64, 'base64url'), Buffer.from(stored.salt, 'base64url'));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Spend the same scrypt work as a real verification, so unknown users are not faster to reject. */
export async function burnScrypt(secretB64: string): Promise<void> {
  await scryptAsync(Buffer.from(secretB64, 'base64url'), randomBytes(16));
}

/** Stable fake kdfSalt (16 bytes, same encoding as real salts) for unknown usernames. */
export function fakeKdfSalt(serverSecret: Buffer, username: string): string {
  return createHmac('sha256', serverSecret).update(`salt:${username}`).digest().subarray(0, 16).toString('base64url');
}

/** Loads DATA_DIR/server-secret, creating the directory and a 32-byte secret (mode 0600) on first boot. */
export function loadServerSecret(dataDir: string): Buffer {
  mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'server-secret');
  try {
    writeFileSync(file, randomBytes(32), { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const secret = readFileSync(file);
  if (secret.length !== 32) throw new Error(`${file} must contain exactly 32 bytes`);
  return secret;
}
