import type { KdfParams } from 'inked-core';
import type { FolderDTO, InviteDTO, NoteDTO, NoteHeadDTO, RegisterBody, SetupBody, User, VaultDTO } from 'inked-core';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter?: number;
  constructor(status: number, code: string, message?: string, retryAfter?: number) {
    super(message || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export const isApiError = (e: unknown, status?: number): e is ApiError =>
  e instanceof ApiError && (status === undefined || e.status === status);

/** Called on any 401 from an authenticated endpoint (session expired or revoked). */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

/**
 * The account whose keys this tab holds. Every tab shares the session cookie, so another tab may
 * have signed in as someone else: data requests name this account (X-Inked-User) and the server
 * refuses them (409 user_mismatch) instead of answering as the other account.
 */
let requestUser: string | null = null;
export function setRequestUser(id: string | null) {
  requestUser = id;
}

/** Called when a request naming the signed-in account met another account's session. */
let onUserMismatch: (() => void) | null = null;
export function setUserMismatchHandler(fn: (() => void) | null) {
  onUserMismatch = fn;
}

export const isUserMismatch = (e: unknown): e is ApiError => isApiError(e, 409) && e.code === 'user_mismatch';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface RequestOptions {
  authed?: boolean;
  /** A data route: names the account in X-Inked-User. The auth routes never do. */
  bound?: boolean;
  /** Names this account instead of the signed-in one (queued sends name their owner); a mismatch is then the caller's to handle. */
  asUser?: string;
  /** Aborting it fails the request with the same network error as a dropped connection (status 0). */
  signal?: AbortSignal;
  /** Gives up after this many milliseconds: the request is aborted, with the same network error. */
  timeoutMs?: number;
}

/** Per-call options for requests whose wait the caller bounds, or that act for a given account. */
export interface CallOptions {
  timeoutMs?: number;
  /** The account this request is for (X-Inked-User); see RequestOptions.asUser. */
  asUser?: string;
}

const networkError = () => new ApiError(0, 'network', 'Can’t reach the server. Check your connection and try again.');

async function request<T>(method: Method, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Inked'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const user = opts.bound ? (opts.asUser ?? requestUser) : null;
  if (user) headers['X-Inked-User'] = user;
  let signal = opts.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs !== undefined) {
    const ac = new AbortController();
    const outer = opts.signal;
    if (outer?.aborted) ac.abort();
    else outer?.addEventListener('abort', () => ac.abort(), { once: true });
    timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    signal = ac.signal;
  }
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
    // An abort (or a dropped connection) can also land while the body is read.
    text = await res.text();
  } catch {
    throw networkError();
  } finally {
    clearTimeout(timer);
  }
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; message?: string; retryAfter?: number };
    const headerRetry = Number(res.headers.get('Retry-After'));
    const retryAfter = typeof d.retryAfter === 'number' ? d.retryAfter : Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry : undefined;
    const err = new ApiError(res.status, d.error ?? `http_${res.status}`, d.message, retryAfter);
    if (res.status === 401 && opts.authed !== false) onUnauthorized?.();
    // Only while this tab still holds the account it named: a late answer to a request sent before
    // this tab itself switched accounts must not end the new session.
    if (isUserMismatch(err) && opts.asUser === undefined && user === requestUser) onUserMismatch?.();
    throw err;
  }
  return data as T;
}

const enc = encodeURIComponent;

/** A request to a data route (vaults, folders, notes, invites): bound to the account, see setRequestUser. */
const data = <T>(method: Method, path: string, body?: unknown, opts: CallOptions = {}) =>
  request<T>(method, path, body, { bound: true, timeoutMs: opts.timeoutMs, asUser: opts.asUser });

export const api = {
  status: () => request<{ needsSetup: boolean; llmOrigins?: string[] }>('GET', '/api/status', undefined, { authed: false }),
  setup: (body: SetupBody) => request<{ user: User }>('POST', '/api/setup', body, { authed: false }),
  params: (username: string) =>
    request<{ kdfSalt: string; kdfParams: KdfParams }>('GET', `/api/auth/params?username=${enc(username)}`, undefined, {
      authed: false,
    }),
  login: (username: string, authKey: string) =>
    request<{ user: User; wrappedUserKey: string }>('POST', '/api/auth/login', { username, authKey }, { authed: false }),
  logout: (signal?: AbortSignal) => request<{ ok: true }>('POST', '/api/auth/logout', {}, { authed: false, signal }),
  me: () => request<{ user: User; wrappedUserKey: string }>('GET', '/api/me', undefined, { authed: false }),
  register: (body: RegisterBody) => request<{ user: User }>('POST', '/api/auth/register', body, { authed: false }),
  changePassword: (body: {
    currentAuthKey: string;
    kdfSalt: string;
    kdfParams: KdfParams;
    authKey: string;
    wrappedUserKey: string;
  }) => request<{ ok: true }>('POST', '/api/auth/password', body),
  rotateRecoveryKey: (body: { currentAuthKey: string; recoveryAuth: string; wrappedUserKeyRecovery: string }) =>
    request<{ ok: true }>('POST', '/api/auth/recovery-key', body),
  recoverStart: (username: string, recoveryAuth: string) =>
    request<{ userId: string; wrappedUserKeyRecovery: string }>(
      'POST',
      '/api/auth/recover/start',
      { username, recoveryAuth },
      { authed: false },
    ),
  recoverFinish: (body: {
    username: string;
    recoveryAuth: string;
    kdfSalt: string;
    kdfParams: KdfParams;
    authKey: string;
    wrappedUserKey: string;
  }) => request<{ user: User; wrappedUserKey: string }>('POST', '/api/auth/recover/finish', body, { authed: false }),

  createInvite: (expiresInHours?: number) =>
    data<{ token: string; expiresAt: string }>('POST', '/api/invites', expiresInHours ? { expiresInHours } : {}),
  listInvites: () => data<{ invites: InviteDTO[] }>('GET', '/api/invites'),
  revokeInvite: (id: string) => data<{ ok: true }>('DELETE', `/api/invites/${enc(id)}`),
  checkInvite: (token: string) =>
    request<{ valid: boolean }>('GET', `/api/invites/check?token=${enc(token)}`, undefined, { authed: false }),

  listVaults: () => data<{ vaults: VaultDTO[] }>('GET', '/api/vaults'),
  createVault: (body: { id: string; encMeta: string; wrappedKey: string }) =>
    data<{ vault: VaultDTO }>('POST', '/api/vaults', body),
  updateVault: (id: string, encMeta: string) => data<{ vault: VaultDTO }>('PATCH', `/api/vaults/${enc(id)}`, { encMeta }),
  deleteVault: (id: string) => data<unknown>('DELETE', `/api/vaults/${enc(id)}`),
  listVectors: (vaultId: string) =>
    data<{ vectors: { noteId: string; model: string; encVec: string; sourceUpdatedAt: string }[] }>('GET', `/api/vaults/${enc(vaultId)}/vectors`),
  putVector: (noteId: string, body: { model: string; encVec: string; sourceUpdatedAt: string }) =>
    data<{ ok: true }>('PUT', `/api/notes/${enc(noteId)}/vector`, body),
  getSettings: () => data<{ encSettings: string | null; updatedAt: string | null }>('GET', '/api/me/settings'),
  putSettings: (body: { encSettings: string; baseUpdatedAt: string | null }) =>
    data<{ updatedAt: string }>('PUT', '/api/me/settings', body),
  tree: (vaultId: string) =>
    data<{ folders: FolderDTO[]; notes: NoteHeadDTO[] }>('GET', `/api/vaults/${enc(vaultId)}/tree`),
  bodies: (vaultId: string) =>
    data<{ notes: { id: string; encBody: string; updatedAt: string }[] }>('GET', `/api/vaults/${enc(vaultId)}/bodies`),

  createFolder: (vaultId: string, body: { id: string; parentId: string | null; encMeta: string }) =>
    data<{ folder: FolderDTO }>('POST', `/api/vaults/${enc(vaultId)}/folders`, body),
  updateFolder: (id: string, body: { encMeta?: string; parentId?: string | null }) =>
    data<{ folder: FolderDTO }>('PATCH', `/api/folders/${enc(id)}`, body),
  deleteFolder: (id: string) => data<unknown>('DELETE', `/api/folders/${enc(id)}`),

  createNote: (
    vaultId: string,
    body: { id: string; folderId: string | null; encMeta: string; encBody: string },
    opts: CallOptions = {},
  ) => data<{ note: NoteHeadDTO }>('POST', `/api/vaults/${enc(vaultId)}/notes`, body, opts),
  getNote: (id: string, opts: CallOptions = {}) => data<{ note: NoteDTO }>('GET', `/api/notes/${enc(id)}`, undefined, opts),
  updateNote: (
    id: string,
    body: { encMeta?: string; encBody?: string; folderId?: string | null; baseUpdatedAt?: string },
    opts: CallOptions = {},
  ) => data<{ note: NoteHeadDTO }>('PUT', `/api/notes/${enc(id)}`, body, opts),
  deleteNote: (id: string) => data<{ ok: true }>('DELETE', `/api/notes/${enc(id)}`),
};
