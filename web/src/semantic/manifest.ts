export interface Manifest {
  model: string;
  id: string;
  revision: string;
  modelPath: string;
  ortPath: string;
  files: { path: string; sha256: string; bytes: number }[];
}
export const MODELS_BASE = '/models/';

const isManifest = (v: unknown): v is Manifest => {
  const m = v as Manifest;
  return (
    !!m && typeof m.model === 'string' && typeof m.id === 'string' && typeof m.revision === 'string' &&
    typeof m.modelPath === 'string' && typeof m.ortPath === 'string' && Array.isArray(m.files)
  );
};

/** The deployment's model manifest, or null when this deployment ships without the model. */
export async function fetchManifest(fetcher: typeof fetch = fetch): Promise<Manifest | null> {
  try {
    const res = await fetcher(`${MODELS_BASE}manifest.json`, { cache: 'no-cache' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    const v: unknown = await res.json();
    return isManifest(v) ? v : null;
  } catch {
    return null;
  }
}

export const modelBytes = (m: Manifest) => m.files.reduce((n, f) => n + f.bytes, 0);

/** Bytes of the files transformers.js fetches and reports (under modelPath); ORT files are excluded. */
export const transformerBytes = (m: Manifest) =>
  m.files.reduce((n, f) => (f.path.startsWith(m.modelPath) ? n + f.bytes : n), 0);
