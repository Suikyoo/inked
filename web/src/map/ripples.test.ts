import { describe, expect, it } from 'vitest';
import { planRipples, RIPPLE_MAX, RIPPLE_STAGGER_MS } from './ripples';

describe('planRipples', () => {
  const onMap = new Set(Array.from({ length: 60 }, (_, i) => `n${i}`));
  it('ripples up to the cap with a stagger, flashes the rest', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `n${i}`);
    const p = planRipples(ids, onMap);
    expect(p.ripple).toHaveLength(RIPPLE_MAX);
    expect(p.ripple.map((r) => r.delay)).toEqual([0, 1, 2, 3, 4, 5].map((i) => i * RIPPLE_STAGGER_MS));
    expect(p.flash).toHaveLength(44);
  });
  it('drops off-map ids and duplicates', () => {
    const p = planRipples(['n1', 'n1', 'ghost'], onMap);
    expect(p.ripple.map((r) => r.id)).toEqual(['n1']);
    expect(p.flash).toEqual([]);
  });
});
