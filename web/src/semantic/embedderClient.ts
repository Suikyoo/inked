import { MODELS_BASE, type Manifest } from './manifest';
import type { EmbedKind, FromWorker, ToWorker } from './protocol';

type Pending = { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void };

const defaultWorker = () => new Worker(new URL('./embedder.worker.ts', import.meta.url), { type: 'module' });

/** One embedding worker. A crash restarts it once; a second crash pauses semantic search for the session. */
export class Embedder {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private crashes = 0;
  private manifest: Manifest | null = null;
  private onProgress: (loaded: number, total: number) => void = () => {};
  private ready: Promise<void> | null = null;
  private loadReject: ((e: Error) => void) | null = null;
  /** Set once WebGPU failed to load: every later worker for this manifest goes straight to WASM. */
  private wasmOnly = false;
  paused = false;

  constructor(private opts: { makeWorker?: () => Worker; onPaused?: () => void } = {}) {}

  load(manifest: Manifest, onProgress: (loaded: number, total: number) => void): Promise<void> {
    this.terminate();
    this.manifest = manifest;
    this.onProgress = onProgress;
    this.wasmOnly = false;
    this.ready = this.start();
    return this.ready;
  }

  private start(): Promise<void> {
    const w = (this.opts.makeWorker ?? defaultWorker)();
    this.worker = w;
    let loaded = false;
    return new Promise<void>((resolve, reject) => {
      this.loadReject = reject;
      const fail = (message: string) => {
        if (this.worker !== w) return;
        if (!loaded) {
          // A crash during the initial load rejects load(); the caller owns any retry.
          this.loadReject = null;
          reject(new Error(message));
        }
        this.onCrash(!loaded);
      };
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        if (this.worker !== w) return;
        const m = e.data;
        if (m.type === 'progress') this.onProgress(m.loaded, m.total);
        else if (m.type === 'ready') {
          loaded = true;
          this.loadReject = null;
          resolve();
        } else if (m.type === 'result') {
          this.pending.get(m.id)?.resolve(m.vectors);
          this.pending.delete(m.id);
        } else if (m.type === 'error') {
          if (m.id === undefined && !loaded && m.gpuFailed && !this.wasmOnly) {
            // WebGPU couldn't start (no adapter, unsupported ops). That worker's runtime is poisoned, so retry in a
            // fresh one pinned to WASM. Not a crash.
            this.wasmOnly = true;
            this.worker = null;
            w.terminate();
            this.start().then(resolve, reject);
          } else if (m.id === undefined) fail(m.message);
          else {
            this.pending.get(m.id)?.reject(new Error(m.message));
            this.pending.delete(m.id);
          }
        }
      };
      w.onerror = () => fail('worker crashed');
      w.postMessage({
        type: 'load',
        manifest: this.manifest!,
        base: MODELS_BASE,
        ...(this.wasmOnly ? { device: 'wasm' as const } : {}),
      } satisfies ToWorker);
    });
  }

  private onCrash(duringLoad: boolean) {
    for (const p of this.pending.values()) p.reject(new Error('worker crashed'));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.crashes++;
    if (this.crashes >= 2) {
      this.paused = true;
      this.opts.onPaused?.();
      return;
    }
    if (duringLoad || !this.manifest) return;
    // Background restart after a crash in a working session; a failure surfaces on the next embed().
    this.ready = this.start();
    this.ready.catch(() => {});
  }

  async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
    if (this.paused) throw new Error('semantic search paused');
    const before = this.worker;
    await this.ready;
    const w = this.worker;
    if (!w) throw new Error('embedder stopped');
    if (w !== before) throw new Error('worker crashed'); // it was replaced while this call waited for load
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ type: 'embed', id, texts, kind } satisfies ToWorker);
    });
  }

  terminate() {
    const stopped = new Error('embedder stopped');
    this.loadReject?.(stopped);
    this.loadReject = null;
    for (const p of this.pending.values()) p.reject(stopped);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.ready = Promise.reject(stopped);
    this.ready.catch(() => {});
  }
}
