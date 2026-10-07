import { MODELS_BASE, type Manifest } from './manifest';

/** transformers.js keeps downloaded model files in this Cache Storage bucket. */
export const MODEL_CACHE = 'transformers-cache';

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Deletes cached model files whose bytes don't match the manifest, or that the manifest no longer lists. */
export async function verifyModelCache(
  manifest: Manifest,
  cacheStorage: CacheStorage = caches,
  base = new URL(MODELS_BASE, location.origin).href,
): Promise<number> {
  const cache = await cacheStorage.open(MODEL_CACHE);
  const want = new Map(manifest.files.map((f) => [base + f.path, f.sha256]));
  let removed = 0;
  for (const req of await cache.keys()) {
    const expected = want.get(req.url);
    const res = expected ? await cache.match(req) : undefined;
    const ok = !!res && hex(await crypto.subtle.digest('SHA-256', await res.arrayBuffer())) === expected;
    if (!ok) {
      await cache.delete(req);
      removed++;
    }
  }
  return removed;
}

export async function clearModelCache(cacheStorage: CacheStorage = caches): Promise<void> {
  await cacheStorage.delete(MODEL_CACHE);
}

/** Asks the browser not to evict this site's storage; false when refused or unsupported. */
export async function requestPersist(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
