import { describe, expect, it, vi } from 'vitest';
import { RESAVE_DEBOUNCE_MS, SemanticStore, UPLOAD_BACKOFF_MS } from './semanticStore';

// Fake AppStore: minimal surface used by SemanticStore.
function fakeApp() {
  let state: any = { phase: 'locked', trees: {}, bodies: {}, bodiesReady: {} };
  const ls = new Set<() => void>();
  const saved = new Set<(ids: string[]) => void>();
  return {
    getState: () => state,
    subscribe: (f: () => void) => (ls.add(f), () => ls.delete(f)),
    set(p: any) {
      state = { ...state, ...p };
      ls.forEach((f) => f());
    },
    onNotesSaved: (f: (ids: string[]) => void) => (saved.add(f), () => saved.delete(f)),
    save(ids: string[]) {
      saved.forEach((f) => f(ids));
    },
    encryptVector: vi.fn(async (_v: string, n: string, _m: string, chunks: Int8Array[]) => `v1.${n}.${chunks.length}`),
    decryptVector: vi.fn(async () => [new Int8Array(384).fill(1)]),
    noteHead: (id: string) => Object.values(state.trees).flatMap((t: any) => Object.values(t.notes)).find((n: any) => n.id === id),
  };
}
const manifest = { model: 'bge', id: 'bge@1', revision: '1', modelPath: '1/', ortPath: 'o/', files: [] };
/** Deterministic unit vector from text: one-hot on a hash bucket. */
const fakeVec = (t: string) => {
  const v = new Float32Array(384);
  let h = 0;
  for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 384;
  v[h] = 1;
  return v;
};
function makeEmbedderStub() {
  return { paused: false, load: vi.fn(async (_m: unknown, p: (l: number, t: number) => void) => p(10, 10)), embed: vi.fn(async (ts: string[]) => ts.map(fakeVec)), terminate: vi.fn() };
}
function deps(over: Record<string, unknown> = {}) {
  const embedder = makeEmbedderStub();
  return {
    embedder,
    d: {
      api: { listVectors: vi.fn(async () => ({ vectors: [] as unknown[] })), putVector: vi.fn(async (_id: string, _body: { model: string; encVec: string; sourceUpdatedAt: string }) => ({ ok: true as const })) },
      fetchManifest: vi.fn(async () => manifest),
      makeEmbedder: () => embedder,
      prefs: { semantic: () => true, setSemantic: vi.fn() },
      cache: { verify: vi.fn(async () => 0), clear: vi.fn(async () => {}), persist: vi.fn(async () => true) },
      delay: () => Promise.resolve(),
      ...over,
    },
  };
}
const tree = (notes: { id: string; updatedAt: string; title?: string }[]) => ({
  v: { status: 'ready', folders: {}, notes: Object.fromEntries(notes.map((n) => [n.id, { vaultId: 'v', folderId: null, title: n.title ?? n.id, size: 1, createdAt: n.updatedAt, ...n }])) },
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const flushN = async (n: number) => {
  for (let i = 0; i < n; i++) await flush();
};

describe('SemanticStore', () => {
  it('is unavailable without a manifest and never loads a model', async () => {
    const app = fakeApp();
    const { d, embedder } = deps({ fetchManifest: async () => null });
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked' });
    await flush();
    expect(s.getState().available).toBe(false);
    expect(s.getState().phase).toBe('unavailable');
    expect(embedder.load).not.toHaveBeenCalled();
  });

  it('embeds stale notes newest first, uploads, and reports coverage', async () => {
    const app = fakeApp();
    const { d } = deps();
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked', trees: tree([{ id: 'a', updatedAt: '2026-10-01T00:00:00.000Z' }, { id: 'b', updatedAt: '2026-10-02T00:00:00.000Z' }]) });
    await flush();
    app.set({ bodies: { a: 'alpha', b: 'beta' }, bodiesReady: { v: true } });
    await flushN(10);
    expect(d.api.putVector.mock.calls.map((c: any) => c[0])).toEqual(['b', 'a']);
    expect(d.api.putVector.mock.calls[0][1]).toEqual({ model: 'bge@1', encVec: 'v1.b.1', sourceUpdatedAt: '2026-10-02T00:00:00.000Z' });
    expect(s.getState().coverage.v).toEqual({ done: 2, total: 2 });
  });

  it('re-queues on 422 instead of storing a stale vector', async () => {
    const app = fakeApp();
    const err = Object.assign(new Error('stale'), { status: 422 });
    const put = vi.fn().mockRejectedValueOnce(err).mockResolvedValue({ ok: true });
    const { d } = deps({ api: { listVectors: async () => ({ vectors: [] }), putVector: put } });
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked', trees: tree([{ id: 'a', updatedAt: '2026-10-01T00:00:00.000Z' }]), bodies: { a: 'x' }, bodiesReady: { v: true } });
    await flushN(10);
    expect(put).toHaveBeenCalledTimes(2);
    expect(s.getState().coverage.v.done).toBe(1);
  });

  it('a note edited while it is embedded is never counted fresh, and is embedded again after the save', async () => {
    vi.useFakeTimers();
    try {
      const app = fakeApp();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { d, embedder } = deps();
      embedder.embed.mockImplementationOnce(async (ts: string[]) => (await gate, ts.map(fakeVec)));
      const s = new SemanticStore(app as any, d as any);
      app.set({ phase: 'unlocked', trees: tree([{ id: 'a', updatedAt: '2026-10-01T00:00:00.000Z' }]), bodies: { a: 'old' }, bodiesReady: { v: true } });
      await vi.advanceTimersByTimeAsync(0);
      expect(embedder.embed).toHaveBeenCalledTimes(1);
      // The user saves while the old text is in the worker.
      app.set({ trees: tree([{ id: 'a', updatedAt: '2026-10-05T00:00:00.000Z' }]), bodies: { a: 'new' } });
      app.save(['a']);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(d.api.putVector.mock.calls[0][1].sourceUpdatedAt).toBe('2026-10-01T00:00:00.000Z');
      expect(s.getState().coverage.v).toEqual({ done: 0, total: 1 });
      await vi.advanceTimersByTimeAsync(RESAVE_DEBOUNCE_MS);
      await vi.runAllTimersAsync();
      expect(d.api.putVector).toHaveBeenCalledTimes(2);
      expect(d.api.putVector.mock.calls[1][1].sourceUpdatedAt).toBe('2026-10-05T00:00:00.000Z');
      expect(embedder.embed.mock.calls[1][0][0]).toContain('new');
      expect(s.getState().coverage.v).toEqual({ done: 1, total: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a burst of saves of one note queues it once after the debounce', async () => {
    vi.useFakeTimers();
    try {
      const app = fakeApp();
      const { d } = deps();
      new SemanticStore(app as any, d as any);
      app.set({ phase: 'unlocked', trees: tree([{ id: 'a', updatedAt: '2026-10-01T00:00:00.000Z' }]), bodies: { a: 'x' }, bodiesReady: { v: true } });
      await vi.runAllTimersAsync();
      d.api.putVector.mockClear();
      app.set({ trees: tree([{ id: 'a', updatedAt: '2026-10-03T00:00:00.000Z' }]) });
      for (let i = 0; i < 50; i++) app.save(['a']);
      await vi.advanceTimersByTimeAsync(RESAVE_DEBOUNCE_MS - 1);
      expect(d.api.putVector).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await vi.runAllTimersAsync();
      expect(d.api.putVector).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a save during the debounce restarts it', async () => {
    vi.useFakeTimers();
    try {
      const app = fakeApp();
      const { d } = deps();
      new SemanticStore(app as any, d as any);
      app.set({ phase: 'unlocked', trees: tree([{ id: 'a', updatedAt: '2026-10-01T00:00:00.000Z' }]), bodies: { a: 'x' }, bodiesReady: { v: true } });
      await vi.runAllTimersAsync();
      d.api.putVector.mockClear();
      app.set({ trees: tree([{ id: 'a', updatedAt: '2026-10-03T00:00:00.000Z' }]) });
      app.save(['a']);
      await vi.advanceTimersByTimeAsync(RESAVE_DEBOUNCE_MS - 500);
      app.save(['a']);
      await vi.advanceTimersByTimeAsync(RESAVE_DEBOUNCE_MS - 1);
      expect(d.api.putVector).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(d.api.putVector).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a burst of saves across 50 notes embeds each note once', async () => {
    vi.useFakeTimers();
    try {
      const app = fakeApp();
      const { d } = deps();
      new SemanticStore(app as any, d as any);
      const ids = Array.from({ length: 50 }, (_, i) => `n${i}`);
      const at = (day: string) => ids.map((id) => ({ id, updatedAt: `2026-10-${day}T00:00:00.000Z` }));
      app.set({ phase: 'unlocked', trees: tree(at('01')), bodies: Object.fromEntries(ids.map((id) => [id, id])), bodiesReady: { v: true } });
      await vi.runAllTimersAsync();
      expect(d.api.putVector).toHaveBeenCalledTimes(50);
      d.api.putVector.mockClear();
      app.set({ trees: tree(at('03')) });
      for (let round = 0; round < 3; round++) for (const id of ids) app.save([id]);
      await vi.advanceTimersByTimeAsync(RESAVE_DEBOUNCE_MS);
      await vi.runAllTimersAsync();
      expect(d.api.putVector.mock.calls.map((c: any) => c[0]).sort()).toEqual([...ids].sort());
    } finally {
      vi.useRealTimers();
    }
  });

  it('lock mid-embed terminates the worker and never uploads', async () => {
    const app = fakeApp();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { d, embedder } = deps();
    embedder.embed.mockImplementation(async (ts: string[]) => (await gate, ts.map(fakeVec)));
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked', trees: tree([{ id: 'a', updatedAt: '2026-10-01T00:00:00.000Z' }]), bodies: { a: 'x' }, bodiesReady: { v: true } });
    await flush();
    app.set({ phase: 'locked', trees: {}, bodies: {} });
    release();
    await flushN(5);
    expect(embedder.terminate).toHaveBeenCalled();
    expect(d.api.putVector).not.toHaveBeenCalled();
    expect(s.getState().coverage).toEqual({});
  });

  it('lock during an upload backoff never uploads again and drops the vectors', async () => {
    const app = fakeApp();
    let wake!: () => void;
    const delay = vi.fn((ms: number) => (ms === 0 ? Promise.resolve() : new Promise<void>((r) => (wake = r))));
    const put = vi.fn().mockRejectedValue(Object.assign(new Error('down'), { status: 503 }));
    const { d } = deps({ delay, api: { listVectors: async () => ({ vectors: [] }), putVector: put } });
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked', trees: tree([{ id: 'a', updatedAt: '2026-10-01T00:00:00.000Z' }]), bodies: { a: 'x' }, bodiesReady: { v: true } });
    await flushN(3);
    expect(put).toHaveBeenCalledTimes(1);
    expect(delay).toHaveBeenCalledWith(UPLOAD_BACKOFF_MS[0]);
    app.set({ phase: 'locked', trees: {}, bodies: {}, bodiesReady: {} });
    wake();
    await flushN(3);
    expect(put).toHaveBeenCalledTimes(1);
    expect(s.neighbours('a', 5)).toEqual([]);
    expect(s.getState().coverage).toEqual({});
  });

  it('retries a failed upload after each backoff step, then leaves the note until its next save', async () => {
    const app = fakeApp();
    const delay = vi.fn(async () => {});
    const put = vi.fn().mockRejectedValue(Object.assign(new Error('down'), { status: 0 }));
    const { d } = deps({ delay, api: { listVectors: async () => ({ vectors: [] }), putVector: put } });
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked', trees: tree([{ id: 'a', updatedAt: '2026-10-01T00:00:00.000Z' }]), bodies: { a: 'x' }, bodiesReady: { v: true } });
    await flushN(10);
    expect(put).toHaveBeenCalledTimes(1 + UPLOAD_BACKOFF_MS.length);
    expect(delay.mock.calls.map((c: any) => c[0]).filter((ms: number) => ms > 0)).toEqual(UPLOAD_BACKOFF_MS);
    expect(s.getState().coverage.v).toEqual({ done: 0, total: 1 });
  });

  it('keeps vectors for Related when the toggle is off, without loading a model', async () => {
    const app = fakeApp();
    const { d, embedder } = deps({ prefs: { semantic: () => false, setSemantic: vi.fn() } });
    d.api.listVectors = vi.fn(async () => ({ vectors: [{ noteId: 'a', model: 'bge@1', encVec: 'x', sourceUpdatedAt: '2026-10-01T00:00:00.000Z' }, { noteId: 'b', model: 'bge@1', encVec: 'y', sourceUpdatedAt: '2026-10-01T00:00:00.000Z' }] }));
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked', trees: tree([{ id: 'a', updatedAt: '2026-10-01T00:00:00.000Z' }, { id: 'b', updatedAt: '2026-10-01T00:00:00.000Z' }]), bodiesReady: { v: true } });
    await flushN(5);
    expect(embedder.load).not.toHaveBeenCalled();
    expect(s.getState().phase).toBe('off');
    expect(s.neighbours('a', 5).map((n) => n.id)).toEqual(['b']);
    expect(s.neighbours('a', 5, new Set(['c']))).toEqual([]);
    expect(s.getState().coverage.v).toEqual({ done: 2, total: 2 });
    // A save makes a's vector stale: no neighbours for it until it is embedded again.
    app.set({ trees: tree([{ id: 'a', updatedAt: '2026-10-02T00:00:00.000Z' }, { id: 'b', updatedAt: '2026-10-01T00:00:00.000Z' }]) });
    app.save(['a']);
    expect(s.neighbours('a', 5)).toEqual([]);
    expect(s.neighbours('b', 5)).toEqual([]);
    expect(s.getState().coverage.v).toEqual({ done: 1, total: 2 });
    s.dispose();
  });

  it('turning off clears the model cache and keeps vectors', async () => {
    const app = fakeApp();
    const { d, embedder } = deps();
    d.api.listVectors = vi.fn(async () => ({ vectors: [{ noteId: 'a', model: 'bge@1', encVec: 'x', sourceUpdatedAt: '2026-10-01T00:00:00.000Z' }, { noteId: 'b', model: 'bge@1', encVec: 'y', sourceUpdatedAt: '2026-10-01T00:00:00.000Z' }] }));
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked', trees: tree([{ id: 'a', updatedAt: '2026-10-01T00:00:00.000Z' }, { id: 'b', updatedAt: '2026-10-01T00:00:00.000Z' }]), bodiesReady: { v: true } });
    await flushN(3);
    expect(s.getState().phase).toBe('ready');
    await s.setEnabled(false);
    expect(d.prefs.setSemantic).toHaveBeenCalledWith(false);
    expect(d.cache.clear).toHaveBeenCalled();
    expect(embedder.terminate).toHaveBeenCalled();
    expect(s.getState().phase).toBe('off');
    expect(s.getState().enabled).toBe(false);
    expect(s.neighbours('a', 5).map((n) => n.id)).toEqual(['b']);
  });

  it('turning on asks for persistent storage and loads a fresh model', async () => {
    const app = fakeApp();
    let on = false;
    const { d, embedder } = deps({ prefs: { semantic: () => on, setSemantic: vi.fn((v: boolean) => (on = v)) } });
    d.cache.persist.mockResolvedValue(false);
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked' });
    await flush();
    expect(s.getState()).toMatchObject({ available: true, enabled: false, phase: 'off' });
    await s.setEnabled(true);
    expect(d.prefs.setSemantic).toHaveBeenCalledWith(true);
    expect(d.cache.verify).toHaveBeenCalledWith(manifest);
    expect(embedder.load).toHaveBeenCalledTimes(1);
    expect(s.getState()).toMatchObject({ enabled: true, phase: 'ready', persistDenied: true });
  });

  it('shows download progress, then loading once the files are in, then ready', async () => {
    const app = fakeApp();
    const { d, embedder } = deps();
    let progress!: (l: number, t: number) => void;
    let finish!: () => void;
    embedder.load.mockImplementation((_m, p) => ((progress = p), new Promise<void>((r) => (finish = r))));
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked' });
    await flush();
    expect(s.getState().phase).toBe('downloading');
    progress(5, 20);
    expect(s.getState()).toMatchObject({ phase: 'downloading', download: { loaded: 5, total: 20 } });
    progress(20, 20);
    expect(s.getState().phase).toBe('loading');
    finish();
    await flush();
    expect(s.getState().phase).toBe('ready');
  });

  it('a cached model skips the download phase', async () => {
    const app = fakeApp();
    const { d, embedder } = deps();
    let progress!: (l: number, t: number) => void;
    embedder.load.mockImplementation((_m, p) => ((progress = p), new Promise<void>(() => {})));
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked' });
    await flush();
    progress(30, 30);
    expect(s.getState().phase).toBe('loading');
  });

  it('a failed download sets the error; retry loads a fresh embedder', async () => {
    const app = fakeApp();
    const first = makeEmbedderStub();
    first.load.mockRejectedValue(new Error('offline'));
    const second = makeEmbedderStub();
    const makeEmbedder = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const { d } = deps({ makeEmbedder });
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked' });
    await flush();
    expect(s.getState()).toMatchObject({ phase: 'error', error: 'Couldn’t download the search model.' });
    s.retry();
    await flush();
    expect(makeEmbedder).toHaveBeenCalledTimes(2);
    expect(second.load).toHaveBeenCalled();
    expect(s.getState()).toMatchObject({ phase: 'ready', error: null });
  });

  it('pauses when the embedder gives up after a second crash', async () => {
    const app = fakeApp();
    let onPaused!: () => void;
    const embedder = makeEmbedderStub();
    const { d } = deps({ makeEmbedder: (p: () => void) => ((onPaused = p), embedder) });
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked' });
    await flush();
    expect(s.getState().phase).toBe('ready');
    onPaused();
    expect(s.getState().phase).toBe('paused');
    expect(await s.search('anything')).toEqual([]);
  });

  it('search embeds the query and returns fresh notes above the floor', async () => {
    const app = fakeApp();
    const { d, embedder } = deps();
    const s = new SemanticStore(app as any, d as any);
    expect(await s.search('alpha')).toEqual([]);
    app.set({ phase: 'unlocked', trees: tree([{ id: 'a', updatedAt: '2026-10-01T00:00:00.000Z', title: '' }, { id: 'b', updatedAt: '2026-10-01T00:00:00.000Z', title: '' }]), bodies: { a: 'alpha', b: 'beta' }, bodiesReady: { v: true } });
    await flushN(10);
    const hits = await s.search('alpha');
    expect(embedder.embed).toHaveBeenLastCalledWith(['alpha'], 'query');
    expect(hits).toEqual([{ noteId: 'a', similarity: expect.closeTo(1, 5), chunk: 0 }]);
    const ac = new AbortController();
    ac.abort();
    expect(await s.search('alpha', ac.signal)).toEqual([]);
  });

  it('chunkText gives the first line of a chunk, without the title, capped at 140 characters', async () => {
    const app = fakeApp();
    const { d } = deps({ fetchManifest: async () => null });
    const s = new SemanticStore(app as any, d as any);
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
    app.set({ phase: 'unlocked', trees: tree([{ id: 'a', updatedAt: '2026-10-01T00:00:00.000Z', title: 'Title' }, { id: 'e', updatedAt: '2026-10-01T00:00:00.000Z', title: 'Only' }]), bodies: { a: long, e: '' } });
    const text = s.chunkText('a', 0)!;
    expect(text.startsWith('word0 word1')).toBe(true);
    expect(text).toHaveLength(140);
    expect(s.chunkText('e', 0)).toBe('Only');
    expect(s.chunkText('a', 5)).toBeNull();
    expect(s.chunkText('missing', 0)).toBeNull();
  });
});
