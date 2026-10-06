import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './client';

/** A fetch that never answers on its own and rejects like the browser's when its signal aborts. */
function hangingFetch() {
  return vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      }),
  );
}

describe('api client abort (A3)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes the signal to fetch and maps an abort to the network error', async () => {
    const fetch = hangingFetch();
    vi.stubGlobal('fetch', fetch);
    const ac = new AbortController();
    const p = api.logout(ac.signal).catch((e) => e);
    expect(fetch.mock.calls[0][1].signal).toBe(ac.signal);
    expect(fetch.mock.calls[0][1].headers).toMatchObject({ 'X-Inked': '1' });
    ac.abort();
    const err = await p;
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'network' });
  });

  it('maps an abort while the body is read to the network error too', async () => {
    const ac = new AbortController();
    const res = {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () =>
        new Promise<string>((_r, reject) =>
          ac.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))),
        ),
    };
    vi.stubGlobal('fetch', vi.fn(async () => res));
    const p = api.logout(ac.signal).catch((e) => e);
    await Promise.resolve();
    ac.abort();
    expect(await p).toMatchObject({ name: 'ApiError', status: 0, code: 'network' });
  });
});

describe('api client timeout (B2)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('aborts a request that takes longer than timeoutMs, as a network error', async () => {
    vi.useFakeTimers();
    const fetch = hangingFetch();
    vi.stubGlobal('fetch', fetch);
    let settled = false;
    const p = api.updateNote('n1', { encBody: 'v1.x' }, { timeoutMs: 30_000 }).catch((e) => e).finally(() => (settled = true));
    expect(fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ name: 'ApiError', status: 0, code: 'network' });
  });

  it('clears the timer once the request is answered', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ note: { id: 'c1' } }), { status: 200 })));
    await api.createNote('v1', { id: 'c1', folderId: null, encMeta: 'm', encBody: 'b' }, { timeoutMs: 30_000 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
