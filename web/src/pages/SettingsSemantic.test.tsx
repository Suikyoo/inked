// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { vault } from '../map/fixtures';
import { SemanticProvider } from '../semantic/SemanticContext';
import type { SemanticState } from '../semantic/semanticStore';
import { StoreProvider } from '../state/StoreContext';
import type { AppState, AppStore } from '../state/store';
import { semanticStub } from '../test/semantic';
import { SettingsPage } from './SettingsPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function renderSettings(state: Partial<SemanticState>) {
  const setEnabled = vi.fn(async () => undefined);
  const retry = vi.fn();
  const semantic = semanticStub(
    { available: true, coverage: { v1: { done: 3, total: 5 } }, downloadBytes: 34e6, ...state },
    { setEnabled, retry },
  );
  const appState = {
    user: { username: 'ada', isAdmin: false },
    vaults: { v1: vault('v1', 'Work') },
    vaultOrder: ['v1'],
    trees: {},
  } as unknown as AppState;
  const app = { getState: () => appState, subscribe: () => () => undefined } as unknown as AppStore;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter>
        <StoreProvider store={app}>
          <SemanticProvider store={semantic}>
            <SettingsPage />
          </SemanticProvider>
        </StoreProvider>
      </MemoryRouter>,
    ),
  );
  return { setEnabled, retry };
}

const text = () => host!.textContent ?? '';
const bars = () => [...host!.querySelectorAll('[role="progressbar"]')].map((b) => b.getAttribute('aria-label'));
const button = (name: string) => [...host!.querySelectorAll('button')].find((b) => b.textContent === name)!;
const semanticBox = () => host!.querySelector<HTMLInputElement>('section[aria-labelledby="semantic-h"] input[type="checkbox"]')!;

describe('Settings: Search by meaning', () => {
  it('is hidden when the model is unavailable', () => {
    renderSettings({ available: false, phase: 'unavailable' });
    expect(host!.querySelector('#semantic-h')).toBeNull();
  });

  it('shows nothing while availability is unknown', () => {
    renderSettings({ available: null });
    expect(host!.querySelector('#semantic-h')).toBeNull();
  });

  it('toggles on and shows per-vault coverage while off', () => {
    const { setEnabled } = renderSettings({ phase: 'off', enabled: false });
    expect(host!.querySelector('#semantic-h')?.textContent).toBe('Search by meaning');
    expect(semanticBox().checked).toBe(false);
    expect(text()).toContain('Downloads about 34 MB once to this device; your notes never leave it.');
    act(() => semanticBox().click());
    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(bars()).toEqual(['Work · 3 / 5 notes']);
  });

  it('shows model download progress', () => {
    renderSettings({ enabled: true, phase: 'downloading', download: { loaded: 18e6, total: 34e6 } });
    expect(bars()).toContain('Model 18 / 34 MB');
  });

  it('says the model is being prepared while loading, without a model bar', () => {
    renderSettings({ enabled: true, phase: 'loading', download: { loaded: 34e6, total: 34e6 } });
    expect(text()).toContain('Preparing the search model…');
    expect(bars()).toEqual(['Work · 3 / 5 notes']);
  });

  it('shows the error with a working Retry', () => {
    const { retry } = renderSettings({ enabled: true, phase: 'error', error: 'Couldn’t download the search model.' });
    expect(host!.querySelector('.form-error')?.textContent).toBe('Couldn’t download the search model.');
    act(() => button('Retry').click());
    expect(retry).toHaveBeenCalled();
  });

  it('explains a paused model', () => {
    renderSettings({ enabled: true, phase: 'paused' });
    expect(text()).toContain('Search by meaning stopped after a problem. It will try again next time you unlock.');
  });

  it('warns when the browser may clear the model', () => {
    renderSettings({ enabled: true, phase: 'ready', persistDenied: true });
    expect(text()).toContain('This browser may clear the model when you close a private window or free up space.');
  });

  it('does not warn about persistence while off', () => {
    renderSettings({ enabled: false, persistDenied: true });
    expect(text()).not.toContain('may clear the model');
  });
});
