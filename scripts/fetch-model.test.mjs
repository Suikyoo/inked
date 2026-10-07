import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FILES, manifestFor, MODEL, ORT_FILES, PINNED, sha256 } from './fetch-model.mjs';

test('manifest paths are relative to /models and carry the short revision', () => {
  const m = manifestFor({ revision: '0123456789abcdef', ortVersion: '1.22.0', files: [] });
  assert.equal(m.id, `${MODEL}@01234567`);
  assert.equal(m.modelPath, '01234567/');
  assert.equal(m.ortPath, 'ort-1.22.0/');
});

test('sha256 is lowercase hex', () => {
  assert.match(sha256(Buffer.from('x')), /^[0-9a-f]{64}$/);
});

test('every downloaded file has a pinned sha256', () => {
  for (const f of FILES) assert.match(PINNED[f] ?? '', /^[0-9a-f]{64}$/, f);
  assert.deepEqual(Object.keys(PINNED).sort(), [...FILES].sort());
});

test('ORT pair is the jsep module and wasm', () => {
  assert.deepEqual(ORT_FILES, ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']);
});
