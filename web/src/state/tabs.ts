import { uuid } from '../lib/util';

/** How long a lock waits for flushes before the keys go (editors) and for other tabs before logout. */
export const LOCK_WAIT_MS = 4000;
/** Activity is broadcast to other tabs at most this often. */
export const ACTIVITY_PING_MS = 15_000;
/** How long a lock started in another tab may keep its session end pending before we stop waiting. */
const PEER_LOCK_MAX_MS = 10_000;

/** Messages on BroadcastChannel('inked'). Never keys, note text or names. */
type TabMessage =
  | { type: 'hello' | 'here' | 'bye' | 'activity'; tab: string }
  | { type: 'lock'; tab: string; id: string; notice: string | null }
  | { type: 'lock-done' | 'lock-end'; tab: string; id: string };

export interface TabHooks {
  /** Another tab is locking: lock this one too, flushing its edits first. Resolves when flushed. */
  onPeerLock: (notice: string | null) => Promise<void>;
}

/**
 * Coordinates the tabs of one browser, which share the session cookie: activity (so the idle lock
 * only fires when every tab is idle) and locking (so every tab stashes its edits before the session
 * ends). Without BroadcastChannel it only tracks this tab's activity.
 */
export class TabLink {
  private readonly tab = uuid();
  private readonly channel: BroadcastChannel | null;
  private readonly peers = new Set<string>();
  private lastActivity = Date.now();
  private lastPing = -Infinity;
  private trailingPing: ReturnType<typeof setTimeout> | null = null;
  /** Our lock broadcasts: id -> peers still flushing. */
  private waits = new Map<string, { left: Set<string>; done: () => void }>();
  /** Peer locks whose session end has not been confirmed yet. */
  private peerLocks = new Map<string, ReturnType<typeof setTimeout>>();
  private quietWaiters: (() => void)[] = [];

  constructor(private readonly hooks: TabHooks) {
    this.channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('inked') : null;
    if (!this.channel) return;
    this.channel.onmessage = (e: MessageEvent) => this.receive(e.data as TabMessage);
    this.post({ type: 'hello', tab: this.tab });
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => this.post({ type: 'bye', tab: this.tab }));
    }
  }

  private post(m: TabMessage) {
    try {
      this.channel?.postMessage(m);
    } catch {
      // Channel closed: nothing to coordinate with.
    }
  }

  private receive(m: TabMessage) {
    if (!m || typeof m !== 'object' || typeof m.tab !== 'string' || m.tab === this.tab) return;
    if (m.type === 'bye') {
      this.peers.delete(m.tab);
      for (const w of this.waits.values()) this.answered(w, m.tab);
      return;
    }
    this.peers.add(m.tab);
    switch (m.type) {
      case 'hello':
        this.post({ type: 'here', tab: this.tab });
        break;
      case 'activity':
        this.lastActivity = Math.max(this.lastActivity, Date.now());
        break;
      case 'lock':
        this.trackPeerLock(m.id);
        void this.hooks
          .onPeerLock(m.notice)
          .catch(() => undefined)
          .finally(() => this.post({ type: 'lock-done', tab: this.tab, id: m.id }));
        break;
      case 'lock-done': {
        const w = this.waits.get(m.id);
        if (w) this.answered(w, m.tab);
        break;
      }
      case 'lock-end':
        this.endPeerLock(m.id);
        break;
    }
  }

  // ---- Activity ----------------------------------------------------------------------------

  /** Records input in this tab and tells the other tabs, at most once per ACTIVITY_PING_MS. */
  markActive(now = Date.now()) {
    this.lastActivity = Math.max(this.lastActivity, now);
    if (!this.channel || this.trailingPing) return;
    const wait = this.lastPing + ACTIVITY_PING_MS - now;
    if (wait <= 0) {
      this.lastPing = now;
      this.post({ type: 'activity', tab: this.tab });
      return;
    }
    // Activity inside the window: send one more ping when it ends, so the others never lag by more.
    this.trailingPing = setTimeout(() => {
      this.trailingPing = null;
      this.lastPing = Date.now();
      this.post({ type: 'activity', tab: this.tab });
    }, wait);
  }

  /** Milliseconds since the newest activity seen in any tab. */
  idleMs(now = Date.now()): number {
    return now - this.lastActivity;
  }

  // ---- Locking -----------------------------------------------------------------------------

  /**
   * Tells the other tabs to lock. `peersDone` resolves once every known tab has flushed, or after
   * LOCK_WAIT_MS; call `end` once the session is over, so they may sign in again.
   */
  announceLock(notice: string | null): { peersDone: Promise<void>; end: () => void } {
    const id = uuid();
    const left = new Set(this.peers);
    const peersDone = new Promise<void>((resolve) => {
      if (!this.channel || !left.size) return resolve();
      const timer = setTimeout(() => finish(), LOCK_WAIT_MS);
      const finish = () => {
        clearTimeout(timer);
        this.waits.delete(id);
        resolve();
      };
      this.waits.set(id, { left, done: finish });
    });
    this.post({ type: 'lock', tab: this.tab, id, notice });
    return { peersDone, end: () => this.post({ type: 'lock-end', tab: this.tab, id }) };
  }

  private answered(w: { left: Set<string>; done: () => void }, tab: string) {
    w.left.delete(tab);
    if (!w.left.size) w.done();
  }

  private trackPeerLock(id: string) {
    clearTimeout(this.peerLocks.get(id));
    this.peerLocks.set(
      id,
      setTimeout(() => this.endPeerLock(id), PEER_LOCK_MAX_MS),
    );
  }

  private endPeerLock(id: string) {
    const timer = this.peerLocks.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.peerLocks.delete(id);
    if (this.peerLocks.size) return;
    const waiters = this.quietWaiters;
    this.quietWaiters = [];
    for (const w of waiters) w();
  }

  /** Resolves once no lock started in another tab is still about to end the shared session. */
  peerLocksSettled(): Promise<void> {
    if (!this.peerLocks.size) return Promise.resolve();
    return new Promise((resolve) => this.quietWaiters.push(resolve));
  }
}
