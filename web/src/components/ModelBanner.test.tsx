// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SemanticProvider } from '../semantic/SemanticContext';
import type { SemanticState } from '../semantic/semanticStore';
import { AccountSettingsProvider } from '../state/AccountSettingsContext';
import type { AccountSettingsState } from '../state/accountSettings';
import { accountStub } from '../test/account';
import { semanticStub } from '../test/semantic';
import { ModelBanner, modelBannerKind } from './ModelBanner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const llm = { baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k' };
const sem = (p: Partial<SemanticState>) => ({ available: true, accountOn: false, choice: null, ...p }) as SemanticState;
const acc = (p: Partial<AccountSettingsState>) => ({ loaded: true, settings: {}, unreadable: false, llmOrigins: [], ...p });

describe('modelBannerKind', () => {
  it('shows for a new browser with the switch on, or with only Ask on', () => {
    expect(modelBannerKind(sem({ accountOn: true }), acc({}))).toBe('semantic');
    expect(modelBannerKind(sem({}), acc({ settings: { llm } }))).toBe('ask');
  });
  it('hides without a model, before settings load, after a choice, or with nothing on', () => {
    expect(modelBannerKind(sem({ accountOn: true, available: false }), acc({}))).toBeNull();
    expect(modelBannerKind(sem({ accountOn: true }), acc({ loaded: false }))).toBeNull();
    expect(modelBannerKind(sem({ accountOn: true, choice: 'on' }), acc({}))).toBeNull();
    expect(modelBannerKind(sem({ accountOn: true, choice: 'off' }), acc({}))).toBeNull();
    expect(modelBannerKind(sem({}), acc({}))).toBeNull();
  });
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render(s: Partial<SemanticState>, a: Partial<AccountSettingsState>) {
  const downloadHere = vi.fn(async () => undefined);
  const declineHere = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <AccountSettingsProvider store={accountStub(a)}>
        <SemanticProvider store={semanticStub({ available: true, downloadBytes: 34e6, ...s }, { downloadHere, declineHere })}>
          <ModelBanner />
        </SemanticProvider>
      </AccountSettingsProvider>,
    ),
  );
  return { downloadHere, declineHere };
}
const button = (name: string) => [...host!.querySelectorAll('button')].find((b) => b.textContent === name)!;

describe('ModelBanner', () => {
  it('explains the download and has no close button', () => {
    render({ accountOn: true }, {});
    expect(host!.textContent).toContain('Search by meaning is on for your account. This browser needs a one-time 34 MB download.');
    expect(host!.querySelector('[aria-label="Dismiss"]')).toBeNull();
    expect(host!.querySelector('[role="status"]')).not.toBeNull();
  });
  it('uses the Ask wording when only Ask is on', () => {
    render({}, { settings: { llm } });
    expect(host!.textContent).toContain('Ask finds better sources with search by meaning.');
  });
  it('Download and Not on this browser call the store', () => {
    const { downloadHere, declineHere } = render({ accountOn: true }, {});
    act(() => button('Download').click());
    expect(downloadHere).toHaveBeenCalled();
    act(() => button('Not on this browser').click());
    expect(declineHere).toHaveBeenCalled();
  });
  it('renders nothing when not needed', () => {
    render({ accountOn: true, choice: 'on' }, {});
    expect(host!.textContent).toBe('');
  });
});
