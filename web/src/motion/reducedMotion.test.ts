// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion, useReducedMotion } from './reducedMotion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mockMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      mql.matches = next;
      listeners.forEach((fn) => fn());
    },
  };
}

afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('prefersReducedMotion', () => {
  it('reflects the media query', () => {
    mockMedia(true);
    expect(prefersReducedMotion()).toBe(true);
    mockMedia(false);
    expect(prefersReducedMotion()).toBe(false);
  });
  it('counts a missing matchMedia as reduced', () => {
    expect(prefersReducedMotion()).toBe(true);
  });
});

describe('useReducedMotion', () => {
  it('updates on a change event', () => {
    const media = mockMedia(false);
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useReducedMotion());
      return null;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(createElement(Probe)));
    expect(seen.at(-1)).toBe(false);
    act(() => media.set(true));
    expect(seen.at(-1)).toBe(true);
    act(() => root.unmount());
  });
});
