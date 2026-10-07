import { aad } from './aad';
import { packCiphertext, unpackCiphertext, IV_BYTES } from './cipher';
import { fromUtf8, randomBytes, utf8, type Bytes } from './encoding';
import { CryptoError } from './errors';
import { EMBED_DIM, MAX_CHUNKS } from '../semantic/chunk';

const subtle = () => globalThis.crypto.subtle;

export async function encryptBytes(key: CryptoKey, plaintext: Bytes, aadString: string): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aadString) }, key, plaintext);
  return packCiphertext(iv, new Uint8Array(ct));
}

export async function decryptBytes(key: CryptoKey, ciphertext: string, aadString: string): Promise<Bytes> {
  const { iv, ct } = unpackCiphertext(ciphertext);
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: utf8(aadString) }, key, ct);
    return new Uint8Array(pt);
  } catch {
    throw new CryptoError('decrypt', 'Could not decrypt');
  }
}

export function encryptString(key: CryptoKey, plaintext: string, aadString: string): Promise<string> {
  return encryptBytes(key, utf8(plaintext), aadString);
}

export async function decryptString(key: CryptoKey, ciphertext: string, aadString: string): Promise<string> {
  return fromUtf8(await decryptBytes(key, ciphertext, aadString));
}

export function encryptJSON(key: CryptoKey, value: unknown, aadString: string): Promise<string> {
  return encryptString(key, JSON.stringify(value), aadString);
}

export async function decryptJSON<T>(
  key: CryptoKey,
  ciphertext: string,
  aadString: string,
  validate?: (v: unknown) => v is T,
): Promise<T> {
  const text = await decryptString(key, ciphertext, aadString);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CryptoError('format', 'Decrypted value is not JSON');
  }
  if (validate && !validate(value)) throw new CryptoError('format', 'Decrypted value has the wrong shape');
  return value as T;
}

// ---- Typed field helpers (AAD per docs/architecture.md) ----------------------------------

export interface VaultMeta {
  name: string;
  color: string;
}
export interface FolderMeta {
  name: string;
}
export interface NoteMeta {
  title: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isVaultMeta = (v: unknown): v is VaultMeta =>
  isObj(v) && typeof v.name === 'string' && typeof v.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v.color);
export const isFolderMeta = (v: unknown): v is FolderMeta => isObj(v) && typeof v.name === 'string';
export const isNoteMeta = (v: unknown): v is NoteMeta => isObj(v) && typeof v.title === 'string';

export const encryptVaultMeta = (key: CryptoKey, vaultId: string, meta: VaultMeta) =>
  encryptJSON(key, { name: meta.name, color: meta.color }, aad.vaultMeta(vaultId));
export const decryptVaultMeta = (key: CryptoKey, vaultId: string, ct: string) =>
  decryptJSON(key, ct, aad.vaultMeta(vaultId), isVaultMeta);

export const encryptFolderMeta = (key: CryptoKey, vaultId: string, folderId: string, meta: FolderMeta) =>
  encryptJSON(key, { name: meta.name }, aad.folderMeta(vaultId, folderId));
export const decryptFolderMeta = (key: CryptoKey, vaultId: string, folderId: string, ct: string) =>
  decryptJSON(key, ct, aad.folderMeta(vaultId, folderId), isFolderMeta);

export const encryptNoteMeta = (key: CryptoKey, vaultId: string, noteId: string, meta: NoteMeta) =>
  encryptJSON(key, { title: meta.title }, aad.noteMeta(vaultId, noteId));
export const decryptNoteMeta = (key: CryptoKey, vaultId: string, noteId: string, ct: string) =>
  decryptJSON(key, ct, aad.noteMeta(vaultId, noteId), isNoteMeta);

/** Note bodies are UTF-8 Markdown, not JSON. */
export const encryptNoteBody = (key: CryptoKey, vaultId: string, noteId: string, body: string) =>
  encryptString(key, body, aad.noteBody(vaultId, noteId));
export const decryptNoteBody = (key: CryptoKey, vaultId: string, noteId: string, ct: string) =>
  decryptString(key, ct, aad.noteBody(vaultId, noteId));

/** Plaintext: [chunk count: u8][count × EMBED_DIM int8]. */
export async function encryptNoteVector(
  key: CryptoKey,
  vaultId: string,
  noteId: string,
  model: string,
  chunks: readonly Int8Array[],
): Promise<string> {
  if (chunks.length < 1 || chunks.length > MAX_CHUNKS || chunks.some((c) => c.length !== EMBED_DIM)) {
    throw new CryptoError('format', 'Vector has the wrong shape');
  }
  const buf = new Uint8Array(1 + chunks.length * EMBED_DIM);
  buf[0] = chunks.length;
  chunks.forEach((c, i) => buf.set(new Uint8Array(c.buffer, c.byteOffset, c.length), 1 + i * EMBED_DIM));
  return encryptBytes(key, buf, aad.noteVector(vaultId, noteId, model));
}

export async function decryptNoteVector(
  key: CryptoKey,
  vaultId: string,
  noteId: string,
  model: string,
  ct: string,
): Promise<Int8Array[]> {
  const buf = await decryptBytes(key, ct, aad.noteVector(vaultId, noteId, model));
  const n = buf[0];
  if (!n || n > MAX_CHUNKS || buf.length !== 1 + n * EMBED_DIM) throw new CryptoError('format', 'Vector has the wrong shape');
  return Array.from({ length: n }, (_, i) => new Int8Array(buf.buffer, buf.byteOffset + 1 + i * EMBED_DIM, EMBED_DIM).slice());
}
