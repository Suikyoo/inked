// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { folder, note, tree, vault } from '../map/fixtures';
import { StoreProvider } from '../state/StoreContext';
import type { AppState, AppStore } from '../state/store';

vi.mock('./useNoteEditor', () => ({
  useNoteEditor: () => ({
    status: 'ready',
    body: 'Some text',
    setBody: () => undefined,
    save: 'idle',
    saveStatus: 'idle',
    loadError: null,
    adoptHead: () => undefined,
    conflict: false,
  }),
}));
import { NotePane } from './NotePane';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

function mount(locState: unknown) {
  vi.useFakeTimers();
  const state = {
    vaultsStatus: 'ready',
    vaults: { v1: vault('v1') },
    vaultOrder: ['v1'],
    trees: { v1: tree([folder('f1', null, 'Ops')], [note('n1', 'f1', 'Alpha')]) },
    bodies: { n1: 'Some text' },
    bodiesReady: { v1: true },
  } as unknown as AppState;
  const store = { getState: () => state, subscribe: () => () => undefined } as unknown as AppStore;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={[{ pathname: '/v/v1/n/n1', state: locState }]}>
        <StoreProvider store={store}>
          <NotePane vault={state.vaults.v1!} noteId="n1" />
        </StoreProvider>
      </MemoryRouter>,
    ),
  );
  act(() => void vi.runAllTimers());
}

describe('NotePane entry state', () => {
  it('{ mode: "edit" } opens edit mode with the body focused and the title not selected', () => {
    mount({ mode: 'edit' });
    const text = host!.querySelector('textarea')!;
    expect(text).toBeTruthy();
    expect(document.activeElement).toBe(text);
  });

  it('{ fresh: true } still focuses the title', () => {
    mount({ fresh: true });
    expect(document.activeElement).toBe(host!.querySelector('input'));
  });

  it('plain entry opens in view mode', () => {
    mount(null);
    expect(host!.querySelector('textarea')).toBeNull();
  });
});
