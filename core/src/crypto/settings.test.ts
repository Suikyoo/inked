import { describe, expect, it } from 'vitest';
import { decryptAccountSettings, encryptAccountSettings, isAccountSettings } from './fields';
import { CryptoError } from './errors';

const key = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
const llm = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-test' };

describe('account settings field', () => {
  it('round-trips semantic and llm', async () => {
    const k = await key();
    const ct = await encryptAccountSettings(k, 'u1', { semantic: true, llm });
    expect(await decryptAccountSettings(k, 'u1', ct)).toEqual({ semantic: true, llm });
  });
  it('round-trips an empty object', async () => {
    const k = await key();
    expect(await decryptAccountSettings(k, 'u1', await encryptAccountSettings(k, 'u1', {}))).toEqual({});
  });
  it('fails for another user', async () => {
    const k = await key();
    const ct = await encryptAccountSettings(k, 'u1', { semantic: true });
    await expect(decryptAccountSettings(k, 'u2', ct)).rejects.toBeInstanceOf(CryptoError);
  });
  it('drops unknown fields when encrypting', async () => {
    const k = await key();
    const ct = await encryptAccountSettings(k, 'u1', { semantic: false, extra: 1 } as never);
    expect(await decryptAccountSettings(k, 'u1', ct)).toEqual({ semantic: false });
  });
  it('validates the shape', () => {
    expect(isAccountSettings({})).toBe(true);
    expect(isAccountSettings({ semantic: true, llm })).toBe(true);
    expect(isAccountSettings({ semantic: 'yes' })).toBe(false);
    expect(isAccountSettings({ llm: { baseUrl: 'x', model: 'm' } })).toBe(false);
    expect(isAccountSettings([])).toBe(false);
  });
});
