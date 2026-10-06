import { api, ApiError, setUnauthorizedHandler } from '../api/client';
import type { FolderDTO, NoteHeadDTO, User, VaultDTO } from '../api/types';
import {
  aad,
  assertKdfParams,
  CryptoError,
  decryptFolderMeta,
  decryptNoteBody,
  decryptNoteMeta,
  decryptVaultMeta,
  DEFAULT_KDF_PARAMS,
  deriveFromPassword,
  deriveRecoveryKeys,
  encryptFolderMeta,
  encryptNoteBody,
  encryptNoteMeta,
  encryptVaultMeta,
  formatRecoveryKey,
  generateKdfSalt,
  generateRecoveryKey,
  generateUserKey,
  generateVaultKey,
  parseRecoveryKey,
  rewrapUserKey,
  unwrapUserKey,
  unwrapVaultKey,
  wipe,
  type KdfParams,
} from '../crypto';
import { argon2InWorker } from '../lib/argon2Worker';
import { NOTE_TOO_LARGE_MESSAGE, uuid } from '../lib/util';
import { sendPending, type PendingSave } from './pending';

export type Phase = 'booting' | 'offline' | 'setup' | 'signedOut' | 'locked' | 'unlocked';

export interface VaultView {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
  /** Server-side counts; superseded by the loaded tree. */
  noteCount: number;
  activeNoteCount7d: number;
  broken?: boolean;
}

export interface FolderView {
  id: string;
  vaultId: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
  broken?: boolean;
}

export interface NoteView {
  id: string;
  vaultId: string;
  folderId: string | null;
  title: string;
  size: number;
  createdAt: string;
  updatedAt: string;
  broken?: boolean;
}

export interface TreeView {
  status: 'loading' | 'ready' | 'error';
  folders: Record<string, FolderView>;
  notes: Record<string, NoteView>;
}

export interface AppState {
  phase: Phase;
  user: User | null;
  /** Prefill for the unlock screen. */
  lastUsername: string;
  /** One-off message shown after a redirect (e.g. "session ended"). */
  notice: string | null;
  vaultsStatus: 'idle' | 'loading' | 'ready' | 'error';
  vaults: Record<string, VaultView>;
  vaultOrder: string[];
  trees: Record<string, TreeView>;
  /** Decrypted note bodies, for full-text search and backlinks. Memory only. */
  bodies: Record<string, string>;
  bodiesReady: Record<string, boolean>;
  /** Saves waiting in the ciphertext queue. Survives lock (not part of EMPTY_DATA). */
  pendingCount: number;
}

const EMPTY_DATA = {
  vaultsStatus: 'idle' as const,
  vaults: {},
  vaultOrder: [],
  trees: {},
  bodies: {},
  bodiesReady: {},
};

const initialState: AppState = {
  phase: 'booting',
  user: null,
  lastUsername: '',
  notice: null,
  pendingCount: 0,
  ...EMPTY_DATA,
};

const derive = (password: string, salt: string, params: KdfParams) =>
  deriveFromPassword(password, salt, params, { argon2: argon2InWorker });

export class LockedError extends Error {
  constructor() {
    super('Vault is locked');
  }
}

/** Maximum length of an encrypted note body (`encBody` characters); the server refuses anything bigger. */
export const NOTE_BODY_LIMIT = 2_000_000;

export class NoteTooLargeError extends Error {
  constructor() {
    super(NOTE_TOO_LARGE_MESSAGE);
    this.name = 'NoteTooLargeError';
  }
}

const PENDING_RETRY_MS = 30_000;

/** A save of the same note still on the wire when its text was queued, and whether it carries that same text. */
export interface RacingSave {
  save: Promise<{ updatedAt: string }>;
  sameText: boolean;
}

interface QueueEntry {
  item: PendingSave;
  /** The account whose session may send it. */
  owner: string | null;
  /** Waiting for a racing save to settle; not sent meanwhile. */
  held: boolean;
  /** Plaintext title of the copy, for the notice only; dropped with the keys. */
  copyTitle: string | null;
}

const LAST_USER_KEY = 'inked.lastUsername';
function rememberUsername(name: string) {
  try {
    localStorage.setItem(LAST_USER_KEY, name);
  } catch {
    /* ignore */
  }
}
function recallUsername(): string {
  try {
    return localStorage.getItem(LAST_USER_KEY) ?? '';
  } catch {
    return '';
  }
}
function forgetRememberedUsername() {
  try {
    localStorage.removeItem(LAST_USER_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Holds the session, the unwrapped keys (private fields, never in React state or storage)
 * and all decrypted data. Locking drops every key and every decrypted value.
 */
export class AppStore {
  private state: AppState = initialState;
  private listeners = new Set<() => void>();
  private userKey: CryptoKey | null = null;
  private vaultKeys = new Map<string, CryptoKey>();
  /** Bumped on every lock/unlock so late async results from an old session are dropped. */
  private epoch = 0;
  private flushers = new Set<(final: boolean) => Promise<void>>();
  /** `updatedAt` values returned to this tab's own writes, per note. Lets the editor tell its saves from others'. */
  private ownStamps = new Map<string, Set<string>>();
  /** Edits that could not be saved yet, as ciphertext. Memory only: a reload loses them (beforeunload warns). */
  private pending: QueueEntry[] = [];
  private retryRun: Promise<void> | null = null;
  private retryAgain = false;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  /** Editor flushes in progress (see trackSettle). */
  private settling = 0;

  constructor() {
    setUnauthorizedHandler(() => this.sessionEnded());
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        if (this.state.phase === 'unlocked') void this.retryPending();
      });
      window.addEventListener('beforeunload', (e) => {
        if (this.hasUnsavedWork()) e.preventDefault();
      });
    }
  }

  getState = (): AppState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(update: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
    const patch = typeof update === 'function' ? update(this.state) : update;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  clearNotice() {
    if (this.state.notice) this.set({ notice: null });
  }

  setNotice(notice: string | null) {
    this.set({ notice });
  }

  // ---- Session ---------------------------------------------------------------------------

  async boot(): Promise<void> {
    this.set({ phase: 'booting' });
    try {
      const { needsSetup } = await api.status();
      if (needsSetup) {
        this.set({ phase: 'setup' });
        return;
      }
      try {
        const { user } = await api.me();
        this.set({ phase: 'locked', user, lastUsername: user.username });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          this.set({ phase: 'signedOut', user: null, lastUsername: recallUsername() });
        } else throw e;
      }
    } catch {
      this.set({ phase: 'offline' });
    }
  }

  /** Signs in (or re-unlocks an existing session) with username + password. */
  async unlock(username: string, password: string): Promise<void> {
    const { kdfSalt, kdfParams } = await api.params(username);
    const params = assertKdfParams(kdfParams);
    const { authKey, passwordKEK } = await derive(password, kdfSalt, params);
    const { user, wrappedUserKey } = await api.login(username, authKey);
    const userKey = await unwrapUserKey(wrappedUserKey, passwordKEK, user.id);
    this.enterUnlocked(user, userKey);
    void this.loadAll();
  }

  private enterUnlocked(user: User, userKey: CryptoKey) {
    this.epoch++;
    this.userKey = userKey;
    this.vaultKeys.clear();
    this.ownStamps.clear();
    rememberUsername(user.username);
    this.set({ phase: 'unlocked', user, lastUsername: user.username, notice: null, ...EMPTY_DATA });
    void this.retryPending();
  }

  private dropKeys() {
    this.epoch++;
    this.userKey = null;
    this.vaultKeys.clear();
    this.ownStamps.clear();
    for (const e of this.pending) e.copyTitle = null;
  }

  /** `final` is true when the keys are about to be dropped (lock, sign out); each flusher bounds its own wait. */
  registerFlusher(fn: (final: boolean) => Promise<void>): () => void {
    this.flushers.add(fn);
    return () => this.flushers.delete(fn);
  }

  private async flushAll(final = false): Promise<void> {
    if (!this.flushers.size) return;
    await Promise.allSettled([...this.flushers].map((f) => f(final)));
  }

  /** Drops keys + decrypted data and ends the server session; only the username is remembered. */
  async lock(notice: string | null = null): Promise<void> {
    if (this.state.phase !== 'unlocked') return;
    await this.flushAll(true);
    const lastUsername = this.state.user?.username ?? this.state.lastUsername;
    this.dropKeys();
    rememberUsername(lastUsername);
    this.set({ phase: 'signedOut', user: null, lastUsername, notice, ...EMPTY_DATA });
    try {
      await api.logout();
    } catch {
      // Keys are gone either way.
    }
  }

  /** "Not you?" on the unlock screen when there is no session: forget the remembered username. */
  forgetUsername() {
    forgetRememberedUsername();
    this.set({ lastUsername: '' });
  }

  async signOut(): Promise<void> {
    await this.flushAll(true);
    this.dropKeys();
    forgetRememberedUsername();
    this.set({ phase: 'signedOut', user: null, lastUsername: '', notice: null, ...EMPTY_DATA });
    try {
      await api.logout();
    } catch {
      // Keys are gone either way; a stale cookie only lets someone see the locked screen.
    }
  }

  private sessionEnded() {
    if (this.state.phase === 'signedOut' || this.state.phase === 'setup') return;
    this.dropKeys();
    this.set({ phase: 'signedOut', user: null, notice: 'Your session ended. Sign in again.', ...EMPTY_DATA });
  }

  // ---- Registration, recovery, password ---------------------------------------------------

  /** Creates an account (first admin via /api/setup, or via invite). Returns the formatted recovery key. */
  async register(opts: {
    username: string;
    password: string;
    inviteToken?: string;
    setupToken?: string;
  }): Promise<string> {
    const userId = uuid();
    const kdfSalt = generateKdfSalt();
    const kdfParams: KdfParams = { ...DEFAULT_KDF_PARAMS };
    const pw = await derive(opts.password, kdfSalt, kdfParams);
    const rkBytes = generateRecoveryKey();
    const recoveryKeyText = formatRecoveryKey(rkBytes);
    const rk = await deriveRecoveryKeys(rkBytes);
    wipe(rkBytes);
    const uk = await generateUserKey(userId, pw.passwordKEK, rk.recoveryKEK);
    const body = {
      userId,
      username: opts.username,
      kdfSalt,
      kdfParams,
      authKey: pw.authKey,
      wrappedUserKey: uk.wrappedUserKey,
      recoveryAuth: rk.recoveryAuth,
      wrappedUserKeyRecovery: uk.wrappedUserKeyRecovery,
    };
    const { user } = opts.inviteToken
      ? await api.register({ ...body, inviteToken: opts.inviteToken })
      : await api.setup({ ...body, setupToken: opts.setupToken ?? '' });
    if (user.id !== userId) throw new Error('Server returned an unexpected user id');
    this.enterUnlocked(user, uk.userKey);
    this.set({ vaultsStatus: 'ready' });
    try {
      await this.createVault('Personal', '#45A89E');
    } catch {
      // Not fatal; the user can create a vault from the sidebar.
    }
    return recoveryKeyText;
  }

  async recover(username: string, recoveryKeyText: string, newPassword: string): Promise<void> {
    const rkBytes = parseRecoveryKey(recoveryKeyText);
    const rk = await deriveRecoveryKeys(rkBytes);
    wipe(rkBytes);
    const { userId, wrappedUserKeyRecovery } = await api.recoverStart(username, rk.recoveryAuth);
    const kdfSalt = generateKdfSalt();
    const kdfParams: KdfParams = { ...DEFAULT_KDF_PARAMS };
    const pw = await derive(newPassword, kdfSalt, kdfParams);
    const wrappedUserKey = await rewrapUserKey(
      wrappedUserKeyRecovery,
      { kek: rk.recoveryKEK, aad: aad.userKeyRecovery(userId) },
      { kek: pw.passwordKEK, aad: aad.userKey(userId) },
    );
    const res = await api.recoverFinish({
      username,
      recoveryAuth: rk.recoveryAuth,
      kdfSalt,
      kdfParams,
      authKey: pw.authKey,
      wrappedUserKey,
    });
    const userKey = await unwrapUserKey(res.wrappedUserKey, pw.passwordKEK, res.user.id);
    this.enterUnlocked(res.user, userKey);
    void this.loadAll();
  }

  /**
   * Replaces the recovery key: the same userKey is re-wrapped under a fresh recovery key and the
   * server swaps the recovery proof, so the old key stops working. Returns the new key (shown once).
   * Throws CryptoError('unwrap') for a wrong password.
   */
  async rotateRecoveryKey(password: string): Promise<string> {
    const user = this.state.user;
    if (!user || !this.userKey) throw new LockedError();
    const { kdfSalt, kdfParams } = await api.params(user.username);
    const pw = await derive(password, kdfSalt, assertKdfParams(kdfParams));
    const { wrappedUserKey } = await api.me();
    const rkBytes = generateRecoveryKey();
    const text = formatRecoveryKey(rkBytes);
    const rk = await deriveRecoveryKeys(rkBytes);
    wipe(rkBytes);
    // Re-wrap the same userKey under the new recovery KEK (throws CryptoError('unwrap') on a wrong password).
    const wrappedUserKeyRecovery = await rewrapUserKey(
      wrappedUserKey,
      { kek: pw.passwordKEK, aad: aad.userKey(user.id) },
      { kek: rk.recoveryKEK, aad: aad.userKeyRecovery(user.id) },
    );
    await api.rotateRecoveryKey({ currentAuthKey: pw.authKey, recoveryAuth: rk.recoveryAuth, wrappedUserKeyRecovery });
    return text;
  }

  /** Re-wraps only the userKey. Throws CryptoError('unwrap') for a wrong current password. */
  async changePassword(current: string, next: string): Promise<void> {
    const user = this.state.user;
    if (!user || !this.userKey) throw new LockedError();
    const { kdfSalt, kdfParams } = await api.params(user.username);
    const old = await derive(current, kdfSalt, assertKdfParams(kdfParams));
    const { wrappedUserKey } = await api.me();
    const newSalt = generateKdfSalt();
    const newParams: KdfParams = { ...DEFAULT_KDF_PARAMS };
    const nw = await derive(next, newSalt, newParams);
    const rewrapped = await rewrapUserKey(
      wrappedUserKey,
      { kek: old.passwordKEK, aad: aad.userKey(user.id) },
      { kek: nw.passwordKEK, aad: aad.userKey(user.id) },
    );
    await api.changePassword({
      currentAuthKey: old.authKey,
      kdfSalt: newSalt,
      kdfParams: newParams,
      authKey: nw.authKey,
      wrappedUserKey: rewrapped,
    });
  }

  // ---- Loading -----------------------------------------------------------------------------

  private requireUserKey(): CryptoKey {
    if (!this.userKey) throw new LockedError();
    return this.userKey;
  }

  private vaultKey(vaultId: string): CryptoKey {
    const k = this.vaultKeys.get(vaultId);
    if (!k) throw new LockedError();
    return k;
  }

  async loadAll(): Promise<void> {
    const ep = this.epoch;
    await this.loadVaults();
    if (ep !== this.epoch) return;
    const ids = this.state.vaultOrder.filter((id) => !this.state.vaults[id]?.broken);
    await Promise.all(ids.map((id) => this.loadTree(id)));
    // Bodies are only needed for full-text search and backlinks: fetch them in the background.
    for (const id of ids) {
      if (ep !== this.epoch) return;
      await this.loadBodies(id).catch(() => undefined);
    }
  }

  async loadVaults(): Promise<void> {
    const ep = this.epoch;
    const userKey = this.requireUserKey();
    this.set({ vaultsStatus: 'loading' });
    try {
      const { vaults } = await api.listVaults();
      const views = await Promise.all(vaults.map((v) => this.openVault(v, userKey)));
      if (ep !== this.epoch) return;
      const map: Record<string, VaultView> = {};
      for (const v of views) map[v.id] = v;
      const order = views
        .slice()
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.name.localeCompare(b.name))
        .map((v) => v.id);
      this.set({ vaults: map, vaultOrder: order, vaultsStatus: 'ready' });
    } catch (e) {
      if (ep === this.epoch) this.set({ vaultsStatus: 'error' });
      throw e;
    }
  }

  private async openVault(v: VaultDTO, userKey: CryptoKey): Promise<VaultView> {
    const base = {
      id: v.id,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
      noteCount: v.noteCount,
      activeNoteCount7d: v.activeNoteCount7d,
    };
    try {
      const key = await unwrapVaultKey(v.wrappedKey, userKey, v.id);
      this.vaultKeys.set(v.id, key);
      const meta = await decryptVaultMeta(key, v.id, v.encMeta);
      return { ...base, name: meta.name, color: meta.color };
    } catch {
      return { ...base, name: 'Unreadable vault', color: '#6E6880', broken: true };
    }
  }

  async loadTree(vaultId: string): Promise<void> {
    const ep = this.epoch;
    const key = this.vaultKey(vaultId);
    this.set((s) => ({
      trees: { ...s.trees, [vaultId]: { ...(s.trees[vaultId] ?? { folders: {}, notes: {} }), status: 'loading' } },
    }));
    try {
      const { folders, notes } = await api.tree(vaultId);
      const fViews = await Promise.all(folders.map((f) => this.openFolder(key, vaultId, f)));
      const nViews = await Promise.all(notes.map((n) => this.openNoteHead(key, vaultId, n)));
      if (ep !== this.epoch) return;
      const tree: TreeView = { status: 'ready', folders: {}, notes: {} };
      for (const f of fViews) tree.folders[f.id] = f;
      for (const n of nViews) tree.notes[n.id] = n;
      this.set((s) => ({ trees: { ...s.trees, [vaultId]: tree } }));
    } catch (e) {
      if (ep === this.epoch) {
        this.set((s) => ({
          trees: { ...s.trees, [vaultId]: { ...(s.trees[vaultId] ?? { folders: {}, notes: {} }), status: 'error' } },
        }));
      }
      throw e;
    }
  }

  private async openFolder(key: CryptoKey, vaultId: string, f: FolderDTO): Promise<FolderView> {
    const base = { id: f.id, vaultId, parentId: f.parentId, createdAt: f.createdAt, updatedAt: f.updatedAt };
    try {
      const meta = await decryptFolderMeta(key, vaultId, f.id, f.encMeta);
      return { ...base, name: meta.name };
    } catch {
      return { ...base, name: 'Unreadable folder', broken: true };
    }
  }

  private async openNoteHead(key: CryptoKey, vaultId: string, n: NoteHeadDTO): Promise<NoteView> {
    const base = {
      id: n.id,
      vaultId,
      folderId: n.folderId,
      size: n.size,
      createdAt: n.createdAt,
      updatedAt: n.updatedAt,
    };
    try {
      const meta = await decryptNoteMeta(key, vaultId, n.id, n.encMeta);
      return { ...base, title: meta.title };
    } catch {
      return { ...base, title: 'Unreadable note', broken: true };
    }
  }

  async loadBodies(vaultId: string): Promise<void> {
    const ep = this.epoch;
    const key = this.vaultKey(vaultId);
    const { notes } = await api.bodies(vaultId);
    const out: Record<string, string> = {};
    await Promise.all(
      notes.map(async (n) => {
        try {
          out[n.id] = await decryptNoteBody(key, vaultId, n.id, n.encBody);
        } catch {
          // Unreadable bodies are simply not searchable.
        }
      }),
    );
    if (ep !== this.epoch) return;
    // Bodies loaded or saved locally in the meantime are newer; keep them.
    this.set((s) => ({ bodies: { ...out, ...s.bodies }, bodiesReady: { ...s.bodiesReady, [vaultId]: true } }));
  }

  // ---- Vault mutations -----------------------------------------------------------------------

  async createVault(name: string, color: string): Promise<VaultView> {
    const ep = this.epoch;
    const userKey = this.requireUserKey();
    const id = uuid();
    const { vaultKey, wrappedKey } = await generateVaultKey(id, userKey);
    const encMeta = await encryptVaultMeta(vaultKey, id, { name, color });
    const { vault } = await api.createVault({ id, encMeta, wrappedKey });
    if (ep !== this.epoch) throw new LockedError();
    this.vaultKeys.set(id, vaultKey);
    const view: VaultView = {
      id,
      name,
      color,
      createdAt: vault.createdAt,
      updatedAt: vault.updatedAt,
      noteCount: 0,
      activeNoteCount7d: 0,
    };
    this.set((s) => ({
      vaults: { ...s.vaults, [id]: view },
      vaultOrder: [...s.vaultOrder, id],
      trees: { ...s.trees, [id]: { status: 'ready', folders: {}, notes: {} } },
      bodiesReady: { ...s.bodiesReady, [id]: true },
    }));
    return view;
  }

  async updateVault(id: string, meta: { name: string; color: string }): Promise<void> {
    const encMeta = await encryptVaultMeta(this.vaultKey(id), id, meta);
    const { vault } = await api.updateVault(id, encMeta);
    this.set((s) => ({
      vaults: { ...s.vaults, [id]: { ...s.vaults[id], ...meta, updatedAt: vault.updatedAt } },
    }));
  }

  async deleteVault(id: string): Promise<void> {
    await api.deleteVault(id);
    this.vaultKeys.delete(id);
    this.set((s) => {
      const vaults = { ...s.vaults };
      delete vaults[id];
      const trees = { ...s.trees };
      const noteIds = Object.keys(trees[id]?.notes ?? {});
      delete trees[id];
      const bodies = { ...s.bodies };
      for (const n of noteIds) delete bodies[n];
      return { vaults, trees, bodies, vaultOrder: s.vaultOrder.filter((v) => v !== id) };
    });
  }

  // ---- Folder mutations ----------------------------------------------------------------------

  private patchTree(vaultId: string, fn: (t: TreeView) => Partial<TreeView>) {
    this.set((s) => {
      const t = s.trees[vaultId];
      if (!t) return {};
      return { trees: { ...s.trees, [vaultId]: { ...t, ...fn(t) } } };
    });
  }

  async createFolder(vaultId: string, parentId: string | null, name: string): Promise<FolderView> {
    const id = uuid();
    const encMeta = await encryptFolderMeta(this.vaultKey(vaultId), vaultId, id, { name });
    const { folder } = await api.createFolder(vaultId, { id, parentId, encMeta });
    const view: FolderView = { id, vaultId, parentId, name, createdAt: folder.createdAt, updatedAt: folder.updatedAt };
    this.patchTree(vaultId, (t) => ({ folders: { ...t.folders, [id]: view } }));
    return view;
  }

  async renameFolder(vaultId: string, folderId: string, name: string): Promise<void> {
    const encMeta = await encryptFolderMeta(this.vaultKey(vaultId), vaultId, folderId, { name });
    const { folder } = await api.updateFolder(folderId, { encMeta });
    this.patchTree(vaultId, (t) => ({
      folders: { ...t.folders, [folderId]: { ...t.folders[folderId], name, broken: false, updatedAt: folder.updatedAt } },
    }));
  }

  async moveFolder(vaultId: string, folderId: string, parentId: string | null): Promise<void> {
    const { folder } = await api.updateFolder(folderId, { parentId });
    this.patchTree(vaultId, (t) => ({
      folders: { ...t.folders, [folderId]: { ...t.folders[folderId], parentId, updatedAt: folder.updatedAt } },
    }));
  }

  async deleteFolder(vaultId: string, folderId: string): Promise<void> {
    await api.deleteFolder(folderId);
    const tree = this.state.trees[vaultId];
    if (!tree) return;
    const doomed = new Set([folderId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of Object.values(tree.folders)) {
        if (f.parentId && doomed.has(f.parentId) && !doomed.has(f.id)) {
          doomed.add(f.id);
          grew = true;
        }
      }
    }
    const goneNotes = Object.values(tree.notes).filter((n) => n.folderId && doomed.has(n.folderId));
    this.set((s) => {
      const t = s.trees[vaultId];
      const folders = { ...t.folders };
      for (const id of doomed) delete folders[id];
      const notes = { ...t.notes };
      const bodies = { ...s.bodies };
      for (const n of goneNotes) {
        delete notes[n.id];
        delete bodies[n.id];
      }
      return { trees: { ...s.trees, [vaultId]: { ...t, folders, notes } }, bodies };
    });
  }

  // ---- Note mutations ----------------------------------------------------------------------

  /** Stores a note head; a late response never moves `updatedAt` backwards. */
  private putHead(vaultId: string, head: NoteView) {
    this.patchTree(vaultId, (t) => {
      const prev = t.notes[head.id];
      const next = prev && prev.updatedAt > head.updatedAt ? { ...head, updatedAt: prev.updatedAt } : head;
      return { notes: { ...t.notes, [head.id]: next } };
    });
  }

  private markOwn(noteId: string, updatedAt: string) {
    let set = this.ownStamps.get(noteId);
    if (!set) this.ownStamps.set(noteId, (set = new Set()));
    set.add(updatedAt);
  }

  /** True only for `updatedAt` values returned by this tab's own create/save/rename/move calls. */
  isOwnStamp(noteId: string, updatedAt: string): boolean {
    return this.ownStamps.get(noteId)?.has(updatedAt) ?? false;
  }

  async createNote(vaultId: string, folderId: string | null, title: string, body = ''): Promise<NoteView> {
    const ep = this.epoch;
    const key = this.vaultKey(vaultId);
    const id = uuid();
    const encMeta = await encryptNoteMeta(key, vaultId, id, { title });
    const encBody = await encryptNoteBody(key, vaultId, id, body);
    const { note } = await api.createNote(vaultId, { id, folderId, encMeta, encBody });
    if (ep !== this.epoch) throw new LockedError();
    this.markOwn(id, note.updatedAt);
    const head: NoteView = {
      id,
      vaultId,
      folderId,
      title,
      size: note.size,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    };
    this.putHead(vaultId, head);
    this.set((s) => ({ bodies: { ...s.bodies, [id]: body } }));
    return head;
  }

  /** Fetches and decrypts a note. The vault id comes from the URL and is bound by the AAD. */
  async loadNote(vaultId: string, noteId: string): Promise<{ head: NoteView; body: string }> {
    const ep = this.epoch;
    const key = this.vaultKey(vaultId);
    const { note } = await api.getNote(noteId);
    if (ep !== this.epoch) throw new LockedError();
    const meta = await decryptNoteMeta(key, vaultId, noteId, note.encMeta);
    const body = await decryptNoteBody(key, vaultId, noteId, note.encBody);
    if (ep !== this.epoch) throw new LockedError();
    const head: NoteView = {
      id: noteId,
      vaultId,
      folderId: note.folderId,
      title: meta.title,
      size: note.size,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    };
    this.putHead(vaultId, head);
    this.set((s) => ({ bodies: { ...s.bodies, [noteId]: body } }));
    return { head, body };
  }

  /** Saves a body. With `baseUpdatedAt` the server answers 409 if someone saved in between. */
  async saveNoteBody(vaultId: string, noteId: string, body: string, baseUpdatedAt?: string): Promise<NoteView> {
    const ep = this.epoch;
    const encBody = await encryptNoteBody(this.vaultKey(vaultId), vaultId, noteId, body);
    if (encBody.length > NOTE_BODY_LIMIT) throw new NoteTooLargeError();
    const { note } = await api.updateNote(noteId, { encBody, baseUpdatedAt });
    const prev = this.state.trees[vaultId]?.notes[noteId];
    const head: NoteView = {
      id: noteId,
      vaultId,
      folderId: note.folderId,
      title: prev?.title ?? '',
      size: note.size,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      broken: prev?.broken,
    };
    // Locked while saving: the save landed, but this session's state is gone.
    if (ep !== this.epoch) return head;
    this.markOwn(noteId, note.updatedAt);
    this.putHead(vaultId, head);
    this.set((s) => ({ bodies: { ...s.bodies, [noteId]: body } }));
    return head;
  }

  async renameNote(vaultId: string, noteId: string, title: string): Promise<NoteView> {
    const ep = this.epoch;
    const encMeta = await encryptNoteMeta(this.vaultKey(vaultId), vaultId, noteId, { title });
    const { note } = await api.updateNote(noteId, { encMeta });
    if (ep !== this.epoch) throw new LockedError();
    this.markOwn(noteId, note.updatedAt);
    const prev = this.state.trees[vaultId]?.notes[noteId];
    const head: NoteView = { ...(prev as NoteView), id: noteId, vaultId, title, broken: false, updatedAt: note.updatedAt, size: note.size, folderId: note.folderId };
    this.putHead(vaultId, head);
    return head;
  }

  async moveNote(vaultId: string, noteId: string, folderId: string | null): Promise<NoteView> {
    const ep = this.epoch;
    const { note } = await api.updateNote(noteId, { folderId });
    if (ep !== this.epoch) throw new LockedError();
    this.markOwn(noteId, note.updatedAt);
    const prev = this.state.trees[vaultId]?.notes[noteId];
    const head: NoteView = { ...(prev as NoteView), folderId: note.folderId, updatedAt: note.updatedAt };
    this.putHead(vaultId, head);
    return head;
  }

  async deleteNote(vaultId: string, noteId: string): Promise<void> {
    await api.deleteNote(noteId);
    this.set((s) => {
      const t = s.trees[vaultId];
      const bodies = { ...s.bodies };
      delete bodies[noteId];
      if (!t) return { bodies };
      const notes = { ...t.notes };
      delete notes[noteId];
      return { trees: { ...s.trees, [vaultId]: { ...t, notes } }, bodies };
    });
  }

  // ---- Pending-save queue --------------------------------------------------------------------

  /**
   * Queues text that could not be saved. While the keys are here it is encrypted for the note and
   * for a fresh "(unsaved copy)" note in the same folder, so the queue never needs keys again.
   * `racing`: a save of this note still on the wire. The item waits for it, then is dropped (that
   * save carried the same text) or rebased onto it. `until` bounds the wait for the first send.
   */
  async stashUnsaved(
    vaultId: string,
    noteId: string,
    body: string,
    baseUpdatedAt?: string,
    opts: { racing?: RacingSave; until?: Promise<unknown> } = {},
  ): Promise<void> {
    const ep = this.epoch;
    const key = this.vaultKey(vaultId);
    const owner = this.state.user?.id ?? null;
    const head = this.state.trees[vaultId]?.notes[noteId];
    const copyId = uuid();
    const copyTitle = `${head?.title || 'Untitled'} (unsaved copy)`;
    const encBody = await encryptNoteBody(key, vaultId, noteId, body);
    if (encBody.length > NOTE_BODY_LIMIT) throw new NoteTooLargeError();
    const item: PendingSave = {
      noteId,
      vaultId,
      encBody,
      baseUpdatedAt,
      attempts: 0,
      copy: {
        id: copyId,
        folderId: head?.folderId ?? null,
        encMeta: await encryptNoteMeta(key, vaultId, copyId, { title: copyTitle }),
        encBody: await encryptNoteBody(key, vaultId, copyId, body),
      },
    };
    const entry: QueueEntry = { item, owner, held: !!opts.racing, copyTitle: ep === this.epoch ? copyTitle : null };
    this.pending.push(entry);
    this.set({ pendingCount: this.pending.length });
    if (opts.racing) {
      const { save, sameText } = opts.racing;
      save
        .then(
          (h) => {
            if (sameText) this.removeEntry(entry);
            else item.baseUpdatedAt = h.updatedAt;
          },
          () => undefined,
        )
        .finally(() => {
          entry.held = false;
          if (this.pending.includes(entry)) void this.retryPending();
        });
    }
    this.ensureRetryLoop();
    const sent = this.retryPending();
    await (opts.until ? Promise.race([sent, opts.until]) : sent);
  }

  /** Sends every queued save (ciphertext, no keys needed). A call during a run waits for a fresh pass. */
  retryPending(): Promise<void> {
    if (this.retryRun) {
      this.retryAgain = true;
      return this.retryRun;
    }
    const run = (async () => {
      try {
        do {
          this.retryAgain = false;
          await this.sendQueued();
        } while (this.retryAgain);
      } finally {
        this.retryRun = null;
      }
    })();
    this.retryRun = run;
    return run;
  }

  private async sendQueued(): Promise<void> {
    if (!this.pending.length) return;
    const userId = this.state.user?.id ?? null;
    const copied: QueueEntry[] = [];
    let dropped = 0;
    for (const entry of [...this.pending]) {
      if (entry.held || !this.pending.includes(entry)) continue;
      // Never send one account's edits with another account's session.
      if (entry.owner && userId && entry.owner !== userId) continue;
      const out = await sendPending(entry.item, { updateNote: api.updateNote, createNote: api.createNote });
      if (out === 'retry') {
        entry.item.attempts++;
        continue;
      }
      // Remove by identity: entries stashed during this pass stay queued.
      this.pending = this.pending.filter((e) => e !== entry);
      if (out === 'copied') copied.push(entry);
      if (out === 'dropped') dropped++;
    }
    this.syncPendingCount();
    const notices: string[] = [];
    if (copied.length) {
      const title = copied.length === 1 ? copied[0].copyTitle : null;
      notices.push(
        title
          ? `Saved your changes as “${title}” because the note changed elsewhere.`
          : copied.length === 1
            ? 'A note changed elsewhere while you were editing, so your version was saved as an “(unsaved copy)” note next to it.'
            : `${copied.length} notes changed elsewhere; your versions were saved as “(unsaved copy)” notes.`,
      );
    }
    if (dropped) {
      notices.push(
        dropped === 1
          ? 'An unsaved change couldn’t be kept because its note or vault was deleted elsewhere.'
          : 'Some unsaved changes couldn’t be kept because their note or vault was deleted elsewhere.',
      );
    }
    if (notices.length) this.set({ notice: notices.join(' ') });
    if (copied.length && this.state.phase === 'unlocked') void this.loadAll().catch(() => undefined);
  }

  /** True while edits exist only in this tab: queued, or still being flushed by a closed editor. */
  hasUnsavedWork(): boolean {
    return this.pending.length > 0 || this.settling > 0;
  }

  /** Counts an editor flush as unsaved work until it finishes, so closing the tab meanwhile prompts. */
  trackSettle(p: Promise<void>): Promise<void> {
    this.settling++;
    return p.finally(() => {
      this.settling--;
    });
  }

  private removeEntry(entry: QueueEntry) {
    this.pending = this.pending.filter((e) => e !== entry);
    this.syncPendingCount();
  }

  private syncPendingCount() {
    if (this.state.pendingCount !== this.pending.length) this.set({ pendingCount: this.pending.length });
    if (!this.pending.length && this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private ensureRetryLoop() {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      if (this.state.phase === 'unlocked') void this.retryPending();
    }, PENDING_RETRY_MS);
  }
}

export { CryptoError };
