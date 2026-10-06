// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  status: vi.fn(), me: vi.fn(), params: vi.fn(), login: vi.fn(), logout: vi.fn(), setup: vi.fn(),
  listVaults: vi.fn(), createVault: vi.fn(), createNote: vi.fn(), getNote: vi.fn(), updateNote: vi.fn(),
  rotateRecoveryKey: vi.fn(), tree: vi.fn(), bodies: vi.fn(), createFolder: vi.fn(), updateVault: vi.fn(),
  recoverStart: vi.fn(), recoverFinish: vi.fn(),
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
import { aad, deriveRecoveryKeys, generateVaultKey, parseRecoveryKey, unwrapKey, unwrapVaultKey } from '../crypto';
import { adoptOwnHead, newSaveState, settle } from '../pages/useNoteEditor';
import { AppStore, LockedError, LOGOUT_TIMEOUT_MS, QUEUE_REQUEST_TIMEOUT_MS } from './store';

/** Captured before any test fakes timers: lets real async work (WebCrypto, argon2) run while fake time stands still. */
const realSetTimeout = globalThis.setTimeout;
const realWait = (ms: number) => new Promise((r) => realSetTimeout(r, ms));

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

  /** A registered store whose params/me reads answer like the server would. */
  async function rotatableStore() {
    const s = await registeredStore();
    const setupBody = api.setup.mock.calls[0][0];
    api.params.mockResolvedValue({ kdfSalt: setupBody.kdfSalt, kdfParams: setupBody.kdfParams });
    api.me.mockResolvedValue({ user: { id: setupBody.userId, username: 'ann', isAdmin: true }, wrappedUserKey: setupBody.wrappedUserKey });
    const vaultDto: { id: string; wrappedKey: string } = api.createVault.mock.calls[0][0];
    vi.clearAllMocks(); // keep the answers, forget the calls made while registering
    return { s, setupBody, vaultDto };
  }

  it('prepares a new recovery key without sending anything (I-2)', async () => {
    const { s, setupBody } = await rotatableStore();
    const prepared = await s.prepareRecoveryKeyRotation('pw-ann-123456');
    expect(prepared.text).toMatch(/^inked-rk1-/);
    expect(prepared.body.currentAuthKey).toBe(setupBody.authKey);
    expect(prepared.body.recoveryAuth).not.toBe(setupBody.recoveryAuth);
    expect(prepared.body.wrappedUserKeyRecovery).toMatch(/^v1\./);
    // Only reads: params and me.
    const called = Object.entries(api).filter(([, fn]) => fn.mock.calls.length).map(([name]) => name);
    expect(called.sort()).toEqual(['me', 'params']);
  });

  it('commits exactly the prepared body (I-2)', async () => {
    const { s } = await rotatableStore();
    const prepared = await s.prepareRecoveryKeyRotation('pw-ann-123456');
    api.rotateRecoveryKey.mockResolvedValue({ ok: true });
    await s.commitRecoveryKeyRotation(prepared);
    expect(api.rotateRecoveryKey).toHaveBeenCalledTimes(1);
    expect(api.rotateRecoveryKey.mock.calls[0][0]).toEqual(prepared.body);
  });

  it('the prepared recovery key really recovers the account (I-2)', async () => {
    const { s, setupBody, vaultDto } = await rotatableStore();
    const prepared = await s.prepareRecoveryKeyRotation('pw-ann-123456');
    const rk = await deriveRecoveryKeys(parseRecoveryKey(prepared.text));
    expect(rk.recoveryAuth).toBe(prepared.body.recoveryAuth);
    const userKey = await unwrapKey(prepared.body.wrappedUserKeyRecovery, rk.recoveryKEK, aad.userKeyRecovery(setupBody.userId), 'userKey');
    // The recovered key can wrap and unwrap a vault key...
    const vaultId = crypto.randomUUID();
    const { wrappedKey } = await generateVaultKey(vaultId, userKey);
    await expect(unwrapVaultKey(wrappedKey, userKey, vaultId)).resolves.toBeDefined();
    // ...and it is the account's userKey: it opens the vault made at registration.
    await expect(unwrapVaultKey(vaultDto.wrappedKey, userKey, vaultDto.id)).resolves.toBeDefined();
  });

  it('refuses a wrong password before sending anything (I-2)', async () => {
    const { s } = await rotatableStore();
    await expect(s.prepareRecoveryKeyRotation('wrong-password')).rejects.toMatchObject({ name: 'CryptoError', code: 'unwrap' });
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
    expect(s.getState().pendingCount).toBe(0); // bob's count (B2); ann's item stays queued
    expect(s.hasUnsavedWork()).toBe(true);
  });

  it('puts the copy at the vault root when the note’s folder was deleted elsewhere, and says why (I4, B1)', async () => {
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
    expect(s.getState().notice).toBe('Your changes to a note were saved as an “(unsaved copy)” note at the top of the vault because its folder was deleted.');
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

  it('drops queued text the server refuses, with one notice for several (I4, B1)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.updateNote.mockRejectedValue(new ApiError(0, 'network'));
    await s.stashUnsaved(vaultId, crypto.randomUUID(), 'one', 't1');
    await s.stashUnsaved(vaultId, crypto.randomUUID(), 'two', 't1');
    expect(s.getState().pendingCount).toBe(2);
    api.updateNote.mockRejectedValue(new ApiError(400, 'invalid_request'));
    await s.retryPending();
    expect(s.getState().pendingCount).toBe(0);
    expect(s.getState().notice).toBe('Some unsaved changes were rejected by the server and couldn’t be saved.');
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

  it('sign-out reaches every tab: they flush with their keys, then drop them; logout waits for them (A2)', async () => {
    const a = await registeredStore();
    const b = await registeredStore();
    // a has seen b's hello, so it waits for b's answer.
    await vi.waitFor(() => expect(FakeChannel.bus[0].received).toContainEqual({ type: 'hello', tab: expect.any(String) }));
    const vaultId = Object.keys(b.getState().vaults)[0];
    api.createNote.mockImplementation(async (_v: string, n: NoteBody) => headFor(n, 't1'));
    const created = await b.createNote(vaultId, null, 'Plan', '');
    const ed = newSaveState(vaultId, created.id);
    ed.base = 't1';
    ed.body = 'typed in tab b';
    b.registerFlusher((final) => settle(b, ed, final));
    const order: string[] = [];
    api.updateNote.mockImplementation(async (_id: string, body: { encBody: string }) => {
      order.push(body.encBody.startsWith('v1.') ? 'b-save' : 'b-save-plaintext?');
      return headFor({ ...api.createNote.mock.calls[0][1], encBody: body.encBody }, 't2');
    });
    b.subscribe(() => {
      if (b.getState().phase === 'signedOut' && !order.includes('b-signedOut')) order.push('b-signedOut');
    });
    api.logout.mockImplementation(async () => {
      order.push('logout');
      return { ok: true };
    });
    expect(localStorage.getItem('inked.lastUsername')).not.toBeNull();
    await a.signOut();
    expect(order).toEqual(['b-save', 'b-signedOut', 'logout']);
    expect(api.updateNote.mock.calls[0][0]).toBe(created.id);
    expect(b.getState().phase).toBe('signedOut');
    expect(b.getState().notice).toBeNull();
    expect(b.getState().lastUsername).toBe('');
    expect(b.getState().bodies).toEqual({});
    await expect(b.createVault('x', '#45A89E')).rejects.toBeInstanceOf(LockedError);
    expect(localStorage.getItem('inked.lastUsername')).toBeNull();
    expect(api.logout).toHaveBeenCalledTimes(1);
  });

  it('a sign-out from another tab during sign-in signs out once the sign-in lands (A2)', async () => {
    const s = await registeredStore();
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    mockUnlock();
    let release!: (v: unknown) => void;
    api.login.mockReturnValue(new Promise((r) => (release = r)));
    const unlocking = s.unlock('ann', 'pw-ann-123456');
    await vi.waitFor(() => expect(api.login).toHaveBeenCalled());
    const peer = new FakeChannel('inked');
    peer.postMessage({ type: 'signout', tab: 'peer', id: 'S1' });
    await vi.waitFor(() => expect(FakeChannel.bus[0].received).toContainEqual({ type: 'signout', tab: 'peer', id: 'S1' }));
    await new Promise((r) => setTimeout(r, 20));
    expect((peer.received as Msg[]).some((m) => m.type === 'lock-done')).toBe(false);
    const setupBody = api.setup.mock.calls[0][0];
    release({ user: { id: setupBody.userId, username: 'ann', isAdmin: true }, wrappedUserKey: setupBody.wrappedUserKey });
    await unlocking;
    await vi.waitFor(() => expect(peer.received).toContainEqual({ type: 'lock-done', tab: expect.any(String), id: 'S1' }));
    expect(s.getState().phase).toBe('signedOut');
    expect(s.getState().lastUsername).toBe('');
    expect(localStorage.getItem('inked.lastUsername')).toBeNull();
    await expect(s.createVault('x', '#45A89E')).rejects.toBeInstanceOf(LockedError);
    // The tab that signed out ends the session.
    expect(api.logout).toHaveBeenCalledTimes(1);
  });

  it('a hanging logout is aborted after LOGOUT_TIMEOUT_MS; lock completes and sign-in proceeds (A3)', async () => {
    const s = await registeredStore();
    mockUnlock();
    const signals: AbortSignal[] = [];
    api.logout.mockImplementation((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise(() => undefined); // never settles, even when aborted
    });
    vi.useFakeTimers();
    try {
      let locked = false;
      const locking = s.lock().then(() => (locked = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(s.getState().phase).toBe('signedOut');
      expect(api.logout).toHaveBeenCalledTimes(1);
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[0].aborted).toBe(false);
      const unlocking = s.unlock('ann', 'pw-ann-123456');
      await realWait(150); // the KDF runs on real crypto, then waits for the session end
      expect(api.login).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(LOGOUT_TIMEOUT_MS - 1);
      expect(locked).toBe(false);
      expect(api.login).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(signals[0].aborted).toBe(true);
      await locking;
      await unlocking;
      expect(api.login).toHaveBeenCalledTimes(1);
      expect(s.getState().phase).toBe('unlocked');
    } finally {
      vi.useRealTimers();
    }
  });

  it('register waits for a pending session end (A3)', async () => {
    const s = await registeredStore();
    let release!: (v: unknown) => void;
    api.logout.mockReturnValue(new Promise((r) => (release = r)));
    const locking = s.lock();
    await vi.waitFor(() => expect(api.logout).toHaveBeenCalled());
    const registering = s.register({ username: 'bob', password: 'pw-bob-123456', setupToken: 'tok-12345678' });
    await new Promise((r) => setTimeout(r, 150));
    expect(api.setup).toHaveBeenCalledTimes(1); // only ann's
    release({ ok: true });
    await Promise.all([locking, registering]);
    expect(api.setup).toHaveBeenCalledTimes(2);
    expect(s.getState().user?.username).toBe('bob');
  });

  it('recover waits for a pending session end (A3)', async () => {
    api.setup.mockImplementation(async (body: { userId: string; username: string }) => ({ user: { id: body.userId, username: body.username, isAdmin: true } }));
    api.createVault.mockImplementation(async (b: { id: string; encMeta: string; wrappedKey: string }) => ({ vault: { ...b, createdAt: 'x', updatedAt: 'x', noteCount: 0, activeNoteCount7d: 0 } }));
    const s = new AppStore();
    const rk = await s.register({ username: 'ann', password: 'pw-ann-123456', setupToken: 'tok-12345678' });
    const setupBody = api.setup.mock.calls[0][0];
    const ann = { id: setupBody.userId, username: 'ann', isAdmin: true };
    api.recoverStart.mockResolvedValue({ userId: setupBody.userId, wrappedUserKeyRecovery: setupBody.wrappedUserKeyRecovery });
    api.recoverFinish.mockImplementation(async (b: { wrappedUserKey: string }) => ({ user: ann, wrappedUserKey: b.wrappedUserKey }));
    api.listVaults.mockResolvedValue({ vaults: [] });
    let release!: (v: unknown) => void;
    api.logout.mockReturnValue(new Promise((r) => (release = r)));
    const locking = s.lock();
    await vi.waitFor(() => expect(api.logout).toHaveBeenCalled());
    const recovering = s.recover('ann', rk, 'pw-ann-new-123456');
    await new Promise((r) => setTimeout(r, 150));
    expect(api.recoverFinish).not.toHaveBeenCalled();
    release({ ok: true });
    await Promise.all([locking, recovering]);
    expect(api.recoverFinish).toHaveBeenCalledTimes(1);
    expect(s.getState().phase).toBe('unlocked');
  });

  it('a lock from another tab during sign-in locks once the sign-in lands (A3)', async () => {
    const s = await registeredStore();
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    mockUnlock();
    let release!: (v: unknown) => void;
    api.login.mockReturnValue(new Promise((r) => (release = r)));
    const unlocking = s.unlock('ann', 'pw-ann-123456');
    await vi.waitFor(() => expect(api.login).toHaveBeenCalled());
    const peer = new FakeChannel('inked');
    const notice = 'Locked after 15 minutes without activity.';
    peer.postMessage({ type: 'lock', tab: 'peer', id: 'L2', notice });
    await vi.waitFor(() => expect(FakeChannel.bus[0].received).toContainEqual({ type: 'lock', tab: 'peer', id: 'L2', notice }));
    await new Promise((r) => setTimeout(r, 20));
    // Not answered yet: the initiator's logout must wait for this sign-in to be locked.
    expect((peer.received as Msg[]).some((m) => m.type === 'lock-done')).toBe(false);
    const setupBody = api.setup.mock.calls[0][0];
    release({ user: { id: setupBody.userId, username: 'ann', isAdmin: true }, wrappedUserKey: setupBody.wrappedUserKey });
    await unlocking;
    await vi.waitFor(() => expect(peer.received).toContainEqual({ type: 'lock-done', tab: expect.any(String), id: 'L2' }));
    expect(s.getState().phase).toBe('signedOut');
    expect(s.getState().notice).toBe(notice);
    expect(s.getState().lastUsername).toBe('ann');
    expect(s.getState().vaults).toEqual({});
    await expect(s.createVault('x', '#45A89E')).rejects.toBeInstanceOf(LockedError);
    // Only this tab's own earlier lock logged out; the tab that started this lock ends the session.
    expect(api.logout).toHaveBeenCalledTimes(1);
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
    // B6: the caller hears that the session locked, like every other mutation.
    expect(await p).toBeInstanceOf(LockedError);
    expect(s.getState().vaults).toEqual({});
  });

  it('refuses to queue a body the server would never take (I4)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    await expect(s.stashUnsaved(vaultId, crypto.randomUUID(), 'x'.repeat(1_600_000))).rejects.toThrow(/too large/i);
    expect(s.getState().pendingCount).toBe(0);
  });

  // ---- Task 4: queue follow-ups (B1, B2, B6, C1) -------------------------------------------

  it('names the real cause when queued text is dropped, one notice per cause (B1)', async () => {
    const network = new ApiError(0, 'network');
    const cases: { reason: string; setup: () => void; one: string; many: string }[] = [
      {
        reason: 'deleted',
        setup: () => {
          api.updateNote.mockRejectedValue(new ApiError(404, 'not_found'));
          api.createNote.mockRejectedValue(new ApiError(404, 'not_found'));
        },
        one: 'An unsaved change couldn’t be kept because its note or vault was deleted elsewhere.',
        many: 'Some unsaved changes couldn’t be kept because their note or vault was deleted elsewhere.',
      },
      {
        reason: 'rejected',
        setup: () => api.updateNote.mockRejectedValue(new ApiError(400, 'invalid_request')),
        one: 'An unsaved change was rejected by the server and couldn’t be saved.',
        many: 'Some unsaved changes were rejected by the server and couldn’t be saved.',
      },
      {
        reason: 'too_large',
        setup: () => api.updateNote.mockRejectedValue(new ApiError(413, 'too_large')),
        one: 'An unsaved change was too large to save.',
        many: 'Some unsaved changes were too large to save.',
      },
    ];
    for (const c of cases) {
      for (const n of [1, 2]) {
        const s = await registeredStore();
        const vaultId = Object.keys(s.getState().vaults)[0];
        api.updateNote.mockRejectedValue(network);
        for (let i = 0; i < n; i++) await s.stashUnsaved(vaultId, crypto.randomUUID(), `text ${i}`, 't1');
        expect(s.getState().pendingCount).toBe(n);
        c.setup();
        await s.retryPending();
        expect(s.getState().pendingCount).toBe(0);
        expect([c.reason, s.getState().notice]).toEqual([c.reason, n === 1 ? c.one : c.many]);
      }
    }
  });

  it('says several copies went to the vault root because their folders were deleted (B1)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.createNote.mockImplementation(async (_v: string, b: NoteBody) => headFor(b, 't1'));
    api.createFolder.mockImplementation(async (_v: string, b: { id: string; parentId: null }) => ({ folder: { ...b, createdAt: 'x', updatedAt: 'x' } }));
    const folder = await s.createFolder(vaultId, null, 'Work');
    const one = await s.createNote(vaultId, folder.id, 'One', '');
    const two = await s.createNote(vaultId, folder.id, 'Two', '');
    api.updateNote.mockRejectedValue(new ApiError(0, 'network'));
    await s.stashUnsaved(vaultId, one.id, 'one text', 't1');
    await s.stashUnsaved(vaultId, two.id, 'two text', 't1');
    api.updateNote.mockRejectedValue(new ApiError(404, 'not_found'));
    api.createNote.mockImplementation(async (_v: string, b: NoteBody) => {
      if (b.folderId) throw new ApiError(400, 'invalid_folder');
      return headFor(b, 't2');
    });
    api.listVaults.mockResolvedValue({ vaults: [] });
    await s.retryPending();
    expect(s.getState().pendingCount).toBe(0);
    expect(s.getState().notice).toBe(
      'Your changes to 2 notes were saved as “(unsaved copy)” notes at the top of the vault because their folders were deleted.',
    );
  });

  it('keeps a copy notice produced during a lock’s flush and shows it after the next unlock (B1)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.createNote.mockImplementation(async (_v: string, b: NoteBody) => headFor(b, 't1'));
    const created = await s.createNote(vaultId, null, 'Secret plan', '');
    api.updateNote.mockRejectedValue(new ApiError(409, 'conflict'));
    s.registerFlusher(() => s.stashUnsaved(vaultId, created.id, 'my plan text', 't1'));
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    expect(api.createNote).toHaveBeenCalledTimes(2); // the copy was made during the flush
    expect(s.getState().notice).toBeNull();
    mockUnlock();
    await s.unlock('ann', 'pw-ann-123456');
    const notice = s.getState().notice;
    expect(notice).toBe('A note changed elsewhere while you were editing, so your version was saved as an “(unsaved copy)” note next to it.');
    // The plaintext title never outlives the keys.
    expect(notice).not.toContain('Secret');
  });

  it('counts only the signed-in account’s queued edits, and sends them only with its session (B2)', async () => {
    const s = await registeredStore(); // ann
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.updateNote.mockRejectedValue(new ApiError(0, 'network'));
    await s.stashUnsaved(vaultId, crypto.randomUUID(), 'ann text', 't0');
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    expect(s.getState().pendingCount).toBe(1); // ann was the last account here
    const sent = api.updateNote.mock.calls.length;
    await s.register({ username: 'bob', password: 'pw-bob-123456', setupToken: 'tok-12345678' });
    await s.retryPending();
    expect(s.getState().pendingCount).toBe(0);
    expect(api.updateNote.mock.calls.length).toBe(sent);
    await s.lock();
    expect(s.getState().pendingCount).toBe(0); // bob was the last account here
    mockUnlock();
    let release!: (v: unknown) => void;
    api.updateNote.mockReturnValue(new Promise((r) => (release = r)));
    await s.unlock('ann', 'pw-ann-123456');
    expect(s.getState().pendingCount).toBe(1);
    await vi.waitFor(() => expect(api.updateNote.mock.calls.length).toBe(sent + 1));
    release({ note: { updatedAt: 't1' } });
    await vi.waitFor(() => expect(s.getState().pendingCount).toBe(0));
  });

  it('shows no count while signed out once the account is forgotten (B2)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.updateNote.mockRejectedValue(new ApiError(0, 'network'));
    await s.stashUnsaved(vaultId, crypto.randomUUID(), 'text', 't0');
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    expect(s.getState().pendingCount).toBe(1);
    s.forgetUsername();
    expect(s.getState().pendingCount).toBe(0);
    expect(s.hasUnsavedWork()).toBe(true); // still queued, still warned about

    const t = await registeredStore();
    await t.stashUnsaved(Object.keys(t.getState().vaults)[0], crypto.randomUUID(), 'text', 't0');
    expect(t.getState().pendingCount).toBe(1);
    await t.signOut();
    expect(t.getState().pendingCount).toBe(0);
  });

  it('refreshes the note’s head and loaded body after a queued save lands; a later save uses the new base (B2)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.createNote.mockImplementation(async (_v: string, b: NoteBody) => headFor(b, '2026-01-01T00:00:00.000Z'));
    const created = await s.createNote(vaultId, null, 'Plan', 'old text');
    const noteSent: NoteBody = api.createNote.mock.calls[0][1];
    // A tiny server: accepts a save only on top of its current version.
    const server = { at: '2026-01-01T00:00:00.000Z', encBody: noteSent.encBody, n: 1 };
    api.updateNote.mockImplementation(async (_id: string, b: { encBody: string; baseUpdatedAt?: string }) => {
      if (b.baseUpdatedAt !== server.at) throw new ApiError(409, 'conflict');
      server.at = `2026-01-0${++server.n}T00:00:00.000Z`;
      server.encBody = b.encBody;
      return headFor(noteSent, server.at);
    });
    api.getNote.mockImplementation(async () => ({ note: { ...headFor(noteSent, server.at).note, encBody: server.encBody } }));
    await s.stashUnsaved(vaultId, created.id, 'queued text', '2026-01-01T00:00:00.000Z');
    expect(s.getState().pendingCount).toBe(0);
    await vi.waitFor(() => expect(s.getState().trees[vaultId].notes[created.id].updatedAt).toBe('2026-01-02T00:00:00.000Z'));
    expect(s.getState().bodies[created.id]).toBe('queued text');
    expect(s.isOwnStamp(created.id, '2026-01-02T00:00:00.000Z')).toBe(false); // not adopted by open editors

    // An editor opened on the note afterwards saves on top of the queued text without a conflict.
    const { head, body } = await s.loadNote(vaultId, created.id);
    const ed = newSaveState(vaultId, created.id);
    ed.base = head.updatedAt;
    ed.savedBody = body;
    ed.body = `${body}, then more`;
    await settle(s, ed, false);
    expect(ed.base).toBe('2026-01-03T00:00:00.000Z');
    expect(s.getState().pendingCount).toBe(0);
    expect(api.createNote).toHaveBeenCalledTimes(1); // no copy note
    expect(s.getState().bodies[created.id]).toBe('queued text, then more');
  });


  it('a head refreshed after a queued save never moves an open editor’s base: its next save conflicts and the queued text survives (B2)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    const t1 = '2026-01-01T00:00:00.000Z';
    const t2 = '2026-01-02T00:00:00.000Z';
    api.createNote.mockImplementation(async (_v: string, b: NoteBody) => headFor(b, t1));
    const created = await s.createNote(vaultId, null, 'Plan', 'old text');
    const noteSent: NoteBody = api.createNote.mock.calls[0][1];
    // A tiny server: accepts a save only on top of its current version.
    const server = { at: t1, encBody: noteSent.encBody, n: 1 };
    api.updateNote.mockImplementation(async (_id: string, b: { encBody: string; baseUpdatedAt?: string }) => {
      if (b.baseUpdatedAt !== server.at) throw new ApiError(409, 'conflict');
      server.at = `2026-01-0${++server.n}T00:00:00.000Z`;
      server.encBody = b.encBody;
      return headFor(noteSent, server.at);
    });
    api.getNote.mockImplementation(async () => ({ note: { ...headFor(noteSent, server.at).note, encBody: server.encBody } }));
    api.listVaults.mockResolvedValue({ vaults: [] });
    // An editor opened the note before the queued save landed: old base, old text plus typing.
    const ed = newSaveState(vaultId, created.id);
    ed.base = t1;
    ed.savedBody = 'old text';
    ed.body = 'old text, typed in the editor';

    await s.stashUnsaved(vaultId, created.id, 'queued text', t1);
    await vi.waitFor(() => expect(s.getState().trees[vaultId].notes[created.id].updatedAt).toBe(t2));
    const queued = server.encBody;
    expect(s.isOwnStamp(created.id, t2)).toBe(false);
    // NotePane hands every new head to the editor.
    adoptOwnHead(s, ed, s.getState().trees[vaultId].notes[created.id]);
    expect(ed.base).toBe(t1);

    // The editor's next save conflicts instead of replacing the queued text...
    await settle(s, ed, false);
    expect(server.at).toBe(t2);
    expect(server.encBody).toBe(queued);
    // ...and the queue keeps the editor's text as a copy note.
    expect(api.createNote).toHaveBeenCalledTimes(2);
    expect(api.createNote.mock.calls[1][1].id).not.toBe(created.id);
    expect(s.getState().pendingCount).toBe(0);
  });
  it('a queued send that never answers times out after 30 s and is retried (B2)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.updateNote.mockReturnValueOnce(new Promise(() => undefined)).mockResolvedValue({ note: { updatedAt: 't2' } });
    vi.useFakeTimers();
    try {
      let done = false;
      const stashing = s.stashUnsaved(vaultId, crypto.randomUUID(), 'text', 't0').then(() => (done = true));
      while (!api.updateNote.mock.calls.length) await realWait(5); // encryption runs on real crypto
      expect(api.updateNote.mock.calls[0][2]).toEqual({ timeoutMs: QUEUE_REQUEST_TIMEOUT_MS });
      expect(QUEUE_REQUEST_TIMEOUT_MS).toBe(30_000);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(done).toBe(false);
      expect(api.updateNote).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await stashing;
      expect(api.updateNote).toHaveBeenCalledTimes(2);
      expect(s.getState().pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a racing save that never answers holds the queued edit for at most 30 s (B2)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.updateNote.mockResolvedValue({ note: { updatedAt: 't2' } });
    vi.useFakeTimers();
    try {
      await s.stashUnsaved(vaultId, crypto.randomUUID(), 'text', 't0', { racing: { save: new Promise(() => undefined), sameText: true } });
      expect(s.getState().pendingCount).toBe(1);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(api.updateNote).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(api.updateNote).toHaveBeenCalledTimes(1);
      expect(api.updateNote.mock.calls[0][1].baseUpdatedAt).toBe('t0');
      expect(s.getState().pendingCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries the queue when the browser comes back online (C1)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.updateNote.mockRejectedValue(new ApiError(0, 'network'));
    await s.stashUnsaved(vaultId, crypto.randomUUID(), 'text', 't0');
    expect(s.getState().pendingCount).toBe(1);
    api.updateNote.mockResolvedValue({ note: { updatedAt: 't1' } });
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(s.getState().pendingCount).toBe(0));
  });

  it('retries every 30 s while edits are queued, and stops once the queue is empty (C1)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.updateNote.mockRejectedValue(new ApiError(0, 'network'));
    vi.useFakeTimers();
    try {
      await s.stashUnsaved(vaultId, crypto.randomUUID(), 'text', 't0');
      expect(s.getState().pendingCount).toBe(1);
      expect(vi.getTimerCount()).toBe(1); // the retry interval
      await vi.advanceTimersByTimeAsync(30_000);
      expect(api.updateNote).toHaveBeenCalledTimes(2);
      expect(s.getState().pendingCount).toBe(1);
      api.updateNote.mockResolvedValue({ note: { updatedAt: 't1' } });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(api.updateNote).toHaveBeenCalledTimes(3);
      expect(s.getState().pendingCount).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(90_000);
      expect(api.updateNote).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks before the tab closes while edits are queued (C1)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    api.updateNote.mockRejectedValue(new ApiError(0, 'network'));
    await s.stashUnsaved(vaultId, crypto.randomUUID(), 'text', 't0');
    expect(s.hasUnsavedWork()).toBe(true);
    // jsdom has no BeforeUnloadEvent: give a plain event a writable returnValue like the real one.
    const e = new Event('beforeunload', { cancelable: true });
    Object.defineProperty(e, 'returnValue', { value: '', writable: true, configurable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect((e as unknown as { returnValue: unknown }).returnValue).toBe(true);
  });

  it('register waits, right before its session request, for a peer lock that arrived while it derived keys (A3)', async () => {
    const s = await registeredStore();
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    const peer = new FakeChannel('inked');
    peer.postMessage({ type: 'lock', tab: 'peer', id: 'L9', notice: null });
    const registering = s.register({ username: 'bob', password: 'pw-bob-123456', setupToken: 'tok-12345678' });
    await vi.waitFor(() => expect(peer.received).toContainEqual({ type: 'lock-done', tab: expect.any(String), id: 'L9' }));
    await new Promise((r) => setTimeout(r, 150));
    expect(api.setup).toHaveBeenCalledTimes(1); // only ann's
    peer.postMessage({ type: 'lock-end', tab: 'peer', id: 'L9' });
    await registering;
    expect(api.setup).toHaveBeenCalledTimes(2);
    expect(s.getState().user?.username).toBe('bob');
  });

  it('a sign-out from another tab during this tab’s own lock forgets the username (A2)', async () => {
    const s = await registeredStore();
    let release!: () => void;
    s.registerFlusher(() => new Promise<void>((r) => (release = r)));
    api.logout.mockResolvedValue({ ok: true });
    const locking = s.lock();
    expect(s.getState().locking).toBe(true);
    const peer = new FakeChannel('inked');
    peer.postMessage({ type: 'signout', tab: 'peer', id: 'S9' });
    await vi.waitFor(() => expect(FakeChannel.bus[0].received).toContainEqual({ type: 'signout', tab: 'peer', id: 'S9' }));
    release();
    await locking;
    expect(s.getState().phase).toBe('signedOut');
    expect(localStorage.getItem('inked.lastUsername')).toBeNull();
    expect(s.getState().lastUsername).toBe('');
  });
});

describe('rotationCommitError (I-2)', () => {
  it('says the old key still works only when the server definitely refused', async () => {
    const { rotationCommitError } = await import('../lib/util');
    const definite = 'Not saved — your old recovery key still works.';
    const unknown = 'We couldn’t confirm the change. Keep BOTH your old and new recovery keys; one of them works. Try again from Settings to be sure.';
    expect(rotationCommitError(new ApiError(403, 'invalid_credentials'))).toBe(definite);
    expect(rotationCommitError(new ApiError(400, 'invalid_request'))).toBe(definite);
    expect(rotationCommitError(new ApiError(429, 'locked'))).toBe(definite);
    expect(rotationCommitError(new ApiError(0, 'network'))).toBe(unknown);
    expect(rotationCommitError(new ApiError(500, 'internal'))).toBe(unknown);
    expect(rotationCommitError(new ApiError(502, 'http_502'))).toBe(unknown);
    expect(rotationCommitError(new TypeError('boom'))).toBe(unknown);
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
