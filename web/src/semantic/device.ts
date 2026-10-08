export type Device = 'webgpu' | 'wasm';
/** The one WebGPU call we need; avoids depending on @webgpu/types. */
export interface GpuLike {
  requestAdapter(): Promise<unknown>;
}

/**
 * WebGPU only when the browser can actually hand out an adapter. `navigator.gpu` exists in Chromium browsers even on
 * machines without a usable GPU, where `requestAdapter()` resolves to null.
 */
export async function pickDevice(gpu: GpuLike | undefined): Promise<Device> {
  try {
    return gpu && (await gpu.requestAdapter()) ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}
