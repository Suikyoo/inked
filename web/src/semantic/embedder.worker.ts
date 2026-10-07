/// <reference lib="webworker" />
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { QUERY_PREFIX, type FromWorker, type ToWorker } from './protocol';

let extractor: FeatureExtractionPipeline | null = null;
const post = (m: FromWorker) => (self as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
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
      const device = 'gpu' in navigator ? 'webgpu' : 'wasm';
      const make = (d: 'webgpu' | 'wasm') =>
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
      extractor = (await make(device).catch(() => make('wasm'))) as FeatureExtractionPipeline;
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
    post({ type: 'error', id: m.type === 'embed' ? m.id : undefined, message: (err as Error).message });
  }
};
