import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppStore, UNLOCK_TRANSITION_MAX_MS } from './store';

type Settable = { set: (p: Record<string, unknown>) => void };

afterEach(() => vi.useRealTimers());

function setup() {
  const s = new AppStore();
  const seen: unknown[] = [];
  s.subscribe(() => seen.push(s.getState().vaultsStatus));
  return { s, seen, set: (p: Record<string, unknown>) => (s as unknown as Settable).set(p) };
}

describe('unlock notification hold', () => {
  it('holds later notifications until the deferred one runs, then notifies once with the latest state', () => {
    const { s, seen, set } = setup();
    let deferred: (() => void) | null = null;
    s.unlockTransition = (n) => {
      deferred = n;
    };
    set({ phase: 'unlocked' });
    set({ vaultsStatus: 'loading' });
    expect(seen).toHaveLength(0);
    deferred!();
    expect(seen).toEqual(['loading']);
    deferred!();
    expect(seen).toHaveLength(1);
    set({ vaultsStatus: 'ready' });
    expect(seen).toHaveLength(2);
  });

  it('flushes after the safety timeout if the hook never calls back', () => {
    vi.useFakeTimers();
    const { s, seen, set } = setup();
    s.unlockTransition = () => undefined;
    set({ phase: 'unlocked' });
    expect(seen).toHaveLength(0);
    vi.advanceTimersByTime(UNLOCK_TRANSITION_MAX_MS);
    expect(seen).toHaveLength(1);
  });
});
