import { HKDF_INFO } from './aad';
import { fromBase32, randomBytes, toBase32, toBase64Url, wipe, type Bytes } from './encoding';
import { CryptoError } from './errors';
import { hkdfBytes, hkdfKek, importHkdfBase } from './kdf';

export const RECOVERY_KEY_PREFIX = 'inked-rk1-';
const RECOVERY_KEY_BYTES = 32;
const RECOVERY_KEY_CHARS = 52; // ceil(256 / 5)

export function generateRecoveryKey(): Bytes {
  return randomBytes(RECOVERY_KEY_BYTES);
}

/** "inked-rk1-" + base32 (no padding), grouped in 4s with "-". */
export function formatRecoveryKey(bytes: Uint8Array): string {
  if (bytes.length !== RECOVERY_KEY_BYTES) throw new CryptoError('format', 'Recovery key must be 32 bytes');
  const groups = toBase32(bytes).match(/.{1,4}/g) ?? [];
  return RECOVERY_KEY_PREFIX + groups.join('-');
}

/** Tolerates any case, spaces, line breaks and dashes; the "inked-rk1-" prefix is optional. */
export function parseRecoveryKey(input: string): Bytes {
  let s = input.toLowerCase().replace(/[\s-]+/g, '');
  const prefix = RECOVERY_KEY_PREFIX.replace(/-/g, '');
  if (s.startsWith(prefix)) s = s.slice(prefix.length);
  if (s.length !== RECOVERY_KEY_CHARS) {
    throw new CryptoError('format', 'A recovery key has 52 letters and digits after “inked-rk1-”.');
  }
  const bytes = fromBase32(s);
  if (bytes.length !== RECOVERY_KEY_BYTES) throw new CryptoError('format', 'That is not a valid recovery key.');
  return bytes;
}

export interface RecoveryKeys {
  /** base64url; proves possession of the recovery key to the server. */
  recoveryAuth: string;
  /** Non-extractable; wraps and unwraps the recovery copy of the userKey. */
  recoveryKEK: CryptoKey;
}

export async function deriveRecoveryKeys(recoveryKey: Bytes): Promise<RecoveryKeys> {
  const base = await importHkdfBase(recoveryKey);
  const authBytes = await hkdfBytes(base, HKDF_INFO.recoveryAuth);
  const recoveryAuth = toBase64Url(authBytes);
  wipe(authBytes);
  const recoveryKEK = await hkdfKek(base, HKDF_INFO.recoveryWrap);
  return { recoveryAuth, recoveryKEK };
}
