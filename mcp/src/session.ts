import {
  assertKdfParams,
  deriveFromMasterSecret,
  deriveMasterSecret,
  fromBase64Url,
  isCryptoError,
  toBase64Url,
  unwrapUserKey,
  unwrapVaultKey,
  wipe,
  type Argon2Fn,
  type PasswordKeys,
  type VaultDTO,
} from 'inked-core';
import { InkedApi, normalizeBaseUrl } from './api';
import type { Credential } from './credential';
import { ApiError, CredentialStale } from './errors';

/** Signs in once with the password and returns what `inked-mcp login` saves. The password is not kept. */
export async function createCredential(
  input: { baseUrl: string; username: string; password: string },
  opts: { fetch?: typeof fetch; argon2?: Argon2Fn } = {},
): Promise<Credential> {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const username = input.username.trim().toLowerCase();
  const api = new InkedApi(baseUrl, { fetch: opts.fetch });
  const { kdfSalt, kdfParams } = await api.params(username);
  const master = await deriveMasterSecret(input.password, kdfSalt, assertKdfParams(kdfParams), { argon2: opts.argon2 });
  try {
    const keys = await deriveFromMasterSecret(master);
    const { user, wrappedUserKey } = await api.login(username, keys.authKey);
    await unwrapUserKey(wrappedUserKey, keys.passwordKEK, user.id); // proves the keys are right
    const cred: Credential = {
      version: 1,
      baseUrl,
      username,
      userId: user.id,
      masterSecret: toBase64Url(master),
      deviceCookie: api.deviceCookie,
    };
    await api.logout().catch(() => undefined);
    return cred;
  } finally {
    wipe(master);
  }
}

/** A signed-in MCP session: derived keys, the unwrapped userKey and a cache of vault keys. */
export class Session {
  readonly api: InkedApi;
  private keys: PasswordKeys | null = null;
  private userKey: CryptoKey | null = null;
  private readonly vaultKeys = new Map<string, CryptoKey>();
  private relogin: Promise<void> | null = null;
  private generation = 0;
  private stale: CredentialStale | null = null;

  constructor(
    private readonly cred: Credential,
    opts: { fetch?: typeof fetch } = {},
  ) {
    this.api = new InkedApi(cred.baseUrl, { deviceCookie: cred.deviceCookie, fetch: opts.fetch });
  }

  get username(): string {
    return this.cred.username;
  }

  get baseUrl(): string {
    return this.cred.baseUrl;
  }

  async start(): Promise<void> {
    if (this.stale) throw this.stale;
    const master = fromBase64Url(this.cred.masterSecret);
    try {
      this.keys = await deriveFromMasterSecret(master);
    } finally {
      wipe(master);
    }
    await this.login();
  }

  private async login(): Promise<void> {
    if (!this.keys) throw new Error('Session not started');
    try {
      const { user, wrappedUserKey } = await this.api.login(this.cred.username, this.keys.authKey);
      if (user.id !== this.cred.userId) throw new CredentialStale();
      this.userKey = await unwrapUserKey(wrappedUserKey, this.keys.passwordKEK, user.id);
      this.vaultKeys.clear();
      this.generation++;
    } catch (e) {
      if (e instanceof CredentialStale) throw this.latch(e);
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) throw this.latch(new CredentialStale());
      if (isCryptoError(e)) throw this.latch(new CredentialStale());
      throw e;
    }
  }

  /** Remembered so later calls fail at once instead of repeating a login the server keeps refusing (lockouts). */
  private latch(e: CredentialStale): CredentialStale {
    this.stale = e;
    return e;
  }

  /** Runs `fn`; after a 401 (session expired or revoked) signs in again once and retries once. */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stale) throw this.stale;
    const seen = this.generation;
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) throw e;
      if (this.stale) throw this.stale;
      // A re-login that finished after this call started already replaced the session: just retry.
      if (this.generation === seen) {
        this.relogin ??= this.login().finally(() => {
          this.relogin = null;
        });
        await this.relogin;
      }
      return fn();
    }
  }

  async vaultKey(vault: VaultDTO): Promise<CryptoKey> {
    const cached = this.vaultKeys.get(vault.id);
    if (cached) return cached;
    if (!this.userKey) throw new Error('Session not started');
    const key = await unwrapVaultKey(vault.wrappedKey, this.userKey, vault.id);
    this.vaultKeys.set(vault.id, key);
    return key;
  }

  async close(): Promise<void> {
    await this.api.logout().catch(() => undefined);
    this.userKey = null;
    this.keys = null;
    this.vaultKeys.clear();
  }
}
