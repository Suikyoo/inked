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

import { RESAVE_DEBOUNCE_MS, SemanticStore } from '../semantic/semanticStore';
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
const OLDER = '2025-12-01T00:00:00.000Z';
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

/** Locks, then prepares `unlock('ann', …)` to sign back in to the registered account and its vault. */
async function relock(s: AppStore) {
  const vaultBody = api.createVault.mock.calls[0][0];
  await s.lock();
  const setupBody = api.setup.mock.calls[0][0];
  api.params.mockResolvedValue({ kdfSalt: setupBody.kdfSalt, kdfParams: setupBody.kdfParams });
  api.login.mockResolvedValue({ user: { id: setupBody.userId, username: 'ann', isAdmin: true }, wrappedUserKey: setupBody.wrappedUserKey });
  api.listVaults.mockResolvedValue({ vaults: [{ ...vaultBody, createdAt: T0, updatedAt: T0, noteCount: 1, activeNoteCount7d: 0 }] });
  api.bodies.mockResolvedValue({ notes: [] });
}

/** Note n's body encrypted as `text`, without storing it here: the save answers with an older head, so it is dropped. */
async function bodyCiphertext(s: AppStore, vaultId: string, n: NoteBody, text: string): Promise<string> {
  api.updateNote.mockResolvedValueOnce({ note: headDTO(n, OLDER) });
  await s.saveNoteBody(vaultId, n.id, text);
  return api.updateNote.mock.calls[api.updateNote.mock.calls.length - 1][1].encBody;
}

/** A promise and its resolver, to hold a fake response until the test lets it through. */
function gate<T>() {
  let release!: (v: T) => void;
  const promise = new Promise<T>((r) => (release = r));
  return { promise, release };
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
    // Sign back in: loadAll fetches this vault's tree for the first time this session.
    await relock(s);
    api.tree.mockResolvedValue({ folders: [], notes: [headDTO(n, T0), headDTO(m, T0)] });
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

  it('a reload emits a save made here during the request once, and keeps its newer head', async () => {
    const { s, vaultId, notes } = await storeWithNotes(['n']);
    const n = notes[0];
    const tree = gate<unknown>();
    api.tree.mockReturnValue(tree.promise);
    const seen = vi.fn();
    s.onNotesSaved(seen);
    const reloading = s.loadTree(vaultId);
    api.updateNote.mockResolvedValue({ note: headDTO(n, T1) });
    await s.saveNoteBody(vaultId, n.id, 'mine');
    expect(seen).toHaveBeenCalledWith([n.id]);
    // The response was read before the save landed.
    tree.release({ folders: [], notes: [headDTO(n, T0)] });
    await reloading;
    expect(seen).toHaveBeenCalledTimes(1);
    expect(s.getState().trees[vaultId].notes[n.id].updatedAt).toBe(T1);
    expect(s.getState().bodies[n.id]).toBe('mine');
    expect(s.consumeUnseenSaves()).toEqual([n.id]);
  });

  it('a reload after a failed load still reports notes changed elsewhere', async () => {
    const { s, vaultId, notes } = await storeWithNotes(['n']);
    const n = notes[0];
    api.tree.mockRejectedValueOnce(new Error('offline'));
    await expect(s.loadTree(vaultId)).rejects.toThrow('offline');
    expect(s.getState().trees[vaultId].status).toBe('error');
    const seen = vi.fn();
    s.onNotesSaved(seen);
    api.tree.mockResolvedValue({ folders: [], notes: [headDTO(n, T1)] });
    api.bodies.mockResolvedValue({ notes: [] });
    await s.loadTree(vaultId);
    expect(seen).toHaveBeenCalledWith([n.id]);
  });

  it('a note opened while the first tree load runs is not reported as saved', async () => {
    const { s, vaultId, notes } = await storeWithNotes(['n']);
    const n = notes[0];
    await relock(s);
    const tree = gate<unknown>();
    api.tree.mockReturnValue(tree.promise);
    const seen = vi.fn();
    s.onNotesSaved(seen);
    await s.unlock('ann', 'pw-ann-123456');
    await vi.waitFor(() => expect(s.getState().trees[vaultId]?.status).toBe('loading'));
    // A deep link: the note page loads its note before the vault's tree is in.
    api.getNote.mockResolvedValue({ note: { ...headDTO(n, T0), encBody: n.encBody } });
    const { body } = await s.loadNote(vaultId, n.id);
    expect(body).toBe('n body');
    tree.release({ folders: [], notes: [headDTO(n, T0)] });
    await vi.waitFor(() => expect(s.getState().bodiesReady[vaultId]).toBe(true));
    expect(seen).not.toHaveBeenCalled();
    expect(s.consumeUnseenSaves()).toEqual([]);
  });

  it('a reload drops the old text of notes changed elsewhere and fetches the new text', async () => {
    const { s, vaultId, notes } = await storeWithNotes(['x']);
    const x = notes[0];
    const newCt = await bodyCiphertext(s, vaultId, x, 'new text');
    expect(s.getState().bodies[x.id]).toBe('x body');
    const bodies = gate<unknown>();
    api.bodies.mockReturnValue(bodies.promise);
    api.tree.mockResolvedValue({ folders: [], notes: [headDTO(x, T1)] });
    await s.loadTree(vaultId);
    expect(s.getState().trees[vaultId].notes[x.id].updatedAt).toBe(T1);
    expect(x.id in s.getState().bodies).toBe(false);
    expect(api.bodies).toHaveBeenCalledWith(vaultId);
    bodies.release({ notes: [{ id: x.id, encBody: newCt, updatedAt: T1 }] });
    await vi.waitFor(() => expect(s.getState().bodies[x.id]).toBe('new text'));
  });

  it('bodies fetched before a reload never come back as the new text', async () => {
    const { s, vaultId, notes } = await storeWithNotes(['x']);
    const x = notes[0];
    const oldCt = x.encBody;
    const early = gate<unknown>();
    api.bodies.mockReturnValueOnce(early.promise);
    const loading = s.loadBodies(vaultId);
    api.bodies.mockReturnValue(new Promise(() => {})); // the reload's own refetch never answers
    api.tree.mockResolvedValue({ folders: [], notes: [headDTO(x, T1)] });
    await s.loadTree(vaultId);
    early.release({ notes: [{ id: x.id, encBody: oldCt, updatedAt: T0 }] });
    await loading;
    expect(x.id in s.getState().bodies).toBe(false);
  });
});

describe('SemanticStore on a real AppStore', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    localStorage.clear();
    api.logout.mockResolvedValue({ ok: true });
  });

  it('a reload never uploads the old text under the new version, and embeds the new text once it arrives', async () => {
    const { s, vaultId, notes } = await storeWithNotes(['x']);
    const x = notes[0];
    const newCt = await bodyCiphertext(s, vaultId, x, 'new text');

    // Fake model: remembers the text it last embedded, so each upload can be paired with its text.
    let lastText = '';
    const uploads: { sourceUpdatedAt: string; text: string }[] = [];
    const embedder = {
      paused: false,
      load: async (_m: unknown, p: (l: number, t: number) => void) => p(1, 1),
      embed: async (texts: string[]) => {
        lastText = texts.join(' ');
        return texts.map(() => new Float32Array(384).fill(1));
      },
      terminate: () => undefined,
    };
    const semantic = new SemanticStore(s, {
      api: {
        listVectors: async () => ({ vectors: [] }),
        putVector: async (_id, body) => (uploads.push({ sourceUpdatedAt: body.sourceUpdatedAt, text: lastText }), { ok: true as const }),
      },
      fetchManifest: async () => ({ model: 'bge', id: 'bge@1', revision: '1', modelPath: '1/', ortPath: 'o/', files: [] }),
      makeEmbedder: () => embedder,
      prefs: { semantic: () => true, setSemantic: () => undefined },
      cache: { verify: async () => 0, clear: async () => undefined, persist: async () => true },
      delay: async () => undefined,
    });
    try {
      await vi.waitFor(() => expect(uploads).toEqual([{ sourceUpdatedAt: T0, text: 'x\nx body' }]));

      // x was edited elsewhere at T1; its new text is slow to arrive.
      const bodies = gate<unknown>();
      api.bodies.mockReturnValue(bodies.promise);
      api.tree.mockResolvedValue({ folders: [], notes: [headDTO(x, T1)] });
      await s.loadTree(vaultId);
      expect(semantic.getState().coverage[vaultId]).toEqual({ done: 0, total: 1 });
      await new Promise((r) => setTimeout(r, RESAVE_DEBOUNCE_MS + 200));
      expect(uploads).toHaveLength(1);

      bodies.release({ notes: [{ id: x.id, encBody: newCt, updatedAt: T1 }] });
      await vi.waitFor(() => expect(uploads).toHaveLength(2));
      expect(uploads[1]).toEqual({ sourceUpdatedAt: T1, text: 'x\nnew text' });
      expect(uploads.filter((u) => u.sourceUpdatedAt === T1 && u.text.includes('x body'))).toEqual([]);
      expect(semantic.getState().coverage[vaultId]).toEqual({ done: 1, total: 1 });
    } finally {
      semantic.dispose();
    }
  });
});
