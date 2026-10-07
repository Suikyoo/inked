// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '../state/StoreContext';
import type { AppStore } from '../state/store';
import { AppShell } from './AppShell';

vi.mock('./Sidebar', () => ({ Sidebar: () => null }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeStore() {
  let state = { notice: null as string | null, pendingCount: 0 };
  const subs = new Set<() => void>();
  const store = {
    subscribe: (cb: () => void) => (subs.add(cb), () => void subs.delete(cb)),
    getState: () => state,
    markActive: () => {},
    idleMs: () => 0,
    clearNotice: () => {},
    retryPending: async () => {},
    lock: async () => {},
  };
  const set = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    act(() => subs.forEach((f) => f()));
  };
  return { store: store as unknown as AppStore, set };
}

let root: Root;
let host: HTMLElement;
let ctl: ReturnType<typeof fakeStore>;
beforeEach(() => {
  vi.useFakeTimers();
  ctl = fakeStore();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root.render(
      <MemoryRouter>
        <StoreProvider store={ctl.store}>
          <AppShell />
        </StoreProvider>
      </MemoryRouter>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const wrap = (sel: string) => host.querySelector(sel)?.closest('.collapse') ?? null;

describe('AppShell banner and sync bar', () => {
  it('collapses the banner out, keeping its text, then unmounts', () => {
    ctl.set({ notice: 'Locked after a while.' });
    tick(50);
    expect(wrap('.banner')?.getAttribute('data-state')).toBe('open');
    ctl.set({ notice: null });
    expect(wrap('.banner')?.getAttribute('data-state')).toBe('exit');
    expect(wrap('.banner')?.textContent).toContain('Locked after a while.');
    tick(300);
    expect(host.querySelector('.banner')).toBeNull();
  });

  it('collapses the sync bar out when pendingCount drops to 0', () => {
    ctl.set({ pendingCount: 2 });
    tick(50);
    expect(wrap('.sync-bar')?.getAttribute('data-state')).toBe('open');
    ctl.set({ pendingCount: 0 });
    expect(wrap('.sync-bar')?.getAttribute('data-state')).toBe('exit');
    expect(wrap('.sync-bar')?.textContent).toContain('2 changes');
    tick(300);
    expect(host.querySelector('.sync-bar')).toBeNull();
  });
});
