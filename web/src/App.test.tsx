// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import type { AppState, AppStore } from './state/store';
import { accountStub } from './test/account';
import { semanticStub } from './test/semantic';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Just enough of a store for the boot splash. */
function fakeStore() {
  const state = { phase: 'booting' } as AppState;
  return {
    boot: vi.fn(async () => undefined),
    getState: () => state,
    subscribe: () => () => undefined,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(store: ReturnType<typeof fakeStore>) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<App store={store as unknown as AppStore} semantic={semanticStub()} account={accountStub()} />));
  return host;
}

function setSecureContext(value: boolean) {
  Object.defineProperty(window, 'isSecureContext', { value, configurable: true });
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  Reflect.deleteProperty(window, 'isSecureContext');
});

describe('App (C1)', () => {
  it('outside a secure context it explains why and never boots', () => {
    setSecureContext(false);
    const store = fakeStore();
    const el = render(store);
    expect(el.textContent).toContain('Inked needs a secure connection');
    expect(store.boot).not.toHaveBeenCalled();
  });

  it('in a secure context it boots', () => {
    setSecureContext(true);
    const store = fakeStore();
    const el = render(store);
    expect(el.textContent).not.toContain('Inked needs a secure connection');
    expect(store.boot).toHaveBeenCalledTimes(1);
  });
});
