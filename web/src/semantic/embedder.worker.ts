/// <reference lib="webworker" />
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { pickDevice, type Device, type GpuLike } from './device';
import { QUERY_PREFIX, type FromWorker, type ToWorker } from './protocol';

let extractor: FeatureExtractionPipeline | null = null;
const post = (m: FromWorker) => (self as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  let device: Device = 'wasm';
  try {
    if (m.type === 'load') {
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.useBrowserCache = true;
      env.localModelPath = m.base + m.manifest.modelPath;
      if (env.backends.onnx.wasm) {
        env.backends.onnx.wasm.wasmPaths = m.base + m.manifest.ortPath;
        env.backends.onnx.wasm.numThreads = 1;
      }
      const sizes = new Map<string, { loaded: number; total: number }>();
      device = m.device ?? (await pickDevice((navigator as Navigator & { gpu?: GpuLike }).gpu));
      // No in-worker fallback: transformers.js keeps the first session's promise (backends/onnx.js wasmInitPromise),
      // so after a failed WebGPU session every later session rethrows. The client retries in a fresh WASM worker.
      const make = (d: Device) =>
        pipeline('feature-extraction', m.manifest.model, {
          dtype: 'q8',
          device: d,
          progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
            if (p.status !== 'progress' || !p.file) return;
            sizes.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
            let loaded = 0;
            let total = 0;
            for (const s of sizes.values()) {
              loaded += s.loaded;
              total += s.total;
            }
            post({ type: 'progress', loaded, total });
          },
        });
      extractor = (await make(device)) as FeatureExtractionPipeline;
      post({ type: 'ready' });
    } else if (m.type === 'embed') {
      if (!extractor) throw new Error('model not loaded');
      const texts = m.kind === 'query' ? m.texts.map((t) => QUERY_PREFIX + t) : m.texts;
      const out = await extractor(texts, { pooling: 'cls', normalize: true });
      const dim = out.dims[out.dims.length - 1];
      const data = out.data as Float32Array;
      const vectors = texts.map((_, i) => data.slice(i * dim, (i + 1) * dim));
      post({ type: 'result', id: m.id, vectors });
    }
  } catch (err) {
    console.error('embedder:', err);
    if (m.type === 'embed') post({ type: 'error', id: m.id, message: (err as Error).message });
    else post({ type: 'error', message: (err as Error).message, gpuFailed: device === 'webgpu' });
  }
};
