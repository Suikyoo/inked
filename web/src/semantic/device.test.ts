import { describe, expect, it } from 'vitest';
import { pickDevice, type GpuLike } from './device';

const gpu = (requestAdapter: () => Promise<unknown>) => ({ requestAdapter }) as GpuLike;

describe('pickDevice', () => {
  it('uses WASM when the browser has no WebGPU', async () => {
    expect(await pickDevice(undefined)).toBe('wasm');
  });
  it('uses WASM when WebGPU exists but there is no adapter (no GPU)', async () => {
    expect(await pickDevice(gpu(async () => null))).toBe('wasm');
  });
  it('uses WASM when asking for an adapter throws', async () => {
    expect(await pickDevice(gpu(async () => Promise.reject(new Error('blocked'))))).toBe('wasm');
  });
  it('uses WebGPU when an adapter is available', async () => {
    expect(await pickDevice(gpu(async () => ({})))).toBe('webgpu');
  });
});
