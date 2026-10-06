import { argon2id } from 'hash-wasm';
import { HKDF_INFO } from './aad';
import { fromBase64Url, randomBytes, toBase64Url, utf8, wipe, type Bytes } from './encoding';
import { CryptoError } from './errors';

export interface KdfParams {
  alg: 'argon2id';
  m: number; // memory in KiB
  t: number; // iterations
  p: number; // parallelism
}

export const DEFAULT_KDF_PARAMS: Readonly<KdfParams> = Object.freeze({ alg: 'argon2id', m: 65536, t: 3, p: 1 });

/** Lowest work factor the client will accept from a server. Independent of the defaults used for new accounts. */
export const MIN_KDF_PARAMS: KdfParams = Object.freeze({ alg: 'argon2id', m: 65536, t: 3, p: 1 });

/** Raw Argon2id returning 32 bytes. Injectable so the app can run it in a Web Worker. */
export type Argon2Fn = (password: Bytes, salt: Bytes, params: KdfParams) => Promise<Bytes>;

export const argon2Direct: Argon2Fn = async (password, salt, params) => {
  const out = await argon2id({
    password,
    salt,
    parallelism: params.p,
    iterations: params.t,
    memorySize: params.m,
    hashLength: 32,
    outputType: 'binary',
  });
  return new Uint8Array(out);
};

export function generateKdfSalt(): string {
  return toBase64Url(randomBytes(16));
}

/**
 * Validates KDF params received from the server. A hostile server must not be able to
 * downgrade the work factor, or make the browser allocate absurd amounts of memory.
 */
export function assertKdfParams(p: unknown, floor: KdfParams = MIN_KDF_PARAMS): KdfParams {
  const o = p as Partial<KdfParams> | null;
  const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
  if (
    !o ||
    o.alg !== 'argon2id' ||
    !int(o.m) ||
    !int(o.t) ||
    !int(o.p) ||
    o.m < floor.m ||
    o.t < floor.t ||
    o.p < 1 ||
    o.m > 1048576 ||
    o.t > 16 ||
    o.p > 8
  ) {
    throw new CryptoError('params', 'Unacceptable key derivation parameters');
  }
  return { alg: 'argon2id', m: o.m, t: o.t, p: o.p };
}

/** Passwords are NFC-normalised so the same password typed on different systems derives the same key. */
export function encodePassword(password: string): Bytes {
  return utf8(password.normalize('NFC'));
}

export async function importHkdfBase(ikm: Bytes): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits', 'deriveKey']);
}

function hkdfParams(info: string): HkdfParams {
  return { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) };
}

export async function hkdfBytes(base: CryptoKey, info: string, length = 32): Promise<Bytes> {
  const bits = await globalThis.crypto.subtle.deriveBits(hkdfParams(info), base, length * 8);
  return new Uint8Array(bits);
}

/** Derives a non-extractable AES-GCM-256 key-encryption key (wrapKey/unwrapKey only). */
export async function hkdfKek(base: CryptoKey, info: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.deriveKey(hkdfParams(info), base, { name: 'AES-GCM', length: 256 }, false, [
    'wrapKey',
    'unwrapKey',
  ]);
}

export interface PasswordKeys {
  /** base64url; sent to the server, which stores only an scrypt hash of it. */
  authKey: string;
  /** Non-extractable; wraps and unwraps the userKey. */
  passwordKEK: CryptoKey;
}

export async function deriveFromPassword(
  password: string,
  kdfSalt: string,
  params: KdfParams,
  opts: { argon2?: Argon2Fn } = {},
): Promise<PasswordKeys> {
  const salt = fromBase64Url(kdfSalt);
  if (salt.length < 16) throw new CryptoError('params', 'Salt too short');
  const pw = encodePassword(password);
  let master: Bytes | null = null;
  try {
    master = await (opts.argon2 ?? argon2Direct)(pw, salt, params);
    if (master.length !== 32) throw new CryptoError('params', 'Argon2 output must be 32 bytes');
    const base = await importHkdfBase(master);
    const authBytes = await hkdfBytes(base, HKDF_INFO.auth);
    const authKey = toBase64Url(authBytes);
    wipe(authBytes);
    const passwordKEK = await hkdfKek(base, HKDF_INFO.wrap);
    return { authKey, passwordKEK };
  } finally {
    wipe(pw);
    wipe(master);
  }
}
