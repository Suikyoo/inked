// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folder, note, tree, vault } from '../map/fixtures';
import { StoreProvider } from '../state/StoreContext';
import type { AppState, AppStore } from '../state/store';
import { VaultPage } from './VaultPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  // jsdom has no <dialog>.close(); the Dialog falls back to the open attribute for show.
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

let loc: { pathname: string; state: unknown } = { pathname: '', state: null };
function Probe() {
  const l = useLocation();
  loc = { pathname: l.pathname, state: l.state };
  return null;
}

describe('VaultPage', () => {
  it('a new root folder opens its Index in edit mode, not with the title selected', async () => {
    let state = {
      vaultsStatus: 'ready',
      vaults: { v1: vault('v1', 'Work') },
      vaultOrder: ['v1'],
      trees: { v1: tree([], [note('x', null, 'X')]) },
      bodies: {},
      bodiesReady: { v1: true },
    } as unknown as AppState;
    const created = folder('new', null, 'Fresh');
    const store = {
      getState: () => state,
      subscribe: () => () => undefined,
      createFolder: vi.fn(async () => {
        state = { ...state, trees: { v1: tree([created], [note('x', null, 'X'), note('newidx', 'new', 'Index')]) } };
        return created;
      }),
    } as unknown as AppStore;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <MemoryRouter initialEntries={['/v/v1']}>
          <StoreProvider store={store}>
            <Probe />
            <Routes>
              <Route path="/v/:vaultId" element={<VaultPage />} />
              <Route path="/v/:vaultId/n/:noteId" element={null} />
            </Routes>
          </StoreProvider>
        </MemoryRouter>,
      ),
    );
    const newFolder = [...host.querySelectorAll('button')].find((b) => b.textContent === 'New folder')!;
    act(() => void newFolder.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const input = document.querySelector<HTMLInputElement>('#prompt-input')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'Fresh');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => void input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(store.createFolder).toHaveBeenCalledWith('v1', null, 'Fresh');
    expect(loc.pathname).toBe('/v/v1/n/newidx');
    expect(loc.state).toEqual({ mode: 'edit' });
  });
});
