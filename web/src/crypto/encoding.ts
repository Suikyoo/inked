import { CryptoError } from './errors';

/** Byte arrays backed by a plain ArrayBuffer (what WebCrypto accepts). */
export type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export function utf8(s: string): Bytes {
  return new Uint8Array(enc.encode(s));
}

export function fromUtf8(b: Uint8Array): string {
  try {
    return dec.decode(b);
  } catch {
    throw new CryptoError('format', 'Invalid UTF-8');
  }
}

export function randomBytes(n: number): Bytes {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Bytes {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) {
    throw new CryptoError('format', 'Invalid base64url');
  }
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new CryptoError('format', 'Invalid base64url');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, upper case, no padding. */
export function toBase32(bytes: Uint8Array): string {
  let out = '';
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(buf >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buf &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(buf << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s: string): Bytes {
  const up = s.toUpperCase();
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of up) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new CryptoError('format', 'Invalid base32');
    buf = (buf << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((buf >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    buf &= (1 << bits) - 1;
  }
  // Leftover bits must be zero padding, otherwise the string was not produced by toBase32.
  if (buf !== 0) throw new CryptoError('format', 'Invalid base32');
  return new Uint8Array(out);
}

/** Overwrite a buffer we no longer need (best effort; JS gives no hard guarantees). */
export function wipe(b: Uint8Array | null | undefined): void {
  if (b) b.fill(0);
}
