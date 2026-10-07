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
  private ready: Promise<void> | null = null;
  paused = false;

  constructor(private opts: { makeWorker?: () => Worker; onPaused?: () => void } = {}) {}

  load(manifest: Manifest, onProgress: (loaded: number, total: number) => void): Promise<void> {
    this.manifest = manifest;
    this.ready = this.start(onProgress);
    return this.ready;
  }

  private start(onProgress: (loaded: number, total: number) => void): Promise<void> {
    const w = (this.opts.makeWorker ?? defaultWorker)();
    this.worker = w;
    return new Promise<void>((resolve, reject) => {
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === 'progress') onProgress(m.loaded, m.total);
        else if (m.type === 'ready') resolve();
        else if (m.type === 'result') {
          this.pending.get(m.id)?.resolve(m.vectors);
          this.pending.delete(m.id);
        } else if (m.type === 'error') {
          if (m.id === undefined) reject(new Error(m.message));
          else {
            this.pending.get(m.id)?.reject(new Error(m.message));
            this.pending.delete(m.id);
          }
        }
      };
      w.onerror = () => {
        reject(new Error('worker crashed'));
        this.onCrash();
      };
      w.postMessage({ type: 'load', manifest: this.manifest!, base: MODELS_BASE } satisfies ToWorker);
    });
  }

  private onCrash() {
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
    if (this.manifest) this.ready = this.start(() => {});
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
    for (const p of this.pending.values()) p.reject(new Error('embedder stopped'));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}
