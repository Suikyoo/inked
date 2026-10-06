import { aad } from './aad';
import { packCiphertext, unpackCiphertext, IV_BYTES } from './cipher';
import { randomBytes, utf8 } from './encoding';
import { CryptoError } from './errors';

export type KeyRole = 'userKey' | 'vaultKey';

const USAGES: Record<KeyRole, KeyUsage[]> = {
  userKey: ['wrapKey', 'unwrapKey'],
  vaultKey: ['encrypt', 'decrypt'],
};

const subtle = () => globalThis.crypto.subtle;

/** Wraps `key` (which must be extractable) under `kek` with AES-GCM and the given AAD. */
export async function wrapKey(key: CryptoKey, kek: CryptoKey, aadString: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().wrapKey('raw', key, kek, { name: 'AES-GCM', iv, additionalData: utf8(aadString) });
  return packCiphertext(iv, new Uint8Array(ct));
}

/** Unwraps to a non-extractable key unless `extractable` is set (only for immediate re-wrapping). */
export async function unwrapKey(
  wrapped: string,
  kek: CryptoKey,
  aadString: string,
  role: KeyRole,
  extractable = false,
): Promise<CryptoKey> {
  const { iv, ct } = unpackCiphertext(wrapped);
  try {
    return await subtle().unwrapKey(
      'raw',
      ct,
      kek,
      { name: 'AES-GCM', iv, additionalData: utf8(aadString) },
      { name: 'AES-GCM', length: 256 },
      extractable,
      USAGES[role],
    );
  } catch {
    throw new CryptoError('unwrap', 'Could not unwrap key');
  }
}

function freshExtractable(role: KeyRole): Promise<CryptoKey> {
  return subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, USAGES[role]) as Promise<CryptoKey>;
}

export interface NewUserKey {
  userKey: CryptoKey; // non-extractable
  wrappedUserKey: string;
  wrappedUserKeyRecovery: string;
}

/** Creates the user's key, wraps it under both KEKs and returns a non-extractable copy. */
export async function generateUserKey(userId: string, passwordKEK: CryptoKey, recoveryKEK: CryptoKey): Promise<NewUserKey> {
  const tmp = await freshExtractable('userKey');
  const wrappedUserKey = await wrapKey(tmp, passwordKEK, aad.userKey(userId));
  const wrappedUserKeyRecovery = await wrapKey(tmp, recoveryKEK, aad.userKeyRecovery(userId));
  const userKey = await unwrapKey(wrappedUserKey, passwordKEK, aad.userKey(userId), 'userKey');
  return { userKey, wrappedUserKey, wrappedUserKeyRecovery };
}

export interface NewVaultKey {
  vaultKey: CryptoKey; // non-extractable
  wrappedKey: string;
}

export async function generateVaultKey(vaultId: string, userKey: CryptoKey): Promise<NewVaultKey> {
  const tmp = await freshExtractable('vaultKey');
  const wrappedKey = await wrapKey(tmp, userKey, aad.vaultKey(vaultId));
  const vaultKey = await unwrapKey(wrappedKey, userKey, aad.vaultKey(vaultId), 'vaultKey');
  return { vaultKey, wrappedKey };
}

export function unwrapUserKey(wrappedUserKey: string, passwordKEK: CryptoKey, userId: string): Promise<CryptoKey> {
  return unwrapKey(wrappedUserKey, passwordKEK, aad.userKey(userId), 'userKey');
}

export function unwrapVaultKey(wrappedKey: string, userKey: CryptoKey, vaultId: string): Promise<CryptoKey> {
  return unwrapKey(wrappedKey, userKey, aad.vaultKey(vaultId), 'vaultKey');
}

/**
 * Moves the userKey from one wrapping to another (password change, recovery).
 * The key is extractable only inside this function.
 */
export async function rewrapUserKey(
  wrapped: string,
  from: { kek: CryptoKey; aad: string },
  to: { kek: CryptoKey; aad: string },
): Promise<string> {
  const tmp = await unwrapKey(wrapped, from.kek, from.aad, 'userKey', true);
  return wrapKey(tmp, to.kek, to.aad);
}
