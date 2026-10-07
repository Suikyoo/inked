// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '../api/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPage } from './LoginPage';
import { StoreProvider } from '../state/StoreContext';
import type { AppState, AppStore } from '../state/store';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type FakeStore = {
  getState: () => AppState;
  subscribe: () => () => void;
  clearNotice: () => void;
  unlock: ReturnType<typeof vi.fn>;
  unlockTransition: ((notify: () => void) => void) | null;
};

function fakeStore(unlock: FakeStore['unlock']): FakeStore {
  const state = { phase: 'signedOut', lastUsername: 'ada', notice: null } as unknown as AppState;
  return { getState: () => state, subscribe: () => () => undefined, clearNotice: () => undefined, unlock, unlockTransition: null };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(store: FakeStore) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter>
        <StoreProvider store={store as unknown as AppStore}>
          <LoginPage />
        </StoreProvider>
      </MemoryRouter>,
    ),
  );
  return host;
}

async function submitWith(el: HTMLElement, pw: string) {
  const input = el.querySelector<HTMLInputElement>('input[name="password"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, pw);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  Reflect.deleteProperty(window, 'matchMedia');
  Reflect.deleteProperty(document, 'startViewTransition');
  document.documentElement.removeAttribute('style');
});

describe('LoginPage motion', () => {
  it('a wrong password nudges the password field once, until animationend', async () => {
    const err = new ApiError(401, 'bad_credentials');
    const store = fakeStore(vi.fn().mockRejectedValue(err));
    const el = render(store);
    await submitWith(el, 'wrong-pass');
    const wrap = el.querySelector('.field-nudge')!;
    expect(wrap.classList.contains('nudge')).toBe(true);
    act(() => {
      wrap.dispatchEvent(new Event('animationend', { bubbles: true }));
    });
    expect(wrap.classList.contains('nudge')).toBe(false);
  });

  it('runs the unlock re-render inside a view transition, wiping from the button', async () => {
    const start = vi.fn((cb: () => void) => {
      cb();
      return { finished: new Promise<void>(() => undefined) };
    });
    (document as unknown as { startViewTransition: unknown }).startViewTransition = start;
    const store = fakeStore(vi.fn(() => new Promise<void>(() => undefined)));
    const el = render(store);
    expect(store.unlockTransition).toBeTypeOf('function');
    await submitWith(el, 'right-pass');
    expect(document.documentElement.style.getPropertyValue('--wipe-x')).not.toBe('');
    const notify = vi.fn();
    vi.useFakeTimers();
    act(() => store.unlockTransition!(notify));
    // The drop completes first, then the swap runs inside the transition.
    expect(el.querySelector('svg.ink-fill')!.classList.contains('is-done')).toBe(true);
    expect(start).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(140);
    });
    vi.useRealTimers();
    expect(start).toHaveBeenCalledWith(expect.any(Function));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(document.documentElement.classList.contains('is-unlocking')).toBe(true);
  });

  it('ignores animationend bubbling from children', async () => {
    const store = fakeStore(vi.fn().mockRejectedValue(new ApiError(401, 'bad_credentials')));
    const el = render(store);
    await submitWith(el, 'wrong-pass');
    const wrap = el.querySelector('.field-nudge')!;
    act(() => {
      el.querySelector('input')!.dispatchEvent(new Event('animationend', { bubbles: true }));
    });
    expect(wrap.classList.contains('nudge')).toBe(true);
  });

  it('removes its transition hook on unmount', () => {
    const store = fakeStore(vi.fn());
    render(store);
    act(() => root!.unmount());
    root = null;
    expect(store.unlockTransition).toBeNull();
  });
});
