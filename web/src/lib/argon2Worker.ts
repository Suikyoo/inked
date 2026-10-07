import { argon2Direct, type Argon2Fn } from 'inked-core';

/**
 * Argon2id in a short-lived Web Worker (terminated afterwards, which also frees the 64 MiB
 * of WASM memory). Falls back to the main thread if workers are unavailable.
 */
export const argon2InWorker: Argon2Fn = (password, salt, params) =>
  new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./argon2.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      argon2Direct(password, salt, params).then(resolve, reject);
      return;
    }
    const fallback = () => {
      worker.terminate();
      argon2Direct(password, salt, params).then(resolve, reject);
    };
    worker.onmessage = (e: MessageEvent<{ ok: boolean; out?: Uint8Array<ArrayBuffer> }>) => {
      worker.terminate();
      if (e.data.ok && e.data.out) resolve(new Uint8Array(e.data.out));
      else reject(new Error('Key derivation failed'));
    };
    worker.onerror = (ev) => {
      ev.preventDefault();
      fallback();
    };
    const pw = password.slice();
    worker.postMessage({ password: pw, salt: salt.slice(), params }, [pw.buffer]);
  });
