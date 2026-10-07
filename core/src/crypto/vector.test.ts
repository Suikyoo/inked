import { describe, expect, it } from 'vitest';
import { decryptNoteVector, encryptNoteVector } from './fields';
import { CryptoError } from './errors';

const key = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
const row = (seed: number) => Int8Array.from({ length: 384 }, (_, i) => ((i * seed) % 255) - 127);

describe('note vector field', () => {
  it('round-trips chunk rows', async () => {
    const k = await key();
    const ct = await encryptNoteVector(k, 'v', 'n', 'm@1', [row(3), row(7)]);
    const back = await decryptNoteVector(k, 'v', 'n', 'm@1', ct);
    expect(back.map((r) => Array.from(r))).toEqual([Array.from(row(3)), Array.from(row(7))]);
  });
  it('fails when moved to another note or model', async () => {
    const k = await key();
    const ct = await encryptNoteVector(k, 'v', 'n', 'm@1', [row(3)]);
    await expect(decryptNoteVector(k, 'v', 'other', 'm@1', ct)).rejects.toBeInstanceOf(CryptoError);
    await expect(decryptNoteVector(k, 'v', 'n', 'm@2', ct)).rejects.toBeInstanceOf(CryptoError);
  });
  it('rejects zero or too many chunks when encrypting', async () => {
    const k = await key();
    await expect(encryptNoteVector(k, 'v', 'n', 'm', [])).rejects.toThrow();
    await expect(encryptNoteVector(k, 'v', 'n', 'm', Array.from({ length: 17 }, () => row(1)))).rejects.toThrow();
  });
});
