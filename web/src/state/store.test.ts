// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  status: vi.fn(), me: vi.fn(), params: vi.fn(), login: vi.fn(), logout: vi.fn(), setup: vi.fn(),
  listVaults: vi.fn(), createVault: vi.fn(), createNote: vi.fn(), getNote: vi.fn(), updateNote: vi.fn(),
  rotateRecoveryKey: vi.fn(), tree: vi.fn(), bodies: vi.fn(),
}));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api }));
vi.mock('../crypto/kdf', async (orig) => {
  const m = await orig<typeof import('../crypto/kdf')>();
  const fast = { alg: 'argon2id' as const, m: 1024, t: 1, p: 1 };
  return { ...m, DEFAULT_KDF_PARAMS: fast, MIN_KDF_PARAMS: fast, assertKdfParams: (p: unknown) => p };
});
vi.mock('../lib/argon2Worker', async () => {
  const { argon2id } = await import('hash-wasm');
  return { argon2InWorker: (pw: Uint8Array, salt: Uint8Array, p: { m: number; t: number; p: number }) =>
    argon2id({ password: pw, salt, memorySize: p.m, iterations: p.t, parallelism: p.p, hashLength: 32, outputType: 'binary' }) };
});

import { ApiError } from '../api/client';
import { AppStore } from './store';

async function registeredStore() {
  api.setup.mockImplementation(async (body: { userId: string; username: string }) => ({ user: { id: body.userId, username: body.username, isAdmin: true } }));
  api.createVault.mockImplementation(async (b: { id: string; encMeta: string; wrappedKey: string }) => ({ vault: { ...b, createdAt: 'x', updatedAt: 'x', noteCount: 0, activeNoteCount7d: 0 } }));
  const s = new AppStore();
  await s.register({ username: 'ann', password: 'pw-ann-123456', setupToken: 'tok-12345678' });
  return s;
}

type NoteBody = { id: string; folderId: string | null; encMeta: string; encBody: string };
const headFor = (b: NoteBody, updatedAt: string) => ({
  note: { id: b.id, folderId: b.folderId, encMeta: b.encMeta, size: 1, createdAt: 'a', updatedAt },
});

describe('AppStore', () => {
  beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); });

  it('lock ends the server session and remembers only the username (I3)', async () => {
    const s = await registeredStore();
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(s.getState().phase).toBe('signedOut');
    expect(s.getState().lastUsername).toBe('ann');
    expect(localStorage.getItem('inked.lastUsername')).toBe('ann');
    expect(Object.keys(localStorage)).toEqual(['inked.lastUsername']);
  });

  it('boot recalls the remembered username when there is no session', async () => {
    localStorage.setItem('inked.lastUsername', 'ann');
    api.status.mockResolvedValue({ needsSetup: false });
    api.me.mockRejectedValue(new ApiError(401, 'unauthorized'));
    const s = new AppStore();
    await s.boot();
    expect(s.getState().phase).toBe('signedOut');
    expect(s.getState().lastUsername).toBe('ann');
  });

  it('signOut and forgetUsername clear the remembered username', async () => {
    const s = await registeredStore();
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    s.forgetUsername();
    expect(s.getState().lastUsername).toBe('');
    expect(localStorage.getItem('inked.lastUsername')).toBeNull();

    const t = await registeredStore();
    await t.signOut();
    expect(t.getState().lastUsername).toBe('');
    expect(localStorage.getItem('inked.lastUsername')).toBeNull();
  });

  it('passes the setup token through (M8)', async () => {
    await registeredStore();
    expect(api.setup.mock.calls[0][0].setupToken).toBe('tok-12345678');
  });

  it('drops a note load that finishes after lock (M1)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    // Real ciphertext for this vault, so only the epoch guard can stop the late result.
    api.createNote.mockImplementation(async (_v: string, b: NoteBody) => headFor(b, 't1'));
    const created = await s.createNote(vaultId, null, 'Secret', 'secret body');
    const sent: NoteBody = api.createNote.mock.calls[0][1];
    let release!: (v: unknown) => void;
    api.getNote.mockReturnValue(new Promise((r) => (release = r)));
    const p = s.loadNote(vaultId, created.id).catch((e) => e);
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    release({ note: { ...headFor(sent, 't1').note, encBody: sent.encBody } });
    await p;
    expect(s.getState().bodies).toEqual({});
    expect(s.getState().trees).toEqual({});
  });

  it('drops a save that finishes after lock (M1)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.createNote.mockImplementation(async (_v: string, b: NoteBody) => headFor(b, 't1'));
    const created = await s.createNote(vaultId, null, 'Secret', '');
    const sent: NoteBody = api.createNote.mock.calls[0][1];
    let release!: (v: unknown) => void;
    api.updateNote.mockReturnValue(new Promise((r) => (release = r)));
    const p = s.saveNoteBody(vaultId, created.id, 'late body');
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    release(headFor(sent, 't2'));
    const head = await p;
    expect(head.updatedAt).toBe('t2');
    expect(s.getState().bodies).toEqual({});
    expect(s.getState().trees).toEqual({});
    expect(s.isOwnStamp(created.id, 't2')).toBe(false);
  });

  it('knows its own timestamps and keeps the newer head (M2)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.createNote.mockImplementation(async (_v: string, b: NoteBody) => headFor(b, '2026-01-02T00:00:00.000Z'));
    const created = await s.createNote(vaultId, null, 'Note', '');
    const sent: NoteBody = api.createNote.mock.calls[0][1];
    expect(s.isOwnStamp(created.id, '2026-01-02T00:00:00.000Z')).toBe(true);
    expect(s.isOwnStamp(created.id, '2026-01-03T00:00:00.000Z')).toBe(false);

    api.updateNote.mockResolvedValueOnce(headFor(sent, '2026-01-03T00:00:00.000Z'));
    await s.saveNoteBody(vaultId, created.id, 'one');
    api.updateNote.mockResolvedValueOnce(headFor(sent, '2026-01-04T00:00:00.000Z'));
    await s.renameNote(vaultId, created.id, 'Renamed');
    api.updateNote.mockResolvedValueOnce(headFor(sent, '2026-01-05T00:00:00.000Z'));
    await s.moveNote(vaultId, created.id, null);
    for (const d of ['03', '04', '05']) expect(s.isOwnStamp(created.id, `2026-01-${d}T00:00:00.000Z`)).toBe(true);

    // A late response carrying an older stamp must not move the head backwards.
    api.updateNote.mockResolvedValueOnce(headFor(sent, '2026-01-01T00:00:00.000Z'));
    await s.saveNoteBody(vaultId, created.id, 'two');
    expect(s.getState().trees[vaultId].notes[created.id].updatedAt).toBe('2026-01-05T00:00:00.000Z');

    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    expect(s.isOwnStamp(created.id, '2026-01-05T00:00:00.000Z')).toBe(false);
  });

  it('refuses oversized bodies before calling the API (M10)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    await expect(s.saveNoteBody(vaultId, crypto.randomUUID(), 'x'.repeat(1_600_000))).rejects.toThrow(/too large/i);
    expect(api.updateNote).not.toHaveBeenCalled();
  });

  it('rotateRecoveryKey sends a new recovery proof and wrapped key (I5)', async () => {
    const s = await registeredStore();
    const setupBody = api.setup.mock.calls[0][0];
    api.params.mockResolvedValue({ kdfSalt: setupBody.kdfSalt, kdfParams: setupBody.kdfParams });
    api.me.mockResolvedValue({ user: { id: setupBody.userId, username: 'ann', isAdmin: true }, wrappedUserKey: setupBody.wrappedUserKey });
    api.rotateRecoveryKey.mockResolvedValue({ ok: true });
    const key = await s.rotateRecoveryKey('pw-ann-123456');
    expect(key).toMatch(/^inked-rk1-/);
    const sent = api.rotateRecoveryKey.mock.calls[0][0];
    expect(sent.currentAuthKey).toBe(setupBody.authKey);
    expect(sent.recoveryAuth).not.toBe(setupBody.recoveryAuth);
    expect(sent.wrappedUserKeyRecovery).toMatch(/^v1\./);
  });

  it('rotateRecoveryKey refuses a wrong password without calling the API (I5)', async () => {
    const s = await registeredStore();
    const setupBody = api.setup.mock.calls[0][0];
    api.params.mockResolvedValue({ kdfSalt: setupBody.kdfSalt, kdfParams: setupBody.kdfParams });
    api.me.mockResolvedValue({ user: { id: setupBody.userId, username: 'ann', isAdmin: true }, wrappedUserKey: setupBody.wrappedUserKey });
    await expect(s.rotateRecoveryKey('wrong-password')).rejects.toMatchObject({ name: 'CryptoError', code: 'unwrap' });
    expect(api.rotateRecoveryKey).not.toHaveBeenCalled();
  });
});

describe('describeError', () => {
  it('uses one sentence for a too-large note, client- or server-side (M10)', async () => {
    const { describeError } = await import('../lib/util');
    const { NoteTooLargeError } = await import('./store');
    const sentence = 'This note is too large to save (about 1.5 MB of text is the limit).';
    expect(describeError(new NoteTooLargeError())).toBe(sentence);
    expect(describeError(new ApiError(413, 'too_large'))).toBe(sentence);
  });
});
