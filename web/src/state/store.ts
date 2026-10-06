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
import { uuid } from '../lib/util';

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
  ...EMPTY_DATA,
};

const derive = (password: string, salt: string, params: KdfParams) =>
  deriveFromPassword(password, salt, params, { argon2: argon2InWorker });

export class LockedError extends Error {
  constructor() {
    super('Vault is locked');
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
  private flushers = new Set<() => Promise<void>>();

  constructor() {
    setUnauthorizedHandler(() => this.sessionEnded());
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
        if (e instanceof ApiError && e.status === 401) this.set({ phase: 'signedOut', user: null });
        else throw e;
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
    this.set({ phase: 'unlocked', user, lastUsername: user.username, notice: null, ...EMPTY_DATA });
  }

  private dropKeys() {
    this.epoch++;
    this.userKey = null;
    this.vaultKeys.clear();
  }

  registerFlusher(fn: () => Promise<void>): () => void {
    this.flushers.add(fn);
    return () => this.flushers.delete(fn);
  }

  private async flushAll(): Promise<void> {
    if (!this.flushers.size) return;
    const all = Promise.allSettled([...this.flushers].map((f) => f()));
    await Promise.race([all, new Promise((r) => setTimeout(r, 4000))]);
  }

  /** Drops keys and decrypted data; the session cookie stays so only the password is needed. */
  async lock(notice: string | null = null): Promise<void> {
    if (this.state.phase !== 'unlocked') return;
    await this.flushAll();
    this.dropKeys();
    this.set({ phase: 'locked', notice, ...EMPTY_DATA });
  }

  async signOut(): Promise<void> {
    await this.flushAll();
    this.dropKeys();
    this.set({ phase: 'signedOut', user: null, notice: null, ...EMPTY_DATA });
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
  async register(opts: { username: string; password: string; inviteToken?: string }): Promise<string> {
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
      : await api.setup(body);
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
    this.set({ notice: 'Password reset. Your recovery key still works; keep it safe.' });
    void this.loadAll();
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

  private putHead(vaultId: string, head: NoteView) {
    this.patchTree(vaultId, (t) => ({ notes: { ...t.notes, [head.id]: head } }));
  }

  async createNote(vaultId: string, folderId: string | null, title: string, body = ''): Promise<NoteView> {
    const key = this.vaultKey(vaultId);
    const id = uuid();
    const encMeta = await encryptNoteMeta(key, vaultId, id, { title });
    const encBody = await encryptNoteBody(key, vaultId, id, body);
    const { note } = await api.createNote(vaultId, { id, folderId, encMeta, encBody });
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
    const key = this.vaultKey(vaultId);
    const { note } = await api.getNote(noteId);
    const meta = await decryptNoteMeta(key, vaultId, noteId, note.encMeta);
    const body = await decryptNoteBody(key, vaultId, noteId, note.encBody);
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
    const encBody = await encryptNoteBody(this.vaultKey(vaultId), vaultId, noteId, body);
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
    this.putHead(vaultId, head);
    this.set((s) => ({ bodies: { ...s.bodies, [noteId]: body } }));
    return head;
  }

  async renameNote(vaultId: string, noteId: string, title: string): Promise<NoteView> {
    const encMeta = await encryptNoteMeta(this.vaultKey(vaultId), vaultId, noteId, { title });
    const { note } = await api.updateNote(noteId, { encMeta });
    const prev = this.state.trees[vaultId]?.notes[noteId];
    const head: NoteView = { ...(prev as NoteView), id: noteId, vaultId, title, broken: false, updatedAt: note.updatedAt, size: note.size, folderId: note.folderId };
    this.putHead(vaultId, head);
    return head;
  }

  async moveNote(vaultId: string, noteId: string, folderId: string | null): Promise<NoteView> {
    const { note } = await api.updateNote(noteId, { folderId });
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
}

export { CryptoError };
