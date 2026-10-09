import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { AccountSettingsStore } from './accountSettings';

function fakeApp() {
  let state: any = { phase: 'locked', locking: false };
  const ls = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (f: () => void) => (ls.add(f), () => ls.delete(f)),
    set(p: any) {
      state = { ...state, ...p };
      ls.forEach((f) => f());
    },
    // "Encryption" is JSON with a prefix, so tests can read what was saved.
    encryptAccountSettings: vi.fn(async (s: unknown) => `v1.${JSON.stringify(s)}`),
    decryptAccountSettings: vi.fn(async (ct: string) => {
      if (!ct.startsWith('v1.{')) throw new Error('bad');
      return JSON.parse(ct.slice(3));
    }),
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function server(initial: { enc: string | null; at: string | null } = { enc: null, at: null }) {
  const row = { ...initial };
  let n = 0;
  return {
    row,
    api: {
      status: vi.fn(async () => ({ needsSetup: false, llmOrigins: ['https://api.openai.com'] })),
      getSettings: vi.fn(async () => ({ encSettings: row.enc, updatedAt: row.at })),
      putSettings: vi.fn(async (b: { encSettings: string; baseUpdatedAt: string | null }) => {
        if (b.baseUpdatedAt !== row.at) throw new ApiError(409, 'conflict');
        row.enc = b.encSettings;
        row.at = `t${++n}`;
        return { updatedAt: row.at };
      }),
    },
  };
}

describe('AccountSettingsStore', () => {
  it('loads origins and decrypted settings after unlock', async () => {
    const app = fakeApp();
    const srv = server({ enc: 'v1.{"semantic":true}', at: 't0' });
    const s = new AccountSettingsStore(app as any, { api: srv.api as any });
    expect(s.getState().loaded).toBe(false);
    app.set({ phase: 'unlocked' });
    await flush();
    expect(s.getState()).toMatchObject({ loaded: true, settings: { semantic: true }, llmOrigins: ['https://api.openai.com'], unreadable: false });
  });
  it('treats unreadable settings as unset', async () => {
    const app = fakeApp();
    const s = new AccountSettingsStore(app as any, { api: server({ enc: 'v1.garbage', at: 't0' }).api as any });
    app.set({ phase: 'unlocked' });
    await flush();
    expect(s.getState()).toMatchObject({ loaded: true, settings: {}, unreadable: true });
  });
  it('saves a change with the base it read', async () => {
    const app = fakeApp();
    const srv = server();
    const s = new AccountSettingsStore(app as any, { api: srv.api as any });
    app.set({ phase: 'unlocked' });
    await flush();
    await s.update((cur) => ({ ...cur, semantic: true }));
    expect(srv.row.enc).toBe('v1.{"semantic":true}');
    expect(s.getState().settings).toEqual({ semantic: true });
  });
  it('re-reads, merges and retries once on 409', async () => {
    const app = fakeApp();
    const srv = server();
    const s = new AccountSettingsStore(app as any, { api: srv.api as any });
    app.set({ phase: 'unlocked' });
    await flush();
    // Another device saves an API key after this one loaded.
    srv.row.enc = 'v1.{"llm":{"baseUrl":"https://api.openai.com/v1","model":"m","apiKey":"k"}}';
    srv.row.at = 'other';
    await s.update((cur) => ({ ...cur, semantic: false }));
    expect(JSON.parse(srv.row.enc!.slice(3))).toEqual({ llm: { baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k' }, semantic: false });
  });
  it('throws after a second conflict', async () => {
    const app = fakeApp();
    const srv = server();
    srv.api.putSettings.mockRejectedValue(new ApiError(409, 'conflict'));
    const s = new AccountSettingsStore(app as any, { api: srv.api as any });
    app.set({ phase: 'unlocked' });
    await flush();
    await expect(s.update((c) => ({ ...c, semantic: true }))).rejects.toBeInstanceOf(ApiError);
    expect(srv.api.putSettings).toHaveBeenCalledTimes(2);
  });
  it('drops everything on lock', async () => {
    const app = fakeApp();
    const s = new AccountSettingsStore(app as any, { api: server({ enc: 'v1.{"semantic":true}', at: 't0' }).api as any });
    app.set({ phase: 'unlocked' });
    await flush();
    app.set({ locking: true });
    expect(s.getState()).toMatchObject({ loaded: false, settings: {} });
  });
  it('serializes concurrent updates so neither is lost', async () => {
    const app = fakeApp();
    const srv = server();
    const s = new AccountSettingsStore(app as any, { api: srv.api as any });
    app.set({ phase: 'unlocked' });
    await flush();
    const llm = { baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k' };
    await Promise.all([s.update((c) => ({ ...c, semantic: true })), s.update((c) => ({ ...c, llm }))]);
    expect(JSON.parse(srv.row.enc!.slice(3))).toEqual({ semantic: true, llm });
    expect(srv.api.putSettings).toHaveBeenCalledTimes(2);
  });
  it('rejects and sends nothing when locked during encryption', async () => {
    const app = fakeApp();
    const srv = server();
    const s = new AccountSettingsStore(app as any, { api: srv.api as any });
    app.set({ phase: 'unlocked' });
    await flush();
    let release!: () => void;
    app.encryptAccountSettings.mockImplementationOnce(async (x: unknown) => {
      await new Promise<void>((r) => (release = r));
      return `v1.${JSON.stringify(x)}`;
    });
    const p = s.update((c) => ({ ...c, semantic: true }));
    const settled = expect(p).rejects.toThrow('locked');
    await flush();
    app.set({ locking: true });
    release();
    await settled;
    expect(srv.api.putSettings).not.toHaveBeenCalled();
  });
  it('rejects when locked', async () => {
    const s = new AccountSettingsStore(fakeApp() as any, { api: server().api as any });
    await expect(s.update((c) => c)).rejects.toThrow('locked');
  });
  it('waits for the load before applying an update', async () => {
    const app = fakeApp();
    const srv = server({ enc: 'v1.{"semantic":true}', at: 't0' });
    const s = new AccountSettingsStore(app as any, { api: srv.api as any });
    app.set({ phase: 'unlocked' });
    await s.update((c) => ({ ...c, llm: undefined, semantic: !c.semantic }));
    expect(s.getState().loaded).toBe(true);
    expect(JSON.parse(srv.row.enc!.slice(3)).semantic).toBe(false);
  });
  it('ignores a load from a previous epoch that resolves late', async () => {
    const app = fakeApp();
    const srv = server({ enc: 'v1.{"semantic":true}', at: 'old' });
    let release!: () => void;
    srv.api.getSettings.mockImplementationOnce(async () => {
      await new Promise<void>((r) => (release = r));
      return { encSettings: 'v1.{"semantic":true}', updatedAt: 'stale' };
    });
    const s = new AccountSettingsStore(app as any, { api: srv.api as any });
    app.set({ phase: 'unlocked' });
    await flush();
    app.set({ locking: true });
    app.set({ locking: false });
    await flush();
    release();
    await flush();
    await s.update((c) => ({ ...c, semantic: false }));
    expect(srv.api.putSettings).toHaveBeenCalledWith(expect.objectContaining({ baseUpdatedAt: 'old' }));
  });
  it('does not retry a user_mismatch 409', async () => {
    const app = fakeApp();
    const srv = server();
    srv.api.putSettings.mockRejectedValue(new ApiError(409, 'user_mismatch'));
    const s = new AccountSettingsStore(app as any, { api: srv.api as any });
    app.set({ phase: 'unlocked' });
    await flush();
    await expect(s.update((c) => ({ ...c, semantic: true }))).rejects.toMatchObject({ code: 'user_mismatch' });
    expect(srv.api.putSettings).toHaveBeenCalledTimes(1);
  });
});
