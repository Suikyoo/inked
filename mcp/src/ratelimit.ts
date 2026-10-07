/** Sliding 60-second write budget. A request that does not fit takes nothing. */
export class WriteLimiter {
  private stamps: number[] = [];

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(n: number): boolean {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => s > t - 60_000);
    if (this.stamps.length + n > this.perMinute) return false;
    for (let i = 0; i < n; i++) this.stamps.push(t);
    return true;
  }
}
