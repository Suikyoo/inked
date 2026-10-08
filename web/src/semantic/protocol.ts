import type { Manifest } from './manifest';
export type EmbedKind = 'query' | 'passage';
export type ToWorker =
  | { type: 'load'; manifest: Manifest; base: string; device?: 'wasm' }
  | { type: 'embed'; id: number; texts: string[]; kind: EmbedKind };
export type FromWorker =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready' }
  | { type: 'result'; id: number; vectors: Float32Array[] }
  | { type: 'error'; id?: number; message: string; gpuFailed?: boolean };
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
