// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withViewTransition } from './viewTransition';

type Doc = { startViewTransition?: unknown; };

function setMedia(reduce: boolean) {
  window.matchMedia = vi.fn(() => ({ matches: reduce, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  delete (document as Doc).startViewTransition;
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('withViewTransition', () => {
  it('calls update synchronously without the API', () => {
    setMedia(false);
    const update = vi.fn();
    withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('delegates to startViewTransition when available and motion is allowed', () => {
    setMedia(false);
    const start = vi.fn();
    (document as Doc).startViewTransition = start;
    const update = vi.fn();
    withViewTransition(update);
    expect(start).toHaveBeenCalledWith(update);
    expect(update).not.toHaveBeenCalled();
  });

  it('calls update directly under reduced motion', () => {
    setMedia(true);
    const start = vi.fn();
    (document as Doc).startViewTransition = start;
    const update = vi.fn();
    withViewTransition(update);
    expect(start).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
  });
});
