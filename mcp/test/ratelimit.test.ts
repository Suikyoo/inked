import { describe, expect, it } from 'vitest';
import { WriteLimiter } from '../src/ratelimit';

describe('WriteLimiter', () => {
  it('allows exactly perMinute writes in a window, then frees them after 60 s', () => {
    let t = 0;
    const l = new WriteLimiter(120, () => t);
    for (let i = 0; i < 120; i++) expect(l.take(1)).toBe(true);
    expect(l.take(1)).toBe(false); // the 121st write
    t = 60_001;
    expect(l.take(1)).toBe(true);
  });

  it('rejects a batch that does not fit, taking nothing', () => {
    const l = new WriteLimiter(10, () => 0);
    expect(l.take(8)).toBe(true);
    expect(l.take(3)).toBe(false);
    expect(l.take(2)).toBe(true);
  });
});
