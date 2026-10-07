// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same fake API and fast KDF as store.test.ts.
const api = vi.hoisted(() => ({
  status: vi.fn(), me: vi.fn(), params: vi.fn(), login: vi.fn(), logout: vi.fn(), setup: vi.fn(),
  listVaults: vi.fn(), createVault: vi.fn(), createNote: vi.fn(), getNote: vi.fn(), updateNote: vi.fn(),
  tree: vi.fn(), bodies: vi.fn(),
}));
vi.mock('../api/client', async (orig) => ({
  ...(await orig<typeof import('../api/client')>()),
  api,
  setUnauthorizedHandler: () => undefined,
  setUserMismatchHandler: () => undefined,
  setRequestUser: () => undefined,
}));
vi.mock('inked-core', async (orig) => {
  const m = await orig<typeof import('inked-core')>();
  const fast = { alg: 'argon2id' as const, m: 1024, t: 1, p: 1 };
  return { ...m, DEFAULT_KDF_PARAMS: fast, MIN_KDF_PARAMS: fast, assertKdfParams: (p: unknown) => p };
});
vi.mock('../lib/argon2Worker', async () => {
  const { argon2id } = await import('hash-wasm');
  return {
    argon2InWorker: async (pw: Uint8Array, salt: Uint8Array, p: { m: number; t: number; p: number }) =>
      argon2id({ password: pw, salt, memorySize: p.m, iterations: p.t, parallelism: p.p, hashLength: 32, outputType: 'binary' }),
  };
});

import { AppStore } from './store';

/** In-memory BroadcastChannel with no peers: this store is the only tab. */
class LoneChannel {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  postMessage() {}
  close() {}
}
vi.stubGlobal('BroadcastChannel', LoneChannel);

type NoteBody = { id: string; folderId: string | null; encMeta: string; encBody: string };
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-02T00:00:00.000Z';
const headDTO = (b: NoteBody, updatedAt: string) => ({ id: b.id, folderId: b.folderId, encMeta: b.encMeta, size: 1, createdAt: T0, updatedAt });

/** A registered, unlocked store with one vault holding note `n` (and `m` when asked), both at T0. */
async function storeWithNotes(titles: string[]) {
  api.setup.mockImplementation(async (body: { userId: string; username: string }) => ({ user: { id: body.userId, username: body.username, isAdmin: true } }));
  api.createVault.mockImplementation(async (b: { id: string; encMeta: string; wrappedKey: string }) => ({
    vault: { ...b, createdAt: T0, updatedAt: T0, noteCount: 0, activeNoteCount7d: 0 },
  }));
  api.createNote.mockImplementation(async (_v: string, b: NoteBody) => ({ note: headDTO(b, T0) }));
  const s = new AppStore();
  await s.register({ username: 'ann', password: 'pw-ann-123456', setupToken: 'tok-12345678' });
  const vaultId = Object.keys(s.getState().vaults)[0];
  const notes: NoteBody[] = [];
  for (const t of titles) {
    await s.createNote(vaultId, null, t, `${t} body`);
    notes.push(api.createNote.mock.calls[notes.length][1]);
  }
  s.consumeUnseenSaves(); // the creates themselves
  return { s, vaultId, notes };
}

describe('AppStore notes saved event', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    api.logout.mockResolvedValue({ ok: true });
  });

  it('fires for a saved note body and collects it as unseen', async () => {
    const { s, vaultId, notes } = await storeWithNotes(['n']);
    const n = notes[0];
    api.updateNote.mockResolvedValue({ note: headDTO(n, T1) });
    const seen = vi.fn();
    s.onNotesSaved(seen);
    await s.saveNoteBody(vaultId, n.id, 'new text');
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith([n.id]);
    expect(s.consumeUnseenSaves()).toEqual([n.id]);
    expect(s.consumeUnseenSaves()).toEqual([]);
  });

  it('does not fire for a late save carrying an older head', async () => {
    const { s, vaultId, notes } = await storeWithNotes(['n']);
    const n = notes[0];
    api.updateNote.mockResolvedValueOnce({ note: headDTO(n, T1) });
    await s.saveNoteBody(vaultId, n.id, 'newer');
    s.consumeUnseenSaves();
    const seen = vi.fn();
    s.onNotesSaved(seen);
    api.updateNote.mockResolvedValueOnce({ note: headDTO(n, T0) });
    await s.saveNoteBody(vaultId, n.id, 'late');
    expect(seen).not.toHaveBeenCalled();
    expect(s.consumeUnseenSaves()).toEqual([]);
  });

  it('fires from a tree reload only for notes with a newer updatedAt, not on first load', async () => {
    const { s, vaultId, notes } = await storeWithNotes(['n', 'm']);
    const [n, m] = notes;
    const vaultBody = api.createVault.mock.calls[0][0];
    const vault = { ...vaultBody, createdAt: T0, updatedAt: T0, noteCount: 2, activeNoteCount7d: 0 };
    await s.lock();

    // Sign back in: loadAll fetches this vault's tree for the first time this session.
    const setupBody = api.setup.mock.calls[0][0];
    api.params.mockResolvedValue({ kdfSalt: setupBody.kdfSalt, kdfParams: setupBody.kdfParams });
    api.login.mockResolvedValue({ user: { id: setupBody.userId, username: 'ann', isAdmin: true }, wrappedUserKey: setupBody.wrappedUserKey });
    api.listVaults.mockResolvedValue({ vaults: [vault] });
    api.tree.mockResolvedValue({ folders: [], notes: [headDTO(n, T0), headDTO(m, T0)] });
    api.bodies.mockResolvedValue({ notes: [] });
    const seen = vi.fn();
    s.onNotesSaved(seen);
    await s.unlock('ann', 'pw-ann-123456');
    await vi.waitFor(() => expect(s.getState().bodiesReady[vaultId]).toBe(true));
    expect(s.getState().trees[vaultId].notes[n.id].title).toBe('n');
    expect(seen).not.toHaveBeenCalled();
    expect(s.consumeUnseenSaves()).toEqual([]);

    // A reload where only n changed elsewhere.
    api.tree.mockResolvedValue({ folders: [], notes: [headDTO(n, T1), headDTO(m, T0)] });
    await s.loadTree(vaultId);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith([n.id]);
    expect(s.consumeUnseenSaves()).toEqual([n.id]);
  });

  it('forgets unseen saves on lock', async () => {
    const { s, vaultId, notes } = await storeWithNotes(['n']);
    const n = notes[0];
    api.updateNote.mockResolvedValue({ note: headDTO(n, T1) });
    const seen = vi.fn();
    s.onNotesSaved(seen);
    await s.saveNoteBody(vaultId, n.id, 'x');
    expect(seen).toHaveBeenCalledWith([n.id]);
    await s.lock();
    expect(s.consumeUnseenSaves()).toEqual([]);
  });

  it('noteHead finds a note in any loaded tree', async () => {
    const { s, notes } = await storeWithNotes(['n']);
    expect(s.noteHead(notes[0].id)?.title).toBe('n');
    expect(s.noteHead('missing')).toBeUndefined();
  });

  it('round-trips a note vector under the vault key', async () => {
    const { s, vaultId, notes } = await storeWithNotes(['n']);
    const chunk = new Int8Array(384).fill(3);
    const ct = await s.encryptVector(vaultId, notes[0].id, 'bge@1', [chunk]);
    expect(await s.decryptVector(vaultId, notes[0].id, 'bge@1', ct)).toEqual([chunk]);
    await expect(s.decryptVector(vaultId, notes[0].id, 'other@1', ct)).rejects.toThrow();
  });
});
