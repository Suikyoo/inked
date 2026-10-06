/// <reference lib="webworker" />
// Runs Argon2id off the main thread so the UI stays responsive while unlocking.
import { argon2Direct, type KdfParams } from './kdf';

interface Req {
  password: Uint8Array<ArrayBuffer>;
  salt: Uint8Array<ArrayBuffer>;
  params: KdfParams;
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<Req>) => {
  const { password, salt, params } = e.data;
  try {
    const out = await argon2Direct(password, salt, params);
    ctx.postMessage({ ok: true, out }, [out.buffer]);
  } catch {
    ctx.postMessage({ ok: false });
  } finally {
    password.fill(0);
  }
};
