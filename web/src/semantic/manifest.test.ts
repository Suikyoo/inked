import { describe, expect, it } from 'vitest';
import { fetchManifest } from './manifest';

const res = (status: number, body: string, type = 'application/json') =>
  Promise.resolve(new Response(body, { status, headers: { 'content-type': type } }));
const good = { model: 'bge-small-en-v1.5', id: 'bge-small-en-v1.5@abcd1234', revision: 'abcd1234ff', modelPath: 'abcd1234/', ortPath: 'ort-1/', files: [] };

describe('fetchManifest', () => {
  it('returns the manifest', async () => {
    expect(await fetchManifest(() => res(200, JSON.stringify(good)))).toEqual(good);
  });
  it('treats 404, HTML (SPA fallback), bad shapes and network errors as unavailable', async () => {
    expect(await fetchManifest(() => res(404, '{"error":"not_found"}'))).toBeNull();
    expect(await fetchManifest(() => res(200, '<!doctype html>', 'text/html'))).toBeNull();
    expect(await fetchManifest(() => res(200, '{"model":1}'))).toBeNull();
    expect(await fetchManifest(() => Promise.reject(new TypeError('offline')))).toBeNull();
  });
});
