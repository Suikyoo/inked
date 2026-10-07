import { chunkNote, dequantize, isFresh, meanVector, noteScore, quantize, SEM_FLOOR, topK, type SemanticInput } from 'inked-core';
import { api } from '../api/client';
import { prefs } from '../lib/prefs';
import type { AppStore } from '../state/store';
import type { Embedder } from './embedderClient';
import { fetchManifest, modelBytes, type Manifest } from './manifest';
import { clearModelCache, requestPersist, verifyModelCache } from './modelCache';

export const RESAVE_DEBOUNCE_MS = 2000;
export const UPLOAD_BACKOFF_MS = [1000, 4000, 16000];
/** A note whose upload keeps coming back 422 is re-queued at most this many times until its next save. */
const STALE_REQUEUE_MAX = 3;
const LOAD_ERROR = 'Couldn’t download the search model.';
/** Snippets from chunkText are cut to this many characters. */
const SNIPPET_MAX = 140;

export type ModelPhase = 'unavailable' | 'off' | 'downloading' | 'loading' | 'ready' | 'paused' | 'error';

export interface SemanticState {
  /** Whether this deployment ships the model; null until the first unlock asks. */
  available: boolean | null;
  enabled: boolean;
  phase: ModelPhase;
  download: { loaded: number; total: number } | null;
  /** Per vault: notes with a fresh vector out of all readable notes. */
  coverage: Record<string, { done: number; total: number }>;
  error: string | null;
  /** Bumped whenever the stored vectors change, so Related lists re-read them. */
  version: number;
  persistDenied: boolean;
  /** Total size of the model files, from the manifest; null until it loads. */
  downloadBytes: number | null;
}

export type EmbedderLike = Pick<Embedder, 'load' | 'embed' | 'terminate' | 'paused'>;

export interface SemanticDeps {
  api: Pick<typeof api, 'listVectors' | 'putVector'>;
  fetchManifest: () => Promise<Manifest | null>;
  makeEmbedder: (onPaused: () => void) => EmbedderLike | Promise<EmbedderLike>;
  prefs: { semantic(): boolean; setSemantic(on: boolean): void };
  cache: { verify(m: Manifest): Promise<number>; clear(): Promise<void>; persist(): Promise<boolean> };
  delay: (ms: number) => Promise<void>;
}

type AppLike = Pick<AppStore, 'getState' | 'subscribe' | 'onNotesSaved' | 'encryptVector' | 'decryptVector' | 'noteHead'>;

interface StoredVector {
  vaultId: string;
  model: string;
  sourceUpdatedAt: string;
  chunks: Float32Array[];
  mean: Float32Array;
}

const defaultDeps: SemanticDeps = {
  api,
  fetchManifest: () => fetchManifest(),
  // Dynamic import: transformers.js and the worker stay out of the main chunk until the model is wanted.
  makeEmbedder: async (onPaused) => new (await import('./embedderClient')).Embedder({ onPaused }),
  prefs,
  cache: { verify: (m) => verifyModelCache(m), clear: () => clearModelCache(), persist: requestPersist },
  delay: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const statusOf = (e: unknown) => (e as { status?: unknown } | null)?.status;

const sameCoverage = (a: SemanticState['coverage'], b: SemanticState['coverage']) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] && a[k].done === b[k].done && a[k].total === b[k].total);
};

/**
 * Note embeddings for search by meaning and Related: fetches and decrypts stored vectors after
 * unlock, embeds stale notes in the background (when the toggle is on), and drops everything on lock.
 */
export class SemanticStore {
  private state: SemanticState = {
    available: null,
    enabled: false,
    phase: 'off',
    download: null,
    coverage: {},
    error: null,
    version: 0,
    persistDenied: false,
    downloadBytes: null,
  };
  private listeners = new Set<() => void>();
  private deps: SemanticDeps;
  /** Bumped on every unlock and lock; async work from another session checks it after every await. */
  private epoch = 0;
  /** Bumped whenever the embedder is replaced or stopped, so a superseded model load stands down. */
  private modelGen = 0;
  private unlocked = false;
  private lastTrees: unknown = null;
  private lastBodies: unknown = null;
  private manifest: Manifest | null = null;
  private embedder: EmbedderLike | null = null;
  private vectors = new Map<string, StoredVector>();
  private queue: string[] = [];
  private queued = new Set<string>();
  /** Stale notes skipped for want of a body (a reload dropped the old text); queued once it arrives. */
  private awaitingBody = new Set<string>();
  private resaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private staleRequeues = new Map<string, number>();
  /** Vaults whose stored vectors were requested this session. */
  private fetchedVaults = new Set<string>();
  /** Vaults whose stored vectors are in: only their notes are counted and queued. */
  private vectorsIn = new Set<string>();
  private running = false;
  private unsubscribe: Array<() => void>;

  constructor(
    private app: AppLike,
    deps: Partial<SemanticDeps> = {},
  ) {
    this.deps = { ...defaultDeps, ...deps };
    this.unsubscribe = [app.subscribe(this.onApp), app.onNotesSaved(this.onSaved)];
    this.onApp();
  }

  getState = (): SemanticState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<SemanticState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  dispose(): void {
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
    this.reset();
    this.listeners.clear();
  }

  // ---- Session -----------------------------------------------------------------------------

  private onApp = () => {
    const s = this.app.getState();
    // A lock, sign-out or session end starts with `locking` while the keys are still here: stop then.
    const unlocked = s.phase === 'unlocked' && !s.locking;
    if (unlocked !== this.unlocked) {
      this.unlocked = unlocked;
      if (unlocked) void this.start();
      else this.reset();
    }
    if (!unlocked || !this.manifest) return;
    for (const [vaultId, ready] of Object.entries(s.bodiesReady)) {
      if (ready && !this.fetchedVaults.has(vaultId)) void this.fetchVectors(vaultId);
    }
    if (s.trees !== this.lastTrees) {
      this.lastTrees = s.trees;
      this.refreshCoverage();
    }
    if (s.bodies !== this.lastBodies) {
      this.lastBodies = s.bodies;
      const arrived = [...this.awaitingBody].filter((id) => id in s.bodies);
      for (const id of arrived) this.awaitingBody.delete(id);
      if (arrived.length) this.enqueue(arrived);
    }
  };

  private async start() {
    const ep = ++this.epoch;
    let m: Manifest | null = null;
    try {
      m = await this.deps.fetchManifest();
    } catch {
      m = null;
    }
    if (ep !== this.epoch) return;
    if (!m) {
      this.set({ available: false, phase: 'unavailable' });
      return;
    }
    this.manifest = m;
    const enabled = this.deps.prefs.semantic();
    this.set({ available: true, enabled, phase: 'off', downloadBytes: modelBytes(m) });
    this.onApp();
    if (enabled) await this.loadModel();
  }

  /** Lock or sign-out: stop the worker and forget every vector, queue and timer. */
  private reset() {
    this.epoch++;
    this.stopEmbedder();
    this.manifest = null;
    this.lastTrees = null;
    this.lastBodies = null;
    this.awaitingBody.clear();
    this.vectors.clear();
    this.queue = [];
    this.queued.clear();
    for (const t of this.resaveTimers.values()) clearTimeout(t);
    this.resaveTimers.clear();
    this.staleRequeues.clear();
    this.fetchedVaults.clear();
    this.vectorsIn.clear();
    this.running = false;
    const phase = this.state.available === false ? 'unavailable' : 'off';
    this.set({ phase, download: null, downloadBytes: null, coverage: {}, error: null, version: this.state.version + 1 });
  }

  // ---- Model -------------------------------------------------------------------------------

  private stopEmbedder() {
    this.modelGen++;
    this.embedder?.terminate();
    this.embedder = null;
  }

  /** Builds a fresh embedder and loads the model; never throws. */
  private async loadModel(): Promise<void> {
    const m = this.manifest;
    if (!m) return;
    this.stopEmbedder();
    const gen = this.modelGen;
    const live = () => gen === this.modelGen;
    try {
      await this.deps.cache.verify(m);
    } catch {
      // Best effort: a cache that cannot be checked is simply downloaded through.
    }
    if (!live()) return;
    this.set({ phase: 'downloading', download: null, error: null });
    try {
      const emb = await this.deps.makeEmbedder(() => {
        if (live()) this.set({ phase: 'paused', download: null });
      });
      if (!live()) {
        emb.terminate();
        return;
      }
      this.embedder = emb;
      await emb.load(m, (loaded, total) => {
        // Every file in (or already cached, on the first report): only the model is left to start.
        if (live()) this.set({ phase: loaded >= total ? 'loading' : 'downloading', download: { loaded, total } });
      });
      if (!live()) return;
      this.set({ phase: 'ready', download: null });
      this.scan();
    } catch {
      if (!live()) return;
      this.stopEmbedder();
      this.set({ phase: 'error', error: LOAD_ERROR, download: null });
    }
  }

  async setEnabled(on: boolean): Promise<void> {
    this.deps.prefs.setSemantic(on);
    this.set({ enabled: on });
    if (on) {
      const persisted = await this.deps.cache.persist().catch(() => false);
      this.set({ persistDenied: !persisted });
      if (this.state.enabled && this.unlocked && this.manifest) await this.loadModel();
      return;
    }
    this.stopEmbedder();
    // Stored vectors stay: Related works without the model.
    this.set({ phase: this.state.available === false ? 'unavailable' : 'off', download: null, error: null });
    await this.deps.cache.clear().catch(() => undefined);
  }

  /** After a download error: try again with a fresh embedder. */
  retry(): void {
    if (this.unlocked && this.manifest && this.state.enabled) void this.loadModel();
  }

  // ---- Vectors -----------------------------------------------------------------------------

  private async fetchVectors(vaultId: string) {
    const ep = this.epoch;
    this.fetchedVaults.add(vaultId);
    try {
      const { vectors } = await this.deps.api.listVectors(vaultId);
      if (ep !== this.epoch) return;
      await Promise.all(
        vectors.map(async (v) => {
          try {
            const q = await this.app.decryptVector(vaultId, v.noteId, v.model, v.encVec);
            if (ep !== this.epoch) return;
            const have = this.vectors.get(v.noteId);
            if (have && Date.parse(have.sourceUpdatedAt) >= Date.parse(v.sourceUpdatedAt)) return;
            this.storeVector(v.noteId, vaultId, v.model, v.sourceUpdatedAt, q);
          } catch {
            // Unreadable: treated as missing, so the note is embedded again.
          }
        }),
      );
    } catch {
      // Not fetched: this vault waits for the next unlock rather than re-embedding every note.
      return;
    }
    if (ep !== this.epoch) return;
    this.vectorsIn.add(vaultId);
    this.refreshCoverage(true);
    this.scan();
  }

  private storeVector(noteId: string, vaultId: string, model: string, sourceUpdatedAt: string, q: Int8Array[]) {
    const chunks = q.map(dequantize);
    this.vectors.set(noteId, { vaultId, model, sourceUpdatedAt, chunks, mean: meanVector(chunks) });
  }

  /** The note's vector if it still describes the note as stored now. */
  private fresh(noteId: string): StoredVector | undefined {
    const m = this.manifest;
    const head = this.app.noteHead(noteId);
    const v = this.vectors.get(noteId);
    return m && head && !head.broken && isFresh(v, head, m.id) ? v : undefined;
  }

  private coverage(): SemanticState['coverage'] {
    const out: SemanticState['coverage'] = {};
    const { trees } = this.app.getState();
    for (const vaultId of this.vectorsIn) {
      const t = trees[vaultId];
      if (!t) continue;
      let done = 0;
      let total = 0;
      for (const n of Object.values(t.notes)) {
        if (n.broken) continue;
        total++;
        if (this.fresh(n.id)) done++;
      }
      out[vaultId] = { done, total };
    }
    return out;
  }

  private refreshCoverage(vectorsChanged = false) {
    const coverage = this.coverage();
    if (vectorsChanged) this.set({ coverage, version: this.state.version + 1 });
    else if (!sameCoverage(coverage, this.state.coverage)) this.set({ coverage });
  }

  // ---- Embed queue -------------------------------------------------------------------------

  private onSaved = (ids: string[]) => {
    if (!this.unlocked || !this.manifest) return;
    for (const id of ids) {
      clearTimeout(this.resaveTimers.get(id));
      this.staleRequeues.delete(id);
      this.resaveTimers.set(
        id,
        setTimeout(() => {
          this.resaveTimers.delete(id);
          this.enqueue([id]);
        }, RESAVE_DEBOUNCE_MS),
      );
    }
    this.refreshCoverage();
  };

  /** Queues every stale note of the vaults whose vectors are in. */
  private scan() {
    const { trees } = this.app.getState();
    this.enqueue([...this.vectorsIn].flatMap((vaultId) => Object.keys(trees[vaultId]?.notes ?? {})));
  }

  /** Adds notes that have a body and no fresh vector, each once, newest first; starts the worker loop. */
  private enqueue(ids: string[]) {
    if (!this.manifest) return;
    const { bodies } = this.app.getState();
    for (const id of ids) {
      const head = this.app.noteHead(id);
      if (this.queued.has(id) || !head || head.broken || !this.vectorsIn.has(head.vaultId) || this.fresh(id)) continue;
      if (!(id in bodies)) {
        this.awaitingBody.add(id);
        continue;
      }
      this.queue.push(id);
      this.queued.add(id);
    }
    const at = new Map(this.queue.map((id) => [id, Date.parse(this.app.noteHead(id)?.updatedAt ?? '') || 0]));
    this.queue.sort((a, b) => at.get(b)! - at.get(a)!);
    void this.pump();
  }

  private async pump() {
    if (this.running || this.state.phase !== 'ready') return;
    this.running = true;
    const ep = this.epoch;
    try {
      while (ep === this.epoch && this.state.phase === 'ready' && this.queue.length) {
        const id = this.queue.shift()!;
        this.queued.delete(id);
        await this.embedOne(id, ep);
        if (ep !== this.epoch) return;
        await this.deps.delay(0);
      }
    } finally {
      if (ep === this.epoch) this.running = false;
    }
  }

  private async embedOne(id: string, ep: number) {
    const m = this.manifest;
    const emb = this.embedder;
    const head = this.app.noteHead(id);
    const body = this.app.getState().bodies[id];
    if (!m || !emb || !head || head.broken || this.fresh(id)) return;
    if (body === undefined) {
      this.awaitingBody.add(id);
      return;
    }
    const { vaultId, updatedAt: snapshot } = head;
    const texts = chunkNote(head.title, body);
    if (!texts.length) return;
    let q: Int8Array[];
    let encVec: string;
    try {
      const vecs = await emb.embed(texts, 'passage');
      if (ep !== this.epoch) return;
      q = vecs.map(quantize);
      encVec = await this.app.encryptVector(vaultId, id, m.id, q);
    } catch {
      // Worker stopped, crashed or paused: the note waits for its next save or unlock.
      return;
    }
    for (let attempt = 0; ; attempt++) {
      if (ep !== this.epoch) return;
      try {
        await this.deps.api.putVector(id, { model: m.id, encVec, sourceUpdatedAt: snapshot });
      } catch (e) {
        if (ep !== this.epoch) return;
        if (statusOf(e) === 422) {
          // The note changed under us: drop this vector and embed the note again.
          const n = (this.staleRequeues.get(id) ?? 0) + 1;
          this.staleRequeues.set(id, n);
          if (n <= STALE_REQUEUE_MAX) this.enqueue([id]);
          return;
        }
        if (attempt >= UPLOAD_BACKOFF_MS.length) return;
        await this.deps.delay(UPLOAD_BACKOFF_MS[attempt]);
        continue;
      }
      if (ep !== this.epoch) return;
      this.staleRequeues.delete(id);
      this.storeVector(id, vaultId, m.id, snapshot, q);
      this.refreshCoverage(true);
      return;
    }
  }

  // ---- Queries -----------------------------------------------------------------------------

  async search(query: string, signal?: AbortSignal): Promise<SemanticInput[]> {
    const emb = this.embedder;
    if (this.state.phase !== 'ready' || !emb || signal?.aborted) return [];
    const ep = this.epoch;
    let q: Float32Array | undefined;
    try {
      [q] = await emb.embed([query], 'query');
    } catch {
      return [];
    }
    if (!q || signal?.aborted || ep !== this.epoch) return [];
    const out: SemanticInput[] = [];
    for (const id of this.vectors.keys()) {
      const v = this.fresh(id);
      if (!v) continue;
      const { score, chunk } = noteScore(q, v.chunks);
      if (score >= SEM_FLOOR) out.push({ noteId: id, similarity: score, chunk });
    }
    return out.sort((a, b) => b.similarity - a.similarity);
  }

  neighbours(noteId: string, k: number, among?: ReadonlySet<string>): { id: string; similarity: number }[] {
    const own = this.fresh(noteId);
    if (!own) return [];
    const candidates: { id: string; vec: Float32Array }[] = [];
    for (const id of this.vectors.keys()) {
      if (id === noteId || (among && !among.has(id))) continue;
      const v = this.fresh(id);
      if (v) candidates.push({ id, vec: v.mean });
    }
    return topK(own.mean, candidates, k, SEM_FLOOR);
  }

  /** The first line of a chunk's text for a snippet (after the title, which leads chunk 0), or null. */
  chunkText(noteId: string, chunk: number): string | null {
    const head = this.app.noteHead(noteId);
    const body = this.app.getState().bodies[noteId];
    if (!head || body === undefined) return null;
    const text = chunkNote(head.title, body)[chunk];
    if (text === undefined) return null;
    const lines = text.split('\n');
    const line = chunk === 0 && head.title.trim() && lines.length > 1 ? lines[1] : lines[0];
    return line.slice(0, SNIPPET_MAX);
  }
}
