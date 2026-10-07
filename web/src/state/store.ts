import { api, ApiError, setRequestUser, setUnauthorizedHandler, setUserMismatchHandler } from '../api/client';
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
import { INDEX_TITLE, indexBody } from '../lib/indexNote';
import { NOTE_TOO_LARGE_MESSAGE, uuid } from '../lib/util';
import { sendPending, type DropReason, type PendingSave } from './pending';
import { TabLink } from './tabs';

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
  /** This account's saves waiting in the ciphertext queue (see syncPendingCount). Survives lock (not part of EMPTY_DATA). */
  pendingCount: number;
  /** A lock, sign-out or session end is flushing edits before the keys go: editing is paused. */
  locking: boolean;
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
  locking: false,
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

/** A queued send (or the save it waits for) that takes longer than this is given up and retried later. */
export const QUEUE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Settles like `p`, or fails with the network error (retried later) after QUEUE_REQUEST_TIMEOUT_MS.
 * Raced as well as aborted (see QUEUE_IO), so even a request that ignores its abort cannot hold the queue.
 */
function bounded<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ApiError(0, 'network')), QUEUE_REQUEST_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * How queued saves reach the server: ciphertext only, every request bounded, and each one naming
 * the item's owner (X-Inked-User) so another account's session refuses it instead of answering 404.
 */
const QUEUE_IO = {
  updateNote: (owner: string, id: string, b: { encBody: string; baseUpdatedAt?: string }) =>
    bounded(api.updateNote(id, b, { timeoutMs: QUEUE_REQUEST_TIMEOUT_MS, asUser: owner })),
  createNote: (owner: string, vaultId: string, b: PendingSave['copy']) =>
    bounded(api.createNote(vaultId, b, { timeoutMs: QUEUE_REQUEST_TIMEOUT_MS, asUser: owner })),
  getNote: (owner: string, id: string) => bounded(api.getNote(id, { timeoutMs: QUEUE_REQUEST_TIMEOUT_MS, asUser: owner })),
};

const SESSION_ENDED_NOTICE = 'Your session ended. Sign in again.';
const USER_MISMATCH_NOTICE = 'You signed in as someone else in another tab. Sign in again here.';

const DROP_NOTICES: Record<DropReason, [one: string, many: string]> = {
  deleted: [
    'An unsaved change couldn’t be kept because its note or vault was deleted elsewhere.',
    'Some unsaved changes couldn’t be kept because their note or vault was deleted elsewhere.',
  ],
  rejected: [
    'An unsaved change was rejected by the server and couldn’t be saved.',
    'Some unsaved changes were rejected by the server and couldn’t be saved.',
  ],
  too_large: ['An unsaved change was too large to save.', 'Some unsaved changes were too large to save.'],
};

/**
 * What one pass of the queue tells the user. `copies` holds each copy's title, or null where the
 * title must not be shown (keys gone or going).
 */
function queueNotice(copies: (string | null)[], atRoot: number, dropped: Record<DropReason, number>): string | null {
  const out: string[] = [];
  if (copies.length) {
    const title = copies.length === 1 ? copies[0] : null;
    out.push(
      title
        ? `Saved your changes as “${title}” because the note changed elsewhere.`
        : copies.length === 1
          ? 'A note changed elsewhere while you were editing, so your version was saved as an “(unsaved copy)” note next to it.'
          : `${copies.length} notes changed elsewhere; your versions were saved as “(unsaved copy)” notes.`,
    );
  }
  if (atRoot) {
    out.push(
      atRoot === 1
        ? 'Your changes to a note were saved as an “(unsaved copy)” note at the top of the vault because its folder was deleted.'
        : `Your changes to ${atRoot} notes were saved as “(unsaved copy)” notes at the top of the vault because their folders were deleted.`,
    );
  }
  for (const reason of ['deleted', 'rejected', 'too_large'] as const) {
    const n = dropped[reason];
    if (n) out.push(DROP_NOTICES[reason][n === 1 ? 0 : 1]);
  }
  return out.length ? out.join(' ') : null;
}

/** Every logout call is aborted after this long: the keys are already gone, and a new sign-in waits for it. */
export const LOGOUT_TIMEOUT_MS = 5000;

/** A new recovery key, shown to the user before the server is told about it. */
export interface PreparedRecoveryKey {
  /** The formatted key, for display. */
  text: string;
  body: { currentAuthKey: string; recoveryAuth: string; wrappedUserKeyRecovery: string };
}

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
  /** Other tabs of this browser share the session: lock together, sign out together, idle together. */
  private tabs = new TabLink({
    onPeerLock: (notice) => this.afterSignIn(() => this.lock(notice, { fromPeer: true })),
    onPeerSignOut: () => this.afterSignIn(() => this.endFromPeer()),
  });
  /** The logout of the last lock or sign-out; a new sign-in waits for it so it cannot end the new session. */
  private sessionEnd: Promise<void> = Promise.resolve();
  /**
   * A sign-in whose session-starting request may be on the wire (from after previousSessionGone until
   * its keys are in place). A lock or sign-out from another tab meanwhile waits for it, then applies.
   * Never rejects.
   */
  private unlocking: Promise<void> | null = null;
  /** The account last signed in in this tab, so a locked tab still counts its queued edits. Memory only. */
  private lastUserId: string | null = null;
  /** Queue notices produced while the keys were going (or gone), per account; shown when it signs in again. Memory only. */
  private deferredNotices = new Map<string, string>();
  /** Another tab signed out while this tab's own lock was running: that lock forgets the username too. */
  private forgetOnEnd = false;

  constructor() {
    setUnauthorizedHandler(() => this.sessionEnded());
    // Another tab signed in as someone else, so the shared cookie is theirs now: end this tab's session too.
    setUserMismatchHandler(() => this.sessionEnded(USER_MISMATCH_NOTICE));
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        if (this.state.phase === 'unlocked') void this.retryPending();
      });
      window.addEventListener('beforeunload', (e) => {
        if (!this.hasUnsavedWork()) return;
        e.preventDefault();
        // Older browsers only ask when returnValue is set.
        e.returnValue = true;
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
    // A sign-out from another tab may land while a request is out: its result then stands, not boot's.
    try {
      const { needsSetup } = await api.status();
      if (this.state.phase !== 'booting') return;
      if (needsSetup) {
        this.set({ phase: 'setup' });
        return;
      }
      try {
        const { user } = await api.me();
        if (this.state.phase !== 'booting') return;
        this.set({ phase: 'locked', user, lastUsername: user.username });
      } catch (e) {
        if (this.state.phase !== 'booting') return;
        if (e instanceof ApiError && e.status === 401) {
          this.set({ phase: 'signedOut', user: null, lastUsername: recallUsername() });
        } else throw e;
      }
    } catch {
      if (this.state.phase !== 'booting') return;
      this.set({ phase: 'offline' });
    }
  }

  /** Signs in (or re-unlocks an existing session) with username + password. */
  async unlock(username: string, password: string): Promise<void> {
    const { kdfSalt, kdfParams } = await api.params(username);
    const params = assertKdfParams(kdfParams);
    const { authKey, passwordKEK } = await derive(password, kdfSalt, params);
    await this.previousSessionGone();
    await this.signingIn(async () => {
      const { user, wrappedUserKey } = await api.login(username, authKey);
      const userKey = await unwrapUserKey(wrappedUserKey, passwordKEK, user.id);
      this.enterUnlocked(user, userKey);
      void this.loadAll();
    });
  }

  /**
   * Runs the part of a sign-in that starts a server session and unwraps the keys. A lock or sign-out
   * broadcast by another tab meanwhile would end that new session under us, so the peer hooks wait
   * for it and then lock or sign out through their normal path (see afterSignIn).
   * `fn` must start with the session-starting request. Callers wait for previousSessionGone first,
   * outside this: inside it a peer lock arriving meanwhile would wait for this sign-in while the
   * sign-in waited for that lock's end (a mutual wait until the peer's 4 s cap).
   */
  private async signingIn(fn: () => Promise<void>): Promise<void> {
    // A peer lock or sign-out that arrived since the caller's wait is waited out here, while `unlocking`
    // is still unset, so its hook applies at once. The last check, `fn()` (and so its request) and
    // setting `unlocking` run in one synchronous step; tab messages arrive as tasks, so none slips in.
    while (this.tabs.peerLocksPending()) await this.previousSessionGone();
    const run = fn();
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.unlocking = settled;
    try {
      await run;
    } finally {
      if (this.unlocking === settled) this.unlocking = null;
    }
  }

  /**
   * Applies another tab's lock or sign-out once a sign-in in progress here has landed (or failed).
   * If that sign-in started a session, this tab then ends it itself: the peer gives up waiting after
   * LOCK_WAIT_MS, so its own logout may have run before that session existed. A second logout is harmless.
   */
  private async afterSignIn(apply: () => Promise<void>): Promise<void> {
    const signIn = this.unlocking;
    if (signIn) await signIn;
    const startedSession = signIn !== null && this.state.phase === 'unlocked';
    await apply();
    if (startedSession) {
      this.sessionEnd = this.logoutBounded();
      await this.sessionEnd;
    }
  }

  private enterUnlocked(user: User, userKey: CryptoKey) {
    this.epoch++;
    this.userKey = userKey;
    this.vaultKeys.clear();
    this.ownStamps.clear();
    this.lastUserId = user.id;
    setRequestUser(user.id);
    const deferred = this.deferredNotices.get(user.id) ?? null;
    this.deferredNotices.delete(user.id);
    rememberUsername(user.username);
    this.set({ phase: 'unlocked', user, lastUsername: user.username, notice: deferred, ...EMPTY_DATA });
    this.syncPendingCount();
    void this.retryPending();
  }

  private dropKeys() {
    this.epoch++;
    this.userKey = null;
    this.vaultKeys.clear();
    this.ownStamps.clear();
    for (const e of this.pending) e.copyTitle = null;
    // Every signed-out transition passes here: data requests name nobody until the next sign-in.
    setRequestUser(null);
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

  /** Records keyboard/pointer input; shared with the other tabs for the idle lock. */
  markActive() {
    this.tabs.markActive();
  }

  /** Milliseconds since the newest input in any tab of this browser. */
  idleMs(): number {
    return this.tabs.idleMs();
  }

  /** Waits until a lock here or in another tab has finished ending the shared session. */
  private async previousSessionGone(): Promise<void> {
    await Promise.all([this.sessionEnd, this.tabs.peerLocksSettled()]);
  }

  /** Ends the server session, giving up after LOGOUT_TIMEOUT_MS. Never throws. */
  private async logoutBounded(): Promise<void> {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        ac.abort();
        resolve();
      }, LOGOUT_TIMEOUT_MS);
    });
    try {
      // Raced as well as aborted, so even a request that ignores the abort cannot hold up a sign-in.
      await Promise.race([
        api.logout(ac.signal).then(
          () => undefined,
          // Keys are gone either way; a stale cookie only lets someone see the locked screen.
          () => undefined,
        ),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Drops keys + decrypted data and ends the server session; only the username is remembered.
   * The other tabs lock too (each flushes its own edits first). The tab that started the lock ends
   * the session once they are done, or after LOCK_WAIT_MS; a tab locked by a peer leaves that to it.
   * The logout itself is bounded by LOGOUT_TIMEOUT_MS.
   * A call while a lock, sign-out or session end is in progress does nothing.
   */
  async lock(notice: string | null = null, opts: { fromPeer?: boolean } = {}): Promise<void> {
    if (this.state.phase !== 'unlocked' || this.state.locking) return;
    this.set({ locking: true });
    try {
      const peers = opts.fromPeer ? null : this.tabs.announceLock(notice);
      await this.flushAll(true);
      // A sign-out from another tab arrived meanwhile: it wins, so the username is forgotten.
      const forget = this.takeForgetOnEnd();
      const lastUsername = forget ? '' : (this.state.user?.username ?? this.state.lastUsername);
      this.dropKeys();
      if (forget) this.forgetAccount();
      else rememberUsername(lastUsername);
      this.set({ phase: 'signedOut', user: null, lastUsername, notice, locking: false, ...EMPTY_DATA });
      this.syncPendingCount();
      if (!peers) return;
      this.sessionEnd = (async () => {
        await peers.peersDone;
        await this.logoutBounded();
        peers.end();
      })();
      await this.sessionEnd;
    } finally {
      if (this.state.locking) this.set({ locking: false });
    }
  }

  /** "Not you?" on the unlock screen when there is no session: forget the remembered username. */
  forgetUsername() {
    this.forgetAccount();
    this.set({ lastUsername: '' });
    this.syncPendingCount();
  }

  /** Forgets the remembered username and which account this tab last held (no count while signed out). */
  private forgetAccount() {
    forgetRememberedUsername();
    this.lastUserId = null;
  }

  /** Reads and clears forgetOnEnd; every lock, sign-out and session end calls it once its flush is done. */
  private takeForgetOnEnd(): boolean {
    const forget = this.forgetOnEnd;
    this.forgetOnEnd = false;
    return forget;
  }

  /**
   * Like lock, but the username is forgotten, here and in every other tab. The other tabs sign out
   * too (each flushes its own edits first); this tab ends the session once they are done, or after
   * LOCK_WAIT_MS, and that logout is bounded by LOGOUT_TIMEOUT_MS.
   */
  async signOut(): Promise<void> {
    if (this.state.locking) return;
    this.set({ locking: true });
    try {
      const peers = this.tabs.announceSignOut();
      await this.flushAll(true);
      this.takeForgetOnEnd(); // forgetting anyway
      this.dropKeys();
      this.forgetAccount();
      this.set({ phase: 'signedOut', user: null, lastUsername: '', notice: null, locking: false, ...EMPTY_DATA });
      this.syncPendingCount();
      this.sessionEnd = (async () => {
        await peers.peersDone;
        await this.logoutBounded();
        peers.end();
      })();
      await this.sessionEnd;
    } finally {
      if (this.state.locking) this.set({ locking: false });
    }
  }

  /**
   * Another tab signed out: flush this tab's edits while the keys are still here, then drop them
   * and forget the username. The tab that signed out ends the session; this one only logs out a
   * session its own sign-in started meanwhile (see afterSignIn). Skipped while a lock, sign-out or
   * session end is already running here.
   */
  private async endFromPeer(): Promise<void> {
    const { phase } = this.state;
    if (phase === 'signedOut' || phase === 'setup') {
      // No keys here; still stop showing the name the user chose to forget.
      if (this.state.lastUsername) {
        forgetRememberedUsername();
        this.set({ lastUsername: '' });
      }
      this.lastUserId = null;
      this.syncPendingCount();
      return;
    }
    if (this.state.locking) {
      // This tab's own lock (or session end) is flushing: let it forget the username when it finishes.
      this.forgetOnEnd = true;
      return;
    }
    this.set({ locking: true });
    try {
      await this.flushAll(true);
      this.takeForgetOnEnd(); // forgetting anyway
      this.dropKeys();
      this.forgetAccount();
      this.set({ phase: 'signedOut', user: null, lastUsername: '', notice: null, locking: false, ...EMPTY_DATA });
      this.syncPendingCount();
    } finally {
      if (this.state.locking) this.set({ locking: false });
    }
  }

  /**
   * The server ended the session (401): a lock in another tab, a password change or a recovery
   * elsewhere. Open editors are flushed while the keys are still here; their saves fail with 401
   * (transient), so the text is stashed as ciphertext and sent after the next sign-in. Further 401s
   * while this runs (or during a lock) are ignored. Also run when another tab signed in as someone
   * else (409 user_mismatch, with its own notice): the same flush, and no logout, since the cookie is theirs.
   */
  private async sessionEnded(notice = SESSION_ENDED_NOTICE): Promise<void> {
    if (this.state.phase === 'signedOut' || this.state.phase === 'setup' || this.state.locking) return;
    this.set({ locking: true });
    try {
      await this.flushAll(true);
      const forget = this.takeForgetOnEnd();
      this.dropKeys();
      if (forget) this.forgetAccount();
      this.set({
        phase: 'signedOut',
        user: null,
        ...(forget ? { lastUsername: '' } : {}),
        notice,
        locking: false,
        ...EMPTY_DATA,
      });
      this.syncPendingCount();
    } finally {
      if (this.state.locking) this.set({ locking: false });
    }
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
    let rk: Awaited<ReturnType<typeof deriveRecoveryKeys>>;
    try {
      rk = await deriveRecoveryKeys(rkBytes);
    } finally {
      wipe(rkBytes);
    }
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
    // After the slow derivation, so a lock elsewhere meanwhile is waited out too (outside signingIn; see there).
    await this.previousSessionGone();
    await this.signingIn(async () => {
      const { user } = opts.inviteToken
        ? await api.register({ ...body, inviteToken: opts.inviteToken })
        : await api.setup({ ...body, setupToken: opts.setupToken ?? '' });
      if (user.id !== userId) throw new Error('Server returned an unexpected user id');
      this.enterUnlocked(user, uk.userKey);
      this.set({ vaultsStatus: 'ready' });
    });
    try {
      await this.createVault('Personal', '#45A89E');
    } catch {
      // Not fatal; the user can create a vault from the sidebar.
    }
    return recoveryKeyText;
  }

  async recover(username: string, recoveryKeyText: string, newPassword: string): Promise<void> {
    const rkBytes = parseRecoveryKey(recoveryKeyText);
    let rk: Awaited<ReturnType<typeof deriveRecoveryKeys>>;
    try {
      rk = await deriveRecoveryKeys(rkBytes);
    } finally {
      wipe(rkBytes);
    }
    const { userId, wrappedUserKeyRecovery } = await api.recoverStart(username, rk.recoveryAuth);
    const kdfSalt = generateKdfSalt();
    const kdfParams: KdfParams = { ...DEFAULT_KDF_PARAMS };
    const pw = await derive(newPassword, kdfSalt, kdfParams);
    const wrappedUserKey = await rewrapUserKey(
      wrappedUserKeyRecovery,
      { kek: rk.recoveryKEK, aad: aad.userKeyRecovery(userId) },
      { kek: pw.passwordKEK, aad: aad.userKey(userId) },
    );
    // After the slow derivation, so a lock elsewhere meanwhile is waited out too (outside signingIn; see there).
    await this.previousSessionGone();
    await this.signingIn(async () => {
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
    });
  }

  /**
   * Step 1 of replacing the recovery key: makes a fresh key and re-wraps the same userKey under it.
   * Sends nothing (only the params/me reads), so the old key keeps working until
   * commitRecoveryKeyRotation; show `text` first and commit only once the user has saved it.
   * Throws CryptoError('unwrap') for a wrong password.
   */
  async prepareRecoveryKeyRotation(password: string): Promise<PreparedRecoveryKey> {
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
    return { text, body: { currentAuthKey: pw.authKey, recoveryAuth: rk.recoveryAuth, wrappedUserKeyRecovery } };
  }

  /** Step 2: the server swaps the recovery proof, so the prepared key works and the old one stops. */
  async commitRecoveryKeyRotation(prepared: PreparedRecoveryKey): Promise<void> {
    await api.rotateRecoveryKey(prepared.body);
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
    const ep = this.epoch;
    const encMeta = await encryptVaultMeta(this.vaultKey(id), id, meta);
    const { vault } = await api.updateVault(id, encMeta);
    // Locked meanwhile: the rename landed, but the plaintext name must not reach the new state.
    if (ep !== this.epoch) throw new LockedError();
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
    // Best effort: without an Index the folder's preview offers "Add description".
    try {
      await this.createNote(vaultId, id, INDEX_TITLE, indexBody(name));
    } catch {
      /* the folder exists; the Index can be added later */
    }
    return view;
  }

  /** Creates the Index note for a folder (`null` = vault root), named after the folder or vault. */
  async addDescription(vaultId: string, folderId: string | null): Promise<NoteView> {
    const name = folderId ? this.state.trees[vaultId]?.folders[folderId]?.name : this.state.vaults[vaultId]?.name;
    return this.createNote(vaultId, folderId, INDEX_TITLE, indexBody(name ?? ''));
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

  /**
   * Stores a note head. A head older than the stored one is a late response: it is dropped whole
   * (never merged), and the result is false so the caller skips its body too.
   */
  private putHead(vaultId: string, head: NoteView): boolean {
    const prev = this.state.trees[vaultId]?.notes[head.id];
    if (prev && prev.updatedAt > head.updatedAt) return false;
    this.patchTree(vaultId, (t) => ({ notes: { ...t.notes, [head.id]: head } }));
    return true;
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

  /**
   * Fetches and decrypts a note. The vault id comes from the URL and is bound by the AAD.
   * A read older than the head this tab already has (it left before a save landed) is read once
   * more: the server holds the newer version, since the stored head came from it. If even that read
   * is stale it is returned anyway, and the editor's next save takes the conflict path.
   */
  async loadNote(vaultId: string, noteId: string): Promise<{ head: NoteView; body: string }> {
    const ep = this.epoch;
    const key = this.vaultKey(vaultId);
    let read = await this.readNote(key, vaultId, noteId, ep);
    if (!this.putHead(vaultId, read.head)) {
      const first = read;
      try {
        read = await this.readNote(key, vaultId, noteId, ep);
      } catch (e) {
        // A transient failure on the re-read must not discard a usable first read.
        if (e instanceof LockedError || (e instanceof ApiError && e.status === 404)) throw e;
        return first;
      }
      // Still stale: keep the newer body this tab has.
      if (!this.putHead(vaultId, read.head)) return read;
    }
    const { body } = read;
    this.set((s) => ({ bodies: { ...s.bodies, [noteId]: body } }));
    return read;
  }

  /** One fetch and decrypt of a note, dropped if the keys went away meanwhile. Stores nothing. */
  private async readNote(key: CryptoKey, vaultId: string, noteId: string, ep: number): Promise<{ head: NoteView; body: string }> {
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
    // A later save already landed: its body is the current one.
    if (this.putHead(vaultId, head)) this.set((s) => ({ bodies: { ...s.bodies, [noteId]: body } }));
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
    this.syncPendingCount();
    if (opts.racing) {
      const { save, sameText } = opts.racing;
      // A racing save that never answers holds the item for at most QUEUE_REQUEST_TIMEOUT_MS; it is then sent on its own base.
      bounded(save)
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
    if (!userId) return;
    // A pass can outlive its session (a hung request, then a lock and another sign-in). Every request
    // checks the session first: under another account's cookie the server would answer 404 and the
    // text would be dropped. Refused here, it is a network error, so the item stays queued.
    const sameSession = () => this.state.phase === 'unlocked' && this.state.user?.id === userId;
    const guard = <T>(send: () => Promise<T>): Promise<T> =>
      sameSession() ? send() : Promise.reject(new ApiError(0, 'network'));
    // Each request names the item's owner (always userId here), not whoever the client thinks is
    // signed in, so a cookie swapped by another tab is refused (user_mismatch: kept) even if state lags.
    const ioFor = (owner: string) => ({
      updateNote: (id: string, b: { encBody: string; baseUpdatedAt?: string }) => guard(() => QUEUE_IO.updateNote(owner, id, b)),
      createNote: (vaultId: string, b: PendingSave['copy']) => guard(() => QUEUE_IO.createNote(owner, vaultId, b)),
      getNote: (id: string) => guard(() => QUEUE_IO.getNote(owner, id)),
      sameText: (item: PendingSave, storedEncBody: string) => this.sameQueuedText(item, storedEncBody, sameSession),
    });
    const copied: QueueEntry[] = [];
    let atRoot = 0;
    const dropped: Record<DropReason, number> = { deleted: 0, rejected: 0, too_large: 0 };
    for (const entry of [...this.pending]) {
      if (!sameSession()) break; // the account changed: the next pass belongs to the new one
      if (entry.held || !this.pending.includes(entry)) continue;
      // Only ever send with the owning account's session (never another's, never none).
      if (entry.owner !== userId) continue;
      const { outcome, reason } = await sendPending(entry.item, ioFor(entry.owner));
      if (outcome === 'retry') {
        entry.item.attempts++;
        continue;
      }
      // Remove by identity: entries stashed during this pass stay queued.
      this.pending = this.pending.filter((e) => e !== entry);
      if (outcome === 'saved') {
        if (this.state.phase === 'unlocked' && this.state.user?.id === userId) {
          void this.refreshNoteHead(entry.item.vaultId, entry.item.noteId);
        }
      } else if (outcome === 'copied') copied.push(entry);
      else if (outcome === 'copiedToRoot') atRoot++;
      else dropped[reason ?? 'rejected']++;
    }
    this.syncPendingCount();
    // Shown now only while this account's keys are here and staying; titles are plaintext.
    const live = this.state.phase === 'unlocked' && !this.state.locking && this.state.user?.id === userId;
    const notice = queueNotice(
      copied.map((e) => (live ? e.copyTitle : null)),
      atRoot,
      dropped,
    );
    if (notice) {
      if (live) this.addNotice(notice);
      else this.deferNotice(userId, notice);
    }
    if ((copied.length || atRoot) && live) void this.loadAll().catch(() => undefined);
  }

  /**
   * After a queued save's 409: does the server's body hold the same text as the item? Both are
   * decrypted with the note's own AAD and compared in memory; nothing is kept. False when it cannot
   * tell (the keys are gone or the session changed, or either body does not decrypt), so the queue
   * falls back to comparing ciphertext.
   */
  private async sameQueuedText(item: PendingSave, storedEncBody: string, sameSession: () => boolean): Promise<boolean> {
    const key = this.vaultKeys.get(item.vaultId);
    if (!key || !sameSession()) return false;
    try {
      const [stored, queued] = await Promise.all([
        decryptNoteBody(key, item.vaultId, item.noteId, storedEncBody),
        decryptNoteBody(key, item.vaultId, item.noteId, item.encBody),
      ]);
      return stored === queued;
    } catch {
      return false;
    }
  }

  /** Shows a queue notice after any notice already showing, so neither is lost. */
  private addNotice(text: string) {
    this.set((s) => ({ notice: s.notice ? `${s.notice} ${text}` : text }));
  }

  /** Keeps a queue notice for the next time `owner` signs in (title-free text only), per account. */
  private deferNotice(owner: string, text: string) {
    const prev = this.deferredNotices.get(owner);
    this.deferredNotices.set(owner, prev ? `${prev} ${text}` : text);
  }

  /**
   * After a queued save landed: re-reads the note so the tree, search and the conflict base are
   * current. Its body is decrypted only if it was loaded already. Best effort: failures are ignored.
   */
  private async refreshNoteHead(vaultId: string, noteId: string): Promise<void> {
    const ep = this.epoch;
    try {
      const key = this.vaultKey(vaultId);
      const { note } = await api.getNote(noteId);
      if (ep !== this.epoch) return;
      const meta = await decryptNoteMeta(key, vaultId, noteId, note.encMeta);
      const body = noteId in this.state.bodies ? await decryptNoteBody(key, vaultId, noteId, note.encBody) : undefined;
      if (ep !== this.epoch) return;
      // Not marked as own: an editor opened before this save never saw the queued text, so adopting
      // this stamp would let its next autosave replace that text silently. It must hit the conflict path.
      const stored = this.putHead(vaultId, {
        id: noteId,
        vaultId,
        folderId: note.folderId,
        title: meta.title,
        size: note.size,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
      });
      // Not stored: something newer already arrived here, so this read is stale.
      if (stored && body !== undefined) this.set((s) => ({ bodies: { ...s.bodies, [noteId]: body } }));
    } catch {
      // The tree catches up on the next load.
    }
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

  /**
   * `pendingCount` covers only the items the current account may send: the signed-in one, or while
   * signed out the account last signed in here (none once it signed out or was forgotten).
   */
  private syncPendingCount() {
    const owner = this.state.user?.id ?? this.lastUserId;
    const count = owner ? this.pending.filter((e) => e.owner === owner).length : 0;
    if (this.state.pendingCount !== count) this.set({ pendingCount: count });
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
