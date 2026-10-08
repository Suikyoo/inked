import { describe, expect, it } from 'vitest';
import { fetchManifest, modelBytes, transformerBytes } from './manifest';

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

describe('transformerBytes', () => {
  it('sums only the files transformers.js fetches (under modelPath)', () => {
    const m = {
      ...good,
      modelPath: 'abcd1234/',
      ortPath: 'ort-1/',
      files: [
        { path: 'abcd1234/tokenizer.json', sha256: 'a', bytes: 700 },
        { path: 'abcd1234/model.onnx', sha256: 'b', bytes: 33_000 },
        { path: 'ort-1/ort-wasm.wasm', sha256: 'c', bytes: 21_600 },
      ],
    };
    expect(transformerBytes(m)).toBe(33_700);
    expect(modelBytes(m)).toBe(55_300);
  });
});
