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
