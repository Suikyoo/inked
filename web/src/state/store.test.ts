// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  status: vi.fn(), me: vi.fn(), params: vi.fn(), login: vi.fn(), logout: vi.fn(), setup: vi.fn(),
  listVaults: vi.fn(), createVault: vi.fn(), createNote: vi.fn(), getNote: vi.fn(), updateNote: vi.fn(),
  rotateRecoveryKey: vi.fn(), tree: vi.fn(), bodies: vi.fn(), createFolder: vi.fn(), updateVault: vi.fn(),
}));
/** The store's 401 handler, as the real client would call it. */
const unauthorized = vi.hoisted(() => ({ handler: null as null | (() => unknown) }));
vi.mock('../api/client', async (orig) => ({
  ...(await orig<typeof import('../api/client')>()),
  api,
  setUnauthorizedHandler: (fn: () => unknown) => { unauthorized.handler = fn; },
}));
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
import { newSaveState, settle } from '../pages/useNoteEditor';
import { AppStore, LockedError } from './store';

/** In-memory BroadcastChannel: instances created in the same test share one bus; delivery is async. */
class FakeChannel {
  static bus: FakeChannel[] = [];
  private readonly peers = FakeChannel.bus;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  readonly received: unknown[] = [];
  constructor(readonly name: string) {
    this.peers.push(this);
  }
  postMessage(data: unknown) {
    for (const ch of this.peers) {
      if (ch === this || ch.name !== this.name) continue;
      const copy = structuredClone(data);
      setTimeout(() => {
        ch.received.push(copy);
        ch.onmessage?.({ data: copy });
      }, 0);
    }
  }
  close() {
    const i = this.peers.indexOf(this);
    if (i >= 0) this.peers.splice(i, 1);
  }
}
vi.stubGlobal('BroadcastChannel', FakeChannel);

async function registeredStore() {
  api.setup.mockImplementation(async (body: { userId: string; username: string }) => ({ user: { id: body.userId, username: body.username, isAdmin: true } }));
  api.createVault.mockImplementation(async (b: { id: string; encMeta: string; wrappedKey: string }) => ({ vault: { ...b, createdAt: 'x', updatedAt: 'x', noteCount: 0, activeNoteCount7d: 0 } }));
  const s = new AppStore();
  await s.register({ username: 'ann', password: 'pw-ann-123456', setupToken: 'tok-12345678' });
  return s;
}

/** Lets `unlock('ann', …)` sign the registered account back in. */
function mockUnlock(vaults: unknown[] = []) {
  const setupBody = api.setup.mock.calls[0][0];
  api.params.mockResolvedValue({ kdfSalt: setupBody.kdfSalt, kdfParams: setupBody.kdfParams });
  api.login.mockResolvedValue({ user: { id: setupBody.userId, username: 'ann', isAdmin: true }, wrappedUserKey: setupBody.wrappedUserKey });
  api.listVaults.mockResolvedValue({ vaults });
  api.tree.mockResolvedValue({ folders: [], notes: [] });
  api.bodies.mockResolvedValue({ notes: [] });
}

type NoteBody = { id: string; folderId: string | null; encMeta: string; encBody: string };
type Msg = { type: string; tab?: string; id?: string };
const headFor = (b: NoteBody, updatedAt: string) => ({
  note: { id: b.id, folderId: b.folderId, encMeta: b.encMeta, size: 1, createdAt: 'a', updatedAt },
});

describe('AppStore', () => {
  beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); FakeChannel.bus = []; });

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

  it('drops a create that finishes after lock (M1)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    let release!: (v: unknown) => void;
    api.createNote.mockReturnValue(new Promise((r) => (release = r)));
    const p = s.createNote(vaultId, null, 'Secret', 'secret body').catch((e) => e);
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    await vi.waitFor(() => expect(api.createNote).toHaveBeenCalled());
    release(headFor(api.createNote.mock.calls[0][1], 't1'));
    expect(await p).toBeInstanceOf(LockedError);
    expect(s.getState().bodies).toEqual({});
  });

  it('lock passes final = true to flushers and waits for them (I4)', async () => {
    const s = await registeredStore();
    let done = false;
    const flusher = vi.fn(async (_final: boolean) => {
      await new Promise((r) => setTimeout(r, 5));
      done = true;
    });
    s.registerFlusher(flusher);
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    expect(flusher).toHaveBeenCalledWith(true);
    expect(done).toBe(true);
  });

  it('lock while offline keeps the edit as ciphertext and syncs after unlock (I4)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    const noteId = crypto.randomUUID();
    api.updateNote.mockRejectedValueOnce(new ApiError(0, 'network'));
    await s.stashUnsaved(vaultId, noteId, 'my offline text', 't0');
    expect(s.getState().pendingCount).toBe(1);
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    expect(s.getState().pendingCount).toBe(1);
    api.updateNote.mockResolvedValue({ note: { updatedAt: 't1' } });
    // Without a session nothing is sent; signing back in sends it.
    const before = api.updateNote.mock.calls.length;
    await s.retryPending();
    expect(api.updateNote.mock.calls.length).toBe(before);
    expect(s.getState().pendingCount).toBe(1);
    mockUnlock();
    await s.unlock('ann', 'pw-ann-123456');
    await vi.waitFor(() => expect(s.getState().pendingCount).toBe(0));
    const sent = api.updateNote.mock.calls.at(-1)!;
    expect(sent[0]).toBe(noteId);
    expect(sent[1].encBody).toMatch(/^v1\./);
    expect(sent[1].encBody).not.toContain('offline');
  });

  it('turns a conflicting queued edit into a copy note and refreshes the list (I4)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.createNote.mockImplementation(async (_v: string, b: NoteBody) => headFor(b, 't1'));
    const created = await s.createNote(vaultId, null, 'Plan', '');
    api.updateNote.mockRejectedValue(new ApiError(409, 'conflict'));
    api.listVaults.mockResolvedValue({ vaults: [] });
    await s.stashUnsaved(vaultId, created.id, 'my plan text', 't1');
    expect(s.getState().pendingCount).toBe(0);
    const [copyVault, copy] = api.createNote.mock.calls.at(-1)!;
    expect(copyVault).toBe(vaultId);
    expect(copy.id).not.toBe(created.id);
    expect(copy.encMeta).toMatch(/^v1\./);
    expect(copy.encBody).toMatch(/^v1\./);
    expect(copy.encBody).not.toContain('plan');
    expect(s.getState().notice).toBe('Saved your changes as “Plan (unsaved copy)” because the note changed elsewhere.');
    await vi.waitFor(() => expect(api.listVaults).toHaveBeenCalled());
  });

  it('drops a queued edit once a slow save of the same text lands (I4)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    let release!: (v: { updatedAt: string }) => void;
    const slow = new Promise<{ updatedAt: string }>((r) => (release = r));
    await s.stashUnsaved(vaultId, crypto.randomUUID(), 'same text', 't0', { racing: { save: slow, sameText: true } });
    expect(s.getState().pendingCount).toBe(1);
    expect(api.updateNote).not.toHaveBeenCalled();
    release({ updatedAt: 't1' });
    await vi.waitFor(() => expect(s.getState().pendingCount).toBe(0));
    expect(api.updateNote).not.toHaveBeenCalled();
    expect(api.createNote).not.toHaveBeenCalled();
  });

  it('sends a queued edit on top of a slow save of older text (I4)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    let release!: (v: { updatedAt: string }) => void;
    const slow = new Promise<{ updatedAt: string }>((r) => (release = r));
    api.updateNote.mockResolvedValue({ note: { updatedAt: 't2' } });
    await s.stashUnsaved(vaultId, crypto.randomUUID(), 'newer text', 't0', { racing: { save: slow, sameText: false } });
    expect(api.updateNote).not.toHaveBeenCalled();
    release({ updatedAt: 't1' });
    await vi.waitFor(() => expect(s.getState().pendingCount).toBe(0));
    expect(api.updateNote).toHaveBeenCalledTimes(1);
    expect(api.updateNote.mock.calls[0][1].baseUpdatedAt).toBe('t1');
  });

  it('sends a queued edit with its own base when the slow save fails (I4)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    let fail!: (e: unknown) => void;
    const slow = new Promise<{ updatedAt: string }>((_r, j) => (fail = j));
    api.updateNote.mockResolvedValue({ note: { updatedAt: 't2' } });
    await s.stashUnsaved(vaultId, crypto.randomUUID(), 'same text', 't0', { racing: { save: slow, sameText: true } });
    fail(new ApiError(0, 'network'));
    await vi.waitFor(() => expect(s.getState().pendingCount).toBe(0));
    expect(api.updateNote.mock.calls[0][1].baseUpdatedAt).toBe('t0');
  });

  it('keeps edits stashed while a retry is already running (I4)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    let release!: (v: unknown) => void;
    api.updateNote.mockReturnValueOnce(new Promise((r) => (release = r)));
    api.updateNote.mockResolvedValue({ note: { updatedAt: 't2' } });
    const a = s.stashUnsaved(vaultId, crypto.randomUUID(), 'first', 't0');
    await vi.waitFor(() => expect(api.updateNote).toHaveBeenCalledTimes(1));
    const b = s.stashUnsaved(vaultId, crypto.randomUUID(), 'second', 't0');
    await vi.waitFor(() => expect(s.getState().pendingCount).toBe(2));
    release({ note: { updatedAt: 't1' } });
    await Promise.all([a, b]);
    expect(api.updateNote).toHaveBeenCalledTimes(2);
    expect(s.getState().pendingCount).toBe(0);
  });

  it('never sends one account’s queued edits with another account’s session (I4)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.updateNote.mockRejectedValue(new ApiError(0, 'network'));
    await s.stashUnsaved(vaultId, crypto.randomUUID(), 'ann text', 't0');
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    const calls = api.updateNote.mock.calls.length;
    await s.register({ username: 'bob', password: 'pw-bob-123456', setupToken: 'tok-12345678' });
    await s.retryPending();
    expect(api.updateNote.mock.calls.length).toBe(calls);
    expect(s.getState().pendingCount).toBe(1);
  });

  it('puts the copy at the vault root when the note’s folder was deleted elsewhere (I4)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.createNote.mockImplementation(async (_v: string, b: NoteBody) => headFor(b, 't1'));
    api.createFolder.mockImplementation(async (_v: string, b: { id: string; parentId: null }) => ({ folder: { ...b, createdAt: 'x', updatedAt: 'x' } }));
    const folder = await s.createFolder(vaultId, null, 'Work');
    const created = await s.createNote(vaultId, folder.id, 'Plan', '');
    api.updateNote.mockRejectedValue(new ApiError(404, 'not_found'));
    api.createNote.mockReset();
    api.createNote.mockRejectedValueOnce(new ApiError(400, 'invalid_folder')).mockResolvedValue(headFor({ id: 'c', folderId: null, encMeta: '', encBody: '' }, 't2'));
    api.listVaults.mockResolvedValue({ vaults: [] });
    await s.stashUnsaved(vaultId, created.id, 'kept text', 't1');
    expect(api.createNote.mock.calls[0][1].folderId).toBe(folder.id);
    expect(api.createNote.mock.calls[1][1].folderId).toBeNull();
    expect(s.getState().pendingCount).toBe(0);
    expect(s.getState().notice).toBe('Saved your changes as “Plan (unsaved copy)” because the note changed elsewhere.');
  });

  it('drops queued text whose vault was deleted elsewhere, and says so (I4)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.updateNote.mockRejectedValue(new ApiError(404, 'not_found'));
    api.createNote.mockRejectedValue(new ApiError(404, 'not_found'));
    await s.stashUnsaved(vaultId, crypto.randomUUID(), 'orphan text', 't1');
    expect(s.getState().pendingCount).toBe(0);
    expect(s.getState().notice).toBe('An unsaved change couldn’t be kept because its note or vault was deleted elsewhere.');
    expect(s.hasUnsavedWork()).toBe(false);
  });

  it('drops queued text the server refuses, with one notice for several (I4)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.updateNote.mockRejectedValue(new ApiError(0, 'network'));
    await s.stashUnsaved(vaultId, crypto.randomUUID(), 'one', 't1');
    await s.stashUnsaved(vaultId, crypto.randomUUID(), 'two', 't1');
    expect(s.getState().pendingCount).toBe(2);
    api.updateNote.mockRejectedValue(new ApiError(400, 'invalid_request'));
    await s.retryPending();
    expect(s.getState().pendingCount).toBe(0);
    expect(s.getState().notice).toBe('Some unsaved changes couldn’t be kept because their note or vault was deleted elsewhere.');
  });

  it('counts a flush in progress as unsaved work, for the close-tab prompt (I4)', async () => {
    const s = await registeredStore();
    expect(s.hasUnsavedWork()).toBe(false);
    let release!: () => void;
    const tracked = s.trackSettle(new Promise<void>((r) => (release = r)));
    expect(s.hasUnsavedWork()).toBe(true);
    release();
    await tracked;
    expect(s.hasUnsavedWork()).toBe(false);
  });

  it('a 401 flushes the open editor into the queue before dropping keys; it is sent after unlock (C1)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.createNote.mockImplementation(async (_v: string, b: NoteBody) => headFor(b, 't1'));
    const created = await s.createNote(vaultId, null, 'Plan', '');
    const noteSent: NoteBody = api.createNote.mock.calls[0][1];
    const ed = newSaveState(vaultId, created.id);
    ed.base = 't1';
    ed.body = 'typed before the 401';
    s.registerFlusher((final) => settle(s, ed, final));
    // Every request now gets 401, and the client reports each one.
    api.updateNote.mockImplementation(async () => {
      unauthorized.handler!();
      throw new ApiError(401, 'unauthorized');
    });
    unauthorized.handler!(); // e.g. another tab's lock ended the shared session
    await vi.waitFor(() => expect(s.getState().phase).toBe('signedOut'));
    expect(s.getState().notice).toBe('Your session ended. Sign in again.');
    expect(s.getState().pendingCount).toBe(1);
    expect(s.getState().bodies).toEqual({});

    // Sign back in: the queued ciphertext is sent and decrypts to the typed text.
    const vaultDto = { ...api.createVault.mock.calls[0][0], createdAt: 'x', updatedAt: 'x', noteCount: 1, activeNoteCount7d: 1 };
    mockUnlock([vaultDto]);
    api.updateNote.mockReset();
    api.updateNote.mockResolvedValue({ note: { updatedAt: 't2' } });
    await s.unlock('ann', 'pw-ann-123456');
    await vi.waitFor(() => expect(s.getState().pendingCount).toBe(0));
    const [id, sent] = api.updateNote.mock.calls.at(-1)!;
    expect(id).toBe(created.id);
    expect(sent.baseUpdatedAt).toBe('t1');
    expect(sent.encBody).toMatch(/^v1\./);
    expect(sent.encBody).not.toContain('typed');
    await vi.waitFor(() => expect(s.getState().vaults[vaultId]?.name).toBe('Personal'));
    api.getNote.mockResolvedValue({ note: { ...headFor(noteSent, 't2').note, encBody: sent.encBody } });
    expect((await s.loadNote(vaultId, created.id)).body).toBe('typed before the 401');
  });

  it('ignores 401s while the session is already ending (C1)', async () => {
    const s = await registeredStore();
    let release!: () => void;
    const flusher = vi.fn(() => new Promise<void>((r) => (release = r)));
    s.registerFlusher(flusher);
    unauthorized.handler!();
    unauthorized.handler!();
    expect(s.getState().locking).toBe(true);
    expect(flusher).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(s.getState().phase).toBe('signedOut'));
    expect(s.getState().locking).toBe(false);
    expect(flusher).toHaveBeenCalledTimes(1);
  });

  it('ignores a second lock or sign-out while a lock is in progress (C1)', async () => {
    const s = await registeredStore();
    let release!: () => void;
    const flusher = vi.fn(() => new Promise<void>((r) => (release = r)));
    s.registerFlusher(flusher);
    api.logout.mockResolvedValue({ ok: true });
    const first = s.lock();
    expect(s.getState().locking).toBe(true);
    const again = [s.lock(), s.signOut()];
    expect(flusher).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, ...again]);
    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(s.getState().locking).toBe(false);
    expect(s.getState().lastUsername).toBe('ann'); // the sign-out was a no-op
  });

  it('locks when another tab broadcasts a lock, flushing with the keys still present (C1)', async () => {
    const s = await registeredStore();
    const phases: string[] = [];
    const flusher = vi.fn(async (_final: boolean) => {
      phases.push(s.getState().phase);
    });
    s.registerFlusher(flusher);
    const peer = new FakeChannel('inked');
    peer.postMessage({ type: 'lock', tab: 'peer', id: 'L1', notice: 'Locked after 15 minutes without activity.' });
    await vi.waitFor(() => expect(s.getState().phase).toBe('signedOut'));
    expect(flusher).toHaveBeenCalledWith(true);
    expect(phases).toEqual(['unlocked']);
    expect(s.getState().notice).toBe('Locked after 15 minutes without activity.');
    expect(s.getState().lastUsername).toBe('ann');
    // The tab that started the lock ends the session.
    expect(api.logout).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(peer.received).toContainEqual({ type: 'lock-done', tab: expect.any(String), id: 'L1' }));
  });

  it('broadcasts a lock and ends the session once the other tabs have flushed (C1)', async () => {
    const s = await registeredStore();
    const peer = new FakeChannel('inked');
    peer.postMessage({ type: 'hello', tab: 'peer' });
    await vi.waitFor(() => expect(peer.received).toContainEqual({ type: 'here', tab: expect.any(String) }));
    api.logout.mockResolvedValue({ ok: true });
    const locking = s.lock();
    await vi.waitFor(() => expect(s.getState().phase).toBe('signedOut'));
    const lock = (peer.received as Msg[]).find((m) => m.type === 'lock')!;
    expect(lock).toBeDefined();
    expect(api.logout).not.toHaveBeenCalled();
    peer.postMessage({ type: 'lock-done', tab: 'peer', id: lock.id });
    await locking;
    expect(api.logout).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(peer.received).toContainEqual({ type: 'lock-end', tab: lock.tab, id: lock.id }));
  });

  it('ends the session after at most 4 s when another tab never answers (C1)', async () => {
    const s = await registeredStore();
    const peer = new FakeChannel('inked');
    peer.postMessage({ type: 'hello', tab: 'peer' });
    await vi.waitFor(() => expect(peer.received).toContainEqual({ type: 'here', tab: expect.any(String) }));
    api.logout.mockResolvedValue({ ok: true });
    vi.useFakeTimers();
    try {
      const locking = s.lock();
      await vi.advanceTimersByTimeAsync(3_900);
      expect(s.getState().phase).toBe('signedOut');
      expect(api.logout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      await locking;
      expect(api.logout).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a pending session end before signing in again (C1)', async () => {
    const s = await registeredStore();
    let release!: (v: unknown) => void;
    api.logout.mockReturnValue(new Promise((r) => (release = r)));
    const locking = s.lock();
    await vi.waitFor(() => expect(api.logout).toHaveBeenCalled());
    mockUnlock();
    const unlocking = s.unlock('ann', 'pw-ann-123456');
    await new Promise((r) => setTimeout(r, 50));
    expect(api.login).not.toHaveBeenCalled();
    release({ ok: true });
    await Promise.all([locking, unlocking]);
    expect(api.login).toHaveBeenCalledTimes(1);
    expect(s.getState().phase).toBe('unlocked');
  });

  it('shares activity across tabs, at most one ping per 15 s (C1)', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const s = new AppStore();
      const peer = new FakeChannel('inked');
      const pings = () => (peer.received as Msg[]).filter((m) => m.type === 'activity').length;
      s.markActive();
      s.markActive();
      await vi.advanceTimersByTimeAsync(1);
      expect(pings()).toBe(1);
      // Activity inside the window goes out once, when the window ends.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(pings()).toBe(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(pings()).toBe(2);
      expect(s.idleMs()).toBeGreaterThanOrEqual(75_000);
      // Activity in another tab counts here too.
      peer.postMessage({ type: 'activity', tab: 'peer' });
      await vi.advanceTimersByTimeAsync(1);
      expect(s.idleMs()).toBeLessThan(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a vault rename that finishes after lock (minor)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    let release!: (v: unknown) => void;
    api.updateVault.mockReturnValue(new Promise((r) => (release = r)));
    const p = s.updateVault(vaultId, { name: 'Secret name', color: '#45A89E' }).catch((e) => e);
    await vi.waitFor(() => expect(api.updateVault).toHaveBeenCalled());
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    release({ vault: { updatedAt: 't9' } });
    await p;
    expect(s.getState().vaults).toEqual({});
  });

  it('refuses to queue a body the server would never take (I4)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    await expect(s.stashUnsaved(vaultId, crypto.randomUUID(), 'x'.repeat(1_600_000))).rejects.toThrow(/too large/i);
    expect(s.getState().pendingCount).toBe(0);
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
