import { describe, expect, it, vi } from 'vitest';
import { Embedder } from './embedderClient';
import type { FromWorker, ToWorker } from './protocol';

/** A fake worker that echoes deterministic vectors, can report progress, and can crash. */
class FakeWorker {
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  sent: ToWorker[] = [];
  postMessage(m: ToWorker) {
    this.sent.push(m);
    queueMicrotask(() => {
      if (m.type === 'load') {
        this.emit({ type: 'progress', loaded: 5, total: 10 });
        this.emit({ type: 'ready' });
      } else if (m.type === 'embed') {
        this.emit({ type: 'result', id: m.id, vectors: m.texts.map((t) => Float32Array.of(t.length, 1)) });
      }
    });
  }
  emit(d: FromWorker) {
    this.onmessage?.({ data: d } as MessageEvent<FromWorker>);
  }
  crash() {
    this.onerror?.({ message: 'boom' } as ErrorEvent);
  }
  terminate() {
    this.terminated = true;
  }
}
/** Never answers, so a load stays in flight. */
class SilentWorker extends FakeWorker {
  postMessage(m: ToWorker) {
    this.sent.push(m);
  }
}
/** Fails the load as if WebGPU had no adapter, unless told to use WASM. */
class GpuFailWorker extends FakeWorker {
  postMessage(m: ToWorker) {
    if (m.type === 'load' && m.device !== 'wasm') {
      this.sent.push(m);
      queueMicrotask(() => this.emit({ type: 'error', message: 'no available backend found. ERR: [webgpu]', gpuFailed: true }));
      return;
    }
    super.postMessage(m);
  }
}
const manifest = { model: 'm', id: 'm@1', revision: '1', modelPath: '1/', ortPath: 'o/', files: [] };

describe('Embedder', () => {
  it('loads with progress and embeds', async () => {
    const w = new FakeWorker();
    const e = new Embedder({ makeWorker: () => w as unknown as Worker });
    const progress = vi.fn();
    await e.load(manifest, progress);
    expect(progress).toHaveBeenCalledWith(5, 10);
    const out = await e.embed(['ab', 'abc'], 'passage');
    expect(out.map((v) => v[0])).toEqual([2, 3]);
    expect(w.sent.at(-1)).toMatchObject({ type: 'embed', kind: 'passage' });
  });
  it('restarts once after a crash, then pauses on the second', async () => {
    const workers: FakeWorker[] = [];
    const onPaused = vi.fn();
    const e = new Embedder({ makeWorker: () => (workers.push(new FakeWorker()), workers.at(-1) as unknown as Worker), onPaused });
    await e.load(manifest, () => {});
    const pending = e.embed(['x'], 'query');
    workers[0].crash();
    await expect(pending).rejects.toThrow();
    expect(workers).toHaveLength(2);
    await expect(e.embed(['xy'], 'query')).resolves.toHaveLength(1);
    workers[1].crash();
    expect(e.paused).toBe(true);
    expect(onPaused).toHaveBeenCalled();
    await expect(e.embed(['x'], 'query')).rejects.toThrow(/paused/);
  });
  it('terminate stops the worker and rejects pending work', async () => {
    const w = new FakeWorker();
    const e = new Embedder({ makeWorker: () => w as unknown as Worker });
    await e.load(manifest, () => {});
    const p = e.embed(['x'], 'query');
    e.terminate();
    expect(w.terminated).toBe(true);
    await expect(p).rejects.toThrow();
  });
  it('terminate during load rejects load(), a waiting embed() and later embed() calls', async () => {
    const w = new SilentWorker();
    const e = new Embedder({ makeWorker: () => w as unknown as Worker });
    const loading = e.load(manifest, () => {});
    const waiting = e.embed(['x'], 'query');
    e.terminate();
    await expect(loading).rejects.toThrow(/stopped/);
    await expect(waiting).rejects.toThrow(/stopped/);
    expect(w.terminated).toBe(true);
    await expect(e.embed(['x'], 'query')).rejects.toThrow(/stopped/);
  });
  it('a crash during load rejects load() and starts no second worker', async () => {
    const workers: SilentWorker[] = [];
    const e = new Embedder({ makeWorker: () => (workers.push(new SilentWorker()), workers.at(-1) as unknown as Worker) });
    const loading = e.load(manifest, () => {});
    workers[0].crash();
    await expect(loading).rejects.toThrow(/crashed/);
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(true);
  });
  it('load() twice terminates the first worker', async () => {
    const workers: FakeWorker[] = [];
    const e = new Embedder({ makeWorker: () => (workers.push(new FakeWorker()), workers.at(-1) as unknown as Worker) });
    await e.load(manifest, () => {});
    await e.load(manifest, () => {});
    expect(workers[0].terminated).toBe(true);
    expect(workers[1].terminated).toBe(false);
    await expect(e.embed(['x'], 'query')).resolves.toHaveLength(1);
  });
  it('falls back to a fresh WASM-only worker when the WebGPU load fails, without counting a crash', async () => {
    const workers: GpuFailWorker[] = [];
    const onPaused = vi.fn();
    const e = new Embedder({ makeWorker: () => (workers.push(new GpuFailWorker()), workers.at(-1) as unknown as Worker), onPaused });
    await e.load(manifest, () => {});
    expect(workers).toHaveLength(2);
    expect(workers[0].terminated).toBe(true);
    expect(workers[0].sent[0]).toMatchObject({ type: 'load' });
    expect((workers[0].sent[0] as { device?: string }).device).toBeUndefined();
    expect(workers[1].sent[0]).toMatchObject({ type: 'load', device: 'wasm' });
    await expect(e.embed(['ab'], 'query')).resolves.toHaveLength(1);
    // The fallback is not a crash: one later crash restarts (still on WASM) instead of pausing.
    workers[1].crash();
    expect(e.paused).toBe(false);
    expect(onPaused).not.toHaveBeenCalled();
    expect(workers[2].sent[0]).toMatchObject({ type: 'load', device: 'wasm' });
  });
  it('a WASM-only load that fails rejects load() and does not loop', async () => {
    const workers: FakeWorker[] = [];
    class AlwaysFail extends FakeWorker {
      postMessage(m: ToWorker) {
        this.sent.push(m);
        if (m.type === 'load') queueMicrotask(() => this.emit({ type: 'error', message: 'no backend', gpuFailed: m.device !== 'wasm' }));
      }
    }
    const e = new Embedder({ makeWorker: () => (workers.push(new AlwaysFail()), workers.at(-1) as unknown as Worker) });
    await expect(e.load(manifest, () => {})).rejects.toThrow(/no backend/);
    expect(workers).toHaveLength(2);
  });
});
