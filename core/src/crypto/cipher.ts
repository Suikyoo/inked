import { concatBytes, fromBase64Url, toBase64Url, type Bytes } from './encoding';
import { CryptoError } from './errors';

/** Ciphertext format: "v1." + base64url(iv[12] || ciphertext || tag[16]). */
export const CIPHERTEXT_PREFIX = 'v1.';
export const IV_BYTES = 12;
const TAG_BYTES = 16;

export function packCiphertext(iv: Uint8Array, ctWithTag: Uint8Array): string {
  if (iv.length !== IV_BYTES) throw new CryptoError('format', 'IV must be 12 bytes');
  return CIPHERTEXT_PREFIX + toBase64Url(concatBytes(iv, ctWithTag));
}

export function unpackCiphertext(s: string): { iv: Bytes; ct: Bytes } {
  if (typeof s !== 'string' || !s.startsWith(CIPHERTEXT_PREFIX)) {
    throw new CryptoError('format', 'Unknown ciphertext version');
  }
  const raw = fromBase64Url(s.slice(CIPHERTEXT_PREFIX.length));
  if (raw.length < IV_BYTES + TAG_BYTES) throw new CryptoError('format', 'Ciphertext too short');
  return { iv: raw.slice(0, IV_BYTES), ct: raw.slice(IV_BYTES) };
}
