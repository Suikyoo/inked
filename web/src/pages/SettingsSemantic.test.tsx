// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { vault } from '../map/fixtures';
import { SemanticProvider } from '../semantic/SemanticContext';
import type { SemanticState, SemanticStore } from '../semantic/semanticStore';
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

function renderSettings(state: Partial<SemanticState>, methods: Partial<SemanticStore> = {}) {
  const setEnabled = vi.fn(async () => undefined);
  const retry = vi.fn();
  const semantic = semanticStub(
    { available: true, coverage: { v1: { done: 3, total: 5 } }, downloadBytes: 34e6, ...state },
    { setEnabled, retry, ...methods },
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
    expect(text()).toContain('Finds notes by what they’re about, not just their words. On for every device you sign in on.');
    expect(text()).not.toContain('this browser');
    act(() => semanticBox().click());
    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(bars()).toEqual(['Work · 3 / 5 notes']);
  });

  it('shows model download progress', () => {
    renderSettings({ accountOn: true, enabled: true, phase: 'downloading', download: { loaded: 18e6, total: 34e6 } });
    expect(bars()).toContain('Model 18 / 34 MB');
  });

  it('says the model is being prepared while loading, without a model bar', () => {
    renderSettings({ accountOn: true, enabled: true, phase: 'loading', download: { loaded: 34e6, total: 34e6 } });
    expect(text()).toContain('Preparing the search model…');
    expect(bars()).toEqual(['Work · 3 / 5 notes']);
  });

  it('shows the error with a working Retry', () => {
    const { retry } = renderSettings({ accountOn: true, enabled: true, phase: 'error', error: 'Couldn’t download the search model.' });
    expect(host!.querySelector('.form-error[role="alert"]')?.textContent).toBe('Couldn’t download the search model.');
    act(() => button('Retry').click());
    expect(retry).toHaveBeenCalled();
  });

  it('turns off when unticked while enabled', () => {
    const { setEnabled } = renderSettings({ accountOn: true, enabled: true, phase: 'ready' });
    act(() => semanticBox().click());
    expect(setEnabled).toHaveBeenCalledWith(false);
  });

  it('explains a paused model', () => {
    renderSettings({ accountOn: true, enabled: true, phase: 'paused' });
    expect(text()).toContain('Search by meaning stopped after a problem. It will try again next time you unlock.');
  });

  it('warns when the browser may clear the model', () => {
    renderSettings({ accountOn: true, enabled: true, phase: 'ready', persistDenied: true });
    expect(text()).toContain('This browser may clear the model when you close a private window or free up space.');
  });

  it('offers a download on a browser that does not have the model', () => {
    const downloadHere = vi.fn(async () => undefined);
    renderSettings({ accountOn: true, enabled: false }, { downloadHere });
    expect(text()).toContain('Not on this browser.');
    act(() => button('Download (34 MB)').click());
    expect(downloadHere).toHaveBeenCalled();
  });

  it('says the model is on this browser, and while it downloads', () => {
    renderSettings({ accountOn: true, enabled: true, phase: 'ready' });
    expect(text()).toContain('Downloaded on this browser.');
    act(() => root!.unmount());
    host!.remove();
    renderSettings({ accountOn: true, enabled: true, phase: 'downloading', download: { loaded: 1e6, total: 34e6 } });
    expect(text()).toContain('Downloading on this browser…');
  });

  it('a failed save from the switch or the download link is not an unhandled rejection', async () => {
    const setEnabled = vi.fn(async () => Promise.reject(new Error('locked')));
    const downloadHere = vi.fn(async () => Promise.reject(new Error('locked')));
    renderSettings({ accountOn: true, enabled: false }, { setEnabled, downloadHere });
    await act(async () => button('Download (34 MB)').click());
    await act(async () => semanticBox().click());
    expect(downloadHere).toHaveBeenCalled();
    expect(setEnabled).toHaveBeenCalledWith(false);
  });

  it('does not warn about persistence while off', () => {
    renderSettings({ enabled: false, persistDenied: true });
    expect(text()).not.toContain('may clear the model');
  });
});
