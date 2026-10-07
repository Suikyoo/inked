import type { FolderDTO, KdfParams, NoteDTO, NoteHeadDTO, User, VaultDTO } from 'inked-core';
import { ApiError, NonApiResponse } from './errors';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** https only, except plain http to this machine; no query or fragment; no trailing slash. */
export function normalizeBaseUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Error(`Not a URL: ${input}`);
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) {
    throw new Error('The Inked URL must use https:// (http:// is allowed only for localhost)');
  }
  if (u.search || u.hash) throw new Error('The Inked URL must not contain a query or fragment');
  return u.origin + u.pathname.replace(/\/+$/, '');
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH';
const enc = encodeURIComponent;

/**
 * The Inked HTTP API for a Node process: its own cookie jar (inked_session, inked_device), the CSRF
 * header on every write, and X-Inked-User on every data route, like the web client.
 */
export class InkedApi {
  userId: string | null = null;
  private session: string | null = null;
  private device: string | null;
  private readonly f: typeof fetch;

  constructor(
    readonly baseUrl: string,
    opts: { deviceCookie?: string | null; fetch?: typeof fetch } = {},
  ) {
    this.device = opts.deviceCookie ?? null;
    this.f = opts.fetch ?? fetch;
  }

  get deviceCookie(): string | null {
    return this.device;
  }

  private takeCookies(res: Response): void {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = !value || attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a));
      if (name === 'inked_session') this.session = expired ? null : value;
      if (name === 'inked_device' && !expired) this.device = value;
    }
  }

  private async request<T>(method: Method, path: string, body?: unknown, bound = false): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (method !== 'GET') headers['X-Inked'] = '1';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (bound && this.userId) headers['X-Inked-User'] = this.userId;
    const cookies: string[] = [];
    if (this.session) cookies.push(`inked_session=${this.session}`);
    if (this.device && path.startsWith('/api/auth')) cookies.push(`inked_device=${this.device}`);
    if (cookies.length) headers.Cookie = cookies.join('; ');

    let res: Response;
    let text: string;
    try {
      res = await this.f(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
      });
      text = await res.text();
    } catch {
      throw new ApiError(0, 'network', 'Can’t reach the Inked server.');
    }
    if (res.status >= 300 && res.status < 400) throw new NonApiResponse(res.status);
    this.takeCookies(res);

    let data: unknown = null;
    if (text) {
      if (!(res.headers.get('content-type') ?? '').includes('application/json')) throw new NonApiResponse(res.status);
      try {
        data = JSON.parse(text);
      } catch {
        throw new NonApiResponse(res.status);
      }
    }
    if (!res.ok) {
      const d = (data ?? {}) as { error?: string; message?: string; retryAfter?: number };
      const header = Number(res.headers.get('Retry-After'));
      const retryAfter = typeof d.retryAfter === 'number' ? d.retryAfter : header > 0 ? header : undefined;
      throw new ApiError(res.status, d.error ?? `http_${res.status}`, d.message, retryAfter);
    }
    return data as T;
  }

  params(username: string) {
    return this.request<{ kdfSalt: string; kdfParams: KdfParams }>('GET', `/api/auth/params?username=${enc(username)}`);
  }

  async login(username: string, authKey: string) {
    const out = await this.request<{ user: User; wrappedUserKey: string }>('POST', '/api/auth/login', { username, authKey });
    this.userId = out.user.id;
    return out;
  }

  async logout() {
    try {
      await this.request<{ ok: true }>('POST', '/api/auth/logout', {});
    } finally {
      this.session = null;
    }
  }

  listVaults = () => this.request<{ vaults: VaultDTO[] }>('GET', '/api/vaults', undefined, true);
  tree = (vaultId: string) =>
    this.request<{ folders: FolderDTO[]; notes: NoteHeadDTO[] }>('GET', `/api/vaults/${enc(vaultId)}/tree`, undefined, true);
  bodies = (vaultId: string) =>
    this.request<{ notes: { id: string; encBody: string; updatedAt: string }[] }>(
      'GET', `/api/vaults/${enc(vaultId)}/bodies`, undefined, true,
    );
  getNote = (id: string) => this.request<{ note: NoteDTO }>('GET', `/api/notes/${enc(id)}`, undefined, true);
  createFolder = (vaultId: string, body: { id: string; parentId: string | null; encMeta: string }) =>
    this.request<{ folder: FolderDTO }>('POST', `/api/vaults/${enc(vaultId)}/folders`, body, true);
  updateFolder = (id: string, body: { encMeta?: string; parentId?: string | null }) =>
    this.request<{ folder: FolderDTO }>('PATCH', `/api/folders/${enc(id)}`, body, true);
  createNote = (vaultId: string, body: { id: string; folderId: string | null; encMeta: string; encBody: string }) =>
    this.request<{ note: NoteHeadDTO }>('POST', `/api/vaults/${enc(vaultId)}/notes`, body, true);
  updateNote = (
    id: string,
    body: { encMeta?: string; encBody?: string; folderId?: string | null; baseUpdatedAt?: string },
  ) => this.request<{ note: NoteHeadDTO }>('PUT', `/api/notes/${enc(id)}`, body, true);
}
