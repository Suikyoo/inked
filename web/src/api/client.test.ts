import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setRequestUser, setUserMismatchHandler } from './client';

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
      text: vi.fn(
        () =>
          new Promise<string>((_r, reject) =>
            ac.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))),
          ),
      ),
    };
    vi.stubGlobal('fetch', vi.fn(async () => res));
    const p = api.logout(ac.signal).catch((e) => e);
    // Abort only once the body read has begun, however many ticks fetch takes to get there.
    await vi.waitFor(() => expect(res.text).toHaveBeenCalled());
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

describe('X-Inked-User (account binding)', () => {
  const ok = (body: unknown = {}) =>
    vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(body), { status: 200 }));
  const headersOf = (fetch: ReturnType<typeof ok>, i = 0) => fetch.mock.calls[i][1].headers as Record<string, string>;

  afterEach(() => {
    setRequestUser(null);
    setUserMismatchHandler(null);
    vi.unstubAllGlobals();
  });

  it('names the signed-in account on every data request, and on no auth request', async () => {
    const fetch = ok({ note: {}, vaults: [], invites: [], folders: [], notes: [] });
    vi.stubGlobal('fetch', fetch);
    setRequestUser('ann-id');
    const data = [
      () => api.listVaults(),
      () => api.createVault({ id: 'v', encMeta: 'm', wrappedKey: 'k' }),
      () => api.updateVault('v', 'm'),
      () => api.deleteVault('v'),
      () => api.tree('v'),
      () => api.bodies('v'),
      () => api.createFolder('v', { id: 'f', parentId: null, encMeta: 'm' }),
      () => api.updateFolder('f', { encMeta: 'm' }),
      () => api.deleteFolder('f'),
      () => api.createNote('v', { id: 'n', folderId: null, encMeta: 'm', encBody: 'b' }),
      () => api.getNote('n'),
      () => api.updateNote('n', { encBody: 'b' }),
      () => api.deleteNote('n'),
      () => api.createInvite(),
      () => api.listInvites(),
      () => api.revokeInvite('i'),
    ];
    for (const send of data) await send();
    for (let i = 0; i < data.length; i++) expect([fetch.mock.calls[i][0], headersOf(fetch, i)['X-Inked-User']]).toEqual([fetch.mock.calls[i][0], 'ann-id']);
    fetch.mockClear();
    const auth = [
      () => api.status(),
      () => api.params('ann'),
      () => api.login('ann', 'k'),
      () => api.logout(),
      () => api.me(),
      () => api.changePassword({ currentAuthKey: 'a', kdfSalt: 's', kdfParams: { alg: 'argon2id', m: 1, t: 1, p: 1 }, authKey: 'b', wrappedUserKey: 'w' }),
      () => api.rotateRecoveryKey({ currentAuthKey: 'a', recoveryAuth: 'r', wrappedUserKeyRecovery: 'w' }),
      () => api.checkInvite('t'),
    ];
    for (const send of auth) await send();
    for (let i = 0; i < auth.length; i++) expect(headersOf(fetch, i)).not.toHaveProperty('X-Inked-User');
  });

  it('sends no account while nobody is signed in', async () => {
    const fetch = ok({ vaults: [] });
    vi.stubGlobal('fetch', fetch);
    await api.listVaults();
    expect(headersOf(fetch)).not.toHaveProperty('X-Inked-User');
  });

  it('a queued send names its own account, whoever is signed in', async () => {
    const fetch = ok({ note: {} });
    vi.stubGlobal('fetch', fetch);
    setRequestUser('bob-id');
    await api.updateNote('n', { encBody: 'b' }, { asUser: 'ann-id' });
    await api.createNote('v', { id: 'c', folderId: null, encMeta: 'm', encBody: 'b' }, { asUser: 'ann-id' });
    setRequestUser(null);
    await api.updateNote('n', { encBody: 'b' }, { asUser: 'ann-id' });
    for (let i = 0; i < 3; i++) expect(headersOf(fetch, i)['X-Inked-User']).toBe('ann-id');
  });

  it('a user_mismatch on a request of the signed-in account ends this tab’s session; on a queued send it does not', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'user_mismatch' }), { status: 409 })));
    const handler = vi.fn();
    setUserMismatchHandler(handler);
    setRequestUser('ann-id');
    await expect(api.updateNote('n', { encBody: 'b' }, { asUser: 'ann-id' })).rejects.toMatchObject({ status: 409, code: 'user_mismatch' });
    expect(handler).not.toHaveBeenCalled();
    await expect(api.updateNote('n', { encBody: 'b' })).rejects.toMatchObject({ status: 409, code: 'user_mismatch' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('a late mismatch for an account this tab has since left does not end the new session', async () => {
    let answer!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => (answer = r))));
    const handler = vi.fn();
    setUserMismatchHandler(handler);
    setRequestUser('ann-id');
    const p = api.getNote('n').catch((e) => e);
    // This tab locks and signs in as bob before ann's request is answered.
    setRequestUser('bob-id');
    answer(new Response(JSON.stringify({ error: 'user_mismatch' }), { status: 409 }));
    expect(await p).toMatchObject({ status: 409, code: 'user_mismatch' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('a plain 409 conflict is not an account mismatch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'conflict' }), { status: 409 })));
    const handler = vi.fn();
    setUserMismatchHandler(handler);
    setRequestUser('ann-id');
    await expect(api.updateNote('n', { encBody: 'b' })).rejects.toMatchObject({ status: 409, code: 'conflict' });
    expect(handler).not.toHaveBeenCalled();
  });
});
