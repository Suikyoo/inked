import { describe, expect, it } from 'vitest';
import { FailureLimiter } from '../src/limiter.js';

describe('FailureLimiter.attempt', () => {
  it('counts attempts before verification so bursts lock after maxFails', () => {
    const l = new FailureLimiter(5, 60_000, 15 * 60_000);
    const now = 1_000_000;
    const results = Array.from({ length: 40 }, () => l.attempt('k', now));
    expect(results.filter((w) => w === 0)).toHaveLength(5);
    expect(results[5]).toBe(60);
  });

  it('reset clears provisional attempts after a success', () => {
    const l = new FailureLimiter(5, 60_000, 15 * 60_000);
    for (let i = 0; i < 4; i++) l.attempt('k', 0);
    l.reset('k');
    for (let i = 0; i < 4; i++) expect(l.attempt('k', 0)).toBe(0);
  });
});
