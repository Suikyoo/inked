interface Entry {
  fails: number;
  firstFailAt: number;
  lockedUntil: number;
}

/**
 * In-memory failed-attempt limiter: `maxFails` failures for a key within `windowMs`
 * lock that key for `lockMs`.
 */
export class FailureLimiter {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly maxFails = 5,
    private readonly lockMs = 60_000,
    private readonly windowMs = 15 * 60_000,
  ) {}

  /** Seconds until the key is unlocked, or 0 if it is not locked. */
  retryAfter(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    if (!entry || entry.lockedUntil <= now) return 0;
    return Math.ceil((entry.lockedUntil - now) / 1000);
  }

  /**
   * Records an attempt up front (as a provisional failure) unless the key is locked.
   * Returns seconds to wait when locked (nothing recorded), else 0. Call reset() on success.
   * Counting before the async verification is what stops parallel bursts.
   */
  attempt(key: string, now = Date.now()): number {
    const wait = this.retryAfter(key, now);
    if (wait > 0) return wait;
    this.fail(key, now);
    return 0;
  }

  fail(key: string, now = Date.now()): void {
    let entry = this.entries.get(key);
    if (!entry || now - entry.firstFailAt > this.windowMs) {
      entry = { fails: 0, firstFailAt: now, lockedUntil: 0 };
      this.entries.set(key, entry);
    }
    entry.fails += 1;
    if (entry.fails >= this.maxFails) {
      entry.lockedUntil = now + this.lockMs;
      entry.fails = 0;
      entry.firstFailAt = now;
    }
    if (this.entries.size > 10_000) this.prune(now);
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  prune(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.lockedUntil <= now && now - entry.firstFailAt > this.windowMs) this.entries.delete(key);
    }
  }
}
