import { describe, expect, it } from 'vitest';
import { hkdfSync } from 'node:crypto';
import { argon2id } from 'hash-wasm';
import {
  aad,
  argon2Direct,
  assertKdfParams,
  CryptoError,
  decryptFolderMeta,
  decryptJSON,
  decryptNoteBody,
  decryptNoteMeta,
  decryptString,
  decryptVaultMeta,
  DEFAULT_KDF_PARAMS,
  deriveFromPassword,
  deriveRecoveryKeys,
  encryptFolderMeta,
  encryptJSON,
  encryptNoteBody,
  encryptNoteMeta,
  encryptString,
  encryptVaultMeta,
  formatRecoveryKey,
  fromBase32,
  fromBase64Url,
  generateKdfSalt,
  generateRecoveryKey,
  generateUserKey,
  generateVaultKey,
  isCryptoError,
  parseRecoveryKey,
  rewrapUserKey,
  toBase32,
  toBase64Url,
  unwrapUserKey,
  unwrapVaultKey,
  utf8,
  type KdfParams,
} from './index';

// Small Argon2 parameters keep the suite fast; production uses DEFAULT_KDF_PARAMS.
const FAST: KdfParams = { alg: 'argon2id', m: 1024, t: 1, p: 1 };
const SALT = toBase64Url(new Uint8Array(16).map((_, i) => i + 1));
const USER = '9b2f3c1e-5d4a-4f6b-8c7d-0e1f2a3b4c5d';
const VAULT_A = '11111111-1111-4111-8111-111111111111';
const VAULT_B = '22222222-2222-4222-8222-222222222222';
const NOTE_A = '33333333-3333-4333-8333-333333333333';
const NOTE_B = '44444444-4444-4444-8444-444444444444';

async function rejectsWith(p: Promise<unknown>, code: CryptoError['code']) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CryptoError);
  expect((err as CryptoError).code).toBe(code);
}

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
}

/** Flip one bit inside the ciphertext body of a "v1." string. */
function tamper(ct: string, at = 20): string {
  const raw = fromBase64Url(ct.slice(3));
  raw[Math.min(at, raw.length - 1)] ^= 0x01;
  return 'v1.' + toBase64Url(raw);
}

describe('encoding', () => {
  it('base64url round-trips without padding', () => {
    for (let n = 0; n < 40; n++) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      const s = toBase64Url(b);
      expect(s).not.toMatch(/[+/=]/);
      expect(Array.from(fromBase64Url(s))).toEqual(Array.from(b));
    }
  });

  it('base32 round-trips and rejects junk', () => {
    const b = crypto.getRandomValues(new Uint8Array(32));
    const s = toBase32(b);
    expect(s).toMatch(/^[A-Z2-7]{52}$/);
    expect(Array.from(fromBase32(s.toLowerCase()))).toEqual(Array.from(b));
    expect(() => fromBase32('ABC1')).toThrow(CryptoError);
  });

  it('base32 matches RFC 4648 test vectors', () => {
    expect(toBase32(utf8('foobar'))).toBe('MZXW6YTBOI');
    expect(toBase32(utf8('fo'))).toBe('MZXQ');
  });
});

describe('password derivation', () => {
  it('is deterministic for a fixed salt and params', async () => {
    const a = await deriveFromPassword('correct horse', SALT, FAST);
    const b = await deriveFromPassword('correct horse', SALT, FAST);
    expect(a.authKey).toBe(b.authKey);
    expect(fromBase64Url(a.authKey)).toHaveLength(32);
    expect(a.passwordKEK.extractable).toBe(false);
    expect(a.passwordKEK.usages.sort()).toEqual(['unwrapKey', 'wrapKey']);
  });

  it('changes with salt and password', async () => {
    const a = await deriveFromPassword('correct horse', SALT, FAST);
    const b = await deriveFromPassword('correct horse', generateKdfSalt(), FAST);
    const c = await deriveFromPassword('correct horsf', SALT, FAST);
    expect(a.authKey).not.toBe(b.authKey);
    expect(a.authKey).not.toBe(c.authKey);
  });

  it('matches an independent Argon2id + HKDF-SHA256 computation (info "inked/auth/v1", empty salt)', async () => {
    const master = await argon2id({
      password: 'pässword',
      salt: fromBase64Url(SALT),
      parallelism: 1,
      iterations: 1,
      memorySize: 1024,
      hashLength: 32,
      outputType: 'binary',
    });
    const expected = new Uint8Array(hkdfSync('sha256', master, new Uint8Array(0), 'inked/auth/v1', 32));
    const { authKey } = await deriveFromPassword('pässword', SALT, FAST);
    expect(authKey).toBe(toBase64Url(expected));
  });

  it('normalises passwords to NFC', async () => {
    const composed = await deriveFromPassword('café', SALT, FAST);
    const decomposed = await deriveFromPassword('café', SALT, FAST);
    expect(composed.authKey).toBe(decomposed.authKey);
  });

  it('uses an injected argon2 implementation', async () => {
    let called = 0;
    const res = await deriveFromPassword('pw', SALT, FAST, {
      argon2: async (p, s, prm) => {
        called++;
        return argon2Direct(p, s, prm);
      },
    });
    expect(called).toBe(1);
    expect(res.authKey).toBe((await deriveFromPassword('pw', SALT, FAST)).authKey);
  });

  it('rejects weak or malformed server params', () => {
    expect(assertKdfParams({ alg: 'argon2id', m: 65536, t: 3, p: 1 })).toEqual(DEFAULT_KDF_PARAMS);
    expect(() => assertKdfParams({ alg: 'argon2id', m: 1024, t: 3, p: 1 })).toThrow(CryptoError);
    expect(() => assertKdfParams({ alg: 'argon2id', m: 65536, t: 1, p: 1 })).toThrow(CryptoError);
    expect(() => assertKdfParams({ alg: 'pbkdf2', m: 65536, t: 3, p: 1 })).toThrow(CryptoError);
    expect(() => assertKdfParams({ alg: 'argon2id', m: 1e9, t: 3, p: 1 })).toThrow(CryptoError);
    expect(() => assertKdfParams(null)).toThrow(CryptoError);
  });

  it('rejects short salts', async () => {
    await rejectsWith(deriveFromPassword('pw', toBase64Url(new Uint8Array(8)), FAST), 'params');
  });
});

describe('key wrapping', () => {
  async function setup() {
    const pw = await deriveFromPassword('hunter2 hunter2', SALT, FAST);
    const rk = await deriveRecoveryKeys(generateRecoveryKey());
    const uk = await generateUserKey(USER, pw.passwordKEK, rk.recoveryKEK);
    return { pw, rk, uk };
  }

  it('wraps the userKey under password and recovery KEKs; unwrapped keys are non-extractable', async () => {
    const { pw, rk, uk } = await setup();
    expect(uk.wrappedUserKey.startsWith('v1.')).toBe(true);
    expect(fromBase64Url(uk.wrappedUserKey.slice(3))).toHaveLength(12 + 32 + 16);
    expect(uk.userKey.extractable).toBe(false);

    const again = await unwrapUserKey(uk.wrappedUserKey, pw.passwordKEK, USER);
    expect(again.extractable).toBe(false);
    expect(again.usages.sort()).toEqual(['unwrapKey', 'wrapKey']);

    // A vault key wrapped with the original userKey opens with the unwrapped copy.
    const vk = await generateVaultKey(VAULT_A, uk.userKey);
    const vk2 = await unwrapVaultKey(vk.wrappedKey, again, VAULT_A);
    expect(vk2.extractable).toBe(false);
    const ct = await encryptString(vk.vaultKey, 'hello', aad.vaultMeta(VAULT_A));
    expect(await decryptString(vk2, ct, aad.vaultMeta(VAULT_A))).toBe('hello');

    // Recovery copy opens with the recovery KEK and the recovery AAD only.
    const viaRecovery = await rewrapUserKey(
      uk.wrappedUserKeyRecovery,
      { kek: rk.recoveryKEK, aad: aad.userKeyRecovery(USER) },
      { kek: pw.passwordKEK, aad: aad.userKey(USER) },
    );
    const uk3 = await unwrapUserKey(viaRecovery, pw.passwordKEK, USER);
    expect(await decryptString(await unwrapVaultKey(vk.wrappedKey, uk3, VAULT_A), ct, aad.vaultMeta(VAULT_A))).toBe(
      'hello',
    );
  });

  it('fails to unwrap with a wrong password', async () => {
    const { uk } = await setup();
    const wrong = await deriveFromPassword('hunter3 hunter3', SALT, FAST);
    await rejectsWith(unwrapUserKey(uk.wrappedUserKey, wrong.passwordKEK, USER), 'unwrap');
  });

  it('fails to unwrap with the wrong user id or slot (AAD)', async () => {
    const { pw, rk, uk } = await setup();
    await rejectsWith(unwrapUserKey(uk.wrappedUserKey, pw.passwordKEK, 'someone-else'), 'unwrap');
    await rejectsWith(
      rewrapUserKey(
        uk.wrappedUserKeyRecovery,
        { kek: rk.recoveryKEK, aad: aad.userKey(USER) },
        { kek: pw.passwordKEK, aad: aad.userKey(USER) },
      ),
      'unwrap',
    );
  });

  it('fails to unwrap a vault key under another vault id', async () => {
    const { uk } = await setup();
    const vk = await generateVaultKey(VAULT_A, uk.userKey);
    await rejectsWith(unwrapVaultKey(vk.wrappedKey, uk.userKey, VAULT_B), 'unwrap');
  });

  it('fails on a tampered wrapped key', async () => {
    const { pw, uk } = await setup();
    await rejectsWith(unwrapUserKey(tamper(uk.wrappedUserKey), pw.passwordKEK, USER), 'unwrap');
  });

  it('password change re-wraps only the userKey', async () => {
    const { pw, uk } = await setup();
    const vk = await generateVaultKey(VAULT_A, uk.userKey);
    const newSalt = generateKdfSalt();
    const next = await deriveFromPassword('new password!', newSalt, FAST);
    const rewrapped = await rewrapUserKey(
      uk.wrappedUserKey,
      { kek: pw.passwordKEK, aad: aad.userKey(USER) },
      { kek: next.passwordKEK, aad: aad.userKey(USER) },
    );
    const opened = await unwrapUserKey(rewrapped, next.passwordKEK, USER);
    await expect(unwrapVaultKey(vk.wrappedKey, opened, VAULT_A)).resolves.toBeDefined();
    await rejectsWith(unwrapUserKey(rewrapped, pw.passwordKEK, USER), 'unwrap');
  });
});

describe('field encryption', () => {
  it('round-trips strings, JSON and typed metas', async () => {
    const k = await aesKey();
    const s = 'Ünïcødé ✓ — [[link]] `code`\n';
    expect(await decryptString(k, await encryptString(k, s, 'x'), 'x')).toBe(s);
    expect(await decryptJSON(k, await encryptJSON(k, { a: [1, 'b'] }, 'y'), 'y')).toEqual({ a: [1, 'b'] });

    const vm = await encryptVaultMeta(k, VAULT_A, { name: 'Work', color: '#D19C3C' });
    expect(await decryptVaultMeta(k, VAULT_A, vm)).toEqual({ name: 'Work', color: '#D19C3C' });
    const fm = await encryptFolderMeta(k, VAULT_A, NOTE_A, { name: 'runbooks' });
    expect(await decryptFolderMeta(k, VAULT_A, NOTE_A, fm)).toEqual({ name: 'runbooks' });
    const nm = await encryptNoteMeta(k, VAULT_A, NOTE_A, { title: 'deploy-prod' });
    expect(await decryptNoteMeta(k, VAULT_A, NOTE_A, nm)).toEqual({ title: 'deploy-prod' });
    const nb = await encryptNoteBody(k, VAULT_A, NOTE_A, '# Hi');
    expect(await decryptNoteBody(k, VAULT_A, NOTE_A, nb)).toBe('# Hi');
  });

  it('uses a fresh IV each time', async () => {
    const k = await aesKey();
    const a = await encryptString(k, 'same', 'aad');
    const b = await encryptString(k, 'same', 'aad');
    expect(a).not.toBe(b);
    expect(fromBase64Url(a.slice(3)).slice(0, 12)).not.toEqual(fromBase64Url(b.slice(3)).slice(0, 12));
  });

  it('uses the exact AAD strings from the spec', async () => {
    const k = await aesKey();
    const nb = await encryptNoteBody(k, VAULT_A, NOTE_A, 'body');
    expect(await decryptString(k, nb, `inked/note-body/${VAULT_A}/${NOTE_A}`)).toBe('body');
    const nm = await encryptNoteMeta(k, VAULT_A, NOTE_A, { title: 't' });
    expect(await decryptString(k, nm, `inked/note-meta/${VAULT_A}/${NOTE_A}`)).toBe('{"title":"t"}');
    const vm = await encryptVaultMeta(k, VAULT_A, { name: 'n', color: '#45A89E' });
    expect(await decryptString(k, vm, `inked/vault/${VAULT_A}`)).toBe('{"name":"n","color":"#45A89E"}');
    const fm = await encryptFolderMeta(k, VAULT_A, NOTE_B, { name: 'f' });
    expect(await decryptString(k, fm, `inked/folder/${VAULT_A}/${NOTE_B}`)).toBe('{"name":"f"}');
  });

  it('fails when the vault id or note id in the AAD is swapped', async () => {
    const k = await aesKey();
    const body = await encryptNoteBody(k, VAULT_A, NOTE_A, 'secret');
    await rejectsWith(decryptNoteBody(k, VAULT_B, NOTE_A, body), 'decrypt');
    await rejectsWith(decryptNoteBody(k, VAULT_A, NOTE_B, body), 'decrypt');
    const meta = await encryptNoteMeta(k, VAULT_A, NOTE_A, { title: 'x' });
    await rejectsWith(decryptNoteMeta(k, VAULT_A, NOTE_B, meta), 'decrypt');
    // A note-meta ciphertext cannot be replayed as a body in the same slot.
    await rejectsWith(decryptNoteBody(k, VAULT_A, NOTE_A, meta), 'decrypt');
    const vm = await encryptVaultMeta(k, VAULT_A, { name: 'n', color: '#45A89E' });
    await rejectsWith(decryptVaultMeta(k, VAULT_B, vm), 'decrypt');
  });

  it('fails with a different key', async () => {
    const body = await encryptNoteBody(await aesKey(), VAULT_A, NOTE_A, 'secret');
    await rejectsWith(decryptNoteBody(await aesKey(), VAULT_A, NOTE_A, body), 'decrypt');
  });

  it('fails on tampered ciphertext, IV, tag and bad format', async () => {
    const k = await aesKey();
    const ct = await encryptString(k, 'a longer plaintext value', 'aad');
    await rejectsWith(decryptString(k, tamper(ct, 3), 'aad'), 'decrypt'); // IV
    await rejectsWith(decryptString(k, tamper(ct, 14), 'aad'), 'decrypt'); // body
    await rejectsWith(decryptString(k, tamper(ct, 10_000), 'aad'), 'decrypt'); // tag (last byte)
    await rejectsWith(decryptString(k, 'v2.' + ct.slice(3), 'aad'), 'format');
    await rejectsWith(decryptString(k, 'v1.AAAA', 'aad'), 'format');
    await rejectsWith(decryptString(k, 'v1.***', 'aad'), 'format');
  });

  it('rejects metas with the wrong shape', async () => {
    const k = await aesKey();
    const bad = await encryptJSON(k, { name: 'n', color: 'red' }, aad.vaultMeta(VAULT_A));
    await rejectsWith(decryptVaultMeta(k, VAULT_A, bad), 'format');
  });
});

describe('recovery key', () => {
  it('formats as inked-rk1- + grouped base32', () => {
    const rk = generateRecoveryKey();
    const s = formatRecoveryKey(rk);
    expect(s).toMatch(/^inked-rk1-([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);
  });

  it('parses its own format and tolerates case, spaces and missing dashes', () => {
    const rk = generateRecoveryKey();
    const s = formatRecoveryKey(rk);
    const variants = [
      s,
      s.toLowerCase(),
      s.replace(/-/g, ' '),
      s.replace(/-/g, ''),
      '  ' + s.toUpperCase().replace(/-/g, ' - ') + '\n',
      s.slice('inked-rk1-'.length),
    ];
    for (const v of variants) expect(Array.from(parseRecoveryKey(v))).toEqual(Array.from(rk));
  });

  it('rejects malformed keys', () => {
    const s = formatRecoveryKey(generateRecoveryKey());
    expect(() => parseRecoveryKey(s.slice(0, -1))).toThrow(CryptoError);
    expect(() => parseRecoveryKey(s + 'A')).toThrow(CryptoError);
    expect(() => parseRecoveryKey(s.replace(/[A-Z]/, '1'))).toThrow(CryptoError);
    expect(() => parseRecoveryKey('')).toThrow(CryptoError);
  });

  it('derives deterministic, distinct recoveryAuth and KEK', async () => {
    const rk = new Uint8Array(32).fill(7);
    const a = await deriveRecoveryKeys(rk);
    const b = await deriveRecoveryKeys(parseRecoveryKey(formatRecoveryKey(rk)));
    expect(a.recoveryAuth).toBe(b.recoveryAuth);
    expect(a.recoveryKEK.extractable).toBe(false);
    const expected = hkdfSync('sha256', rk, new Uint8Array(0), 'inked/recovery-auth/v1', 32);
    expect(a.recoveryAuth).toBe(toBase64Url(new Uint8Array(expected)));
  });

  it('a wrong recovery key cannot unwrap the recovery copy', async () => {
    const pw = await deriveFromPassword('pw', SALT, FAST);
    const good = await deriveRecoveryKeys(generateRecoveryKey());
    const bad = await deriveRecoveryKeys(generateRecoveryKey());
    const uk = await generateUserKey(USER, pw.passwordKEK, good.recoveryKEK);
    const err = await rewrapUserKey(
      uk.wrappedUserKeyRecovery,
      { kek: bad.recoveryKEK, aad: aad.userKeyRecovery(USER) },
      { kek: pw.passwordKEK, aad: aad.userKey(USER) },
    ).catch((e: unknown) => e);
    expect(isCryptoError(err, 'unwrap')).toBe(true);
  });
});
