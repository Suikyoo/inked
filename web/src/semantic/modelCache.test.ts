import { describe, expect, it } from 'vitest';
import { clearModelCache, MODEL_CACHE, verifyModelCache } from './modelCache';

function fakeCaches(entries: Record<string, string>) {
  const store = new Map(Object.entries(entries).map(([k, v]) => [k, new Response(v)]));
  const cache = {
    keys: async () => [...store.keys()].map((u) => new Request(u)),
    match: async (r: Request) => store.get(r.url)?.clone(),
    delete: async (r: Request) => store.delete(r.url),
  };
  const deleted: string[] = [];
  return {
    store,
    deleted,
    api: { open: async () => cache, delete: async (n: string) => (deleted.push(n), true) } as unknown as CacheStorage,
  };
}
const hex = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('model cache', () => {
  it('keeps matching files and removes mismatched or unknown ones', async () => {
    const base = 'http://localhost/models/';
    const c = fakeCaches({ [base + 'r/a.json']: 'good', [base + 'r/b.json']: 'tampered', [base + 'old/x.json']: 'stale' });
    const manifest = {
      model: 'm', id: 'm@r', revision: 'r', modelPath: 'r/', ortPath: 'o/',
      files: [{ path: 'r/a.json', sha256: await hex('good'), bytes: 4 }, { path: 'r/b.json', sha256: await hex('good'), bytes: 4 }],
    };
    expect(await verifyModelCache(manifest, c.api, base)).toBe(2);
    expect([...c.store.keys()]).toEqual([base + 'r/a.json']);
  });
  it('clears the whole cache', async () => {
    const c = fakeCaches({});
    await clearModelCache(c.api);
    expect(c.deleted).toEqual([MODEL_CACHE]);
  });
});
