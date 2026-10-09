// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsProvider } from '../state/AccountSettingsContext';
import type { AccountSettingsState } from '../state/accountSettings';
import { accountStub } from '../test/account';
import { AskSettings } from './SettingsAsk';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function render(state: Partial<AccountSettingsState>, fetchImpl?: typeof fetch) {
  const update = vi.fn(async () => undefined);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <AccountSettingsProvider store={accountStub({ llmOrigins: ['https://api.openai.com'], ...state }, { update })}>
        <AskSettings fetchImpl={fetchImpl} />
      </AccountSettingsProvider>,
    ),
  );
  return { update };
}
const field = (label: string) => {
  const l = [...host!.querySelectorAll('label')].find((x) => x.textContent === label)!;
  return document.getElementById(l.htmlFor) as HTMLInputElement;
};
const button = (name: string) => [...host!.querySelectorAll('button')].find((b) => b.textContent === name)!;
function type(el: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function fill(base: string) {
  type(field('Base URL'), base);
  type(field('Model'), 'gpt-4o-mini');
  type(field('API key'), 'sk-x');
}

describe('AskSettings', () => {
  it('is hidden when the deployment allows no provider', () => {
    render({ llmOrigins: [] });
    expect(host!.textContent).toBe('');
  });
  it('states what leaves the browser', () => {
    render({});
    expect(host!.textContent).toContain('Questions and matching note excerpts are sent to https://api.openai.com. Nothing else leaves this browser.');
  });
  it('keeps the API key masked and out of autofill', () => {
    render({});
    expect(field('API key').type).toBe('password');
    expect(field('API key').autocomplete).toBe('off');
  });
  it('refuses a base URL outside the allowed origins', async () => {
    const { update } = render({});
    fill('https://evil.example/v1');
    await act(async () => button('Save').click());
    expect(host!.textContent).toContain('This deployment only allows: https://api.openai.com.');
    expect(update).not.toHaveBeenCalled();
  });
  it('saves through the account store', async () => {
    const { update } = render({});
    fill('https://api.openai.com/v1');
    await act(async () => button('Save').click());
    const change = (update.mock.calls[0] as unknown as [(s: object) => object])[0];
    expect(change({ semantic: true })).toEqual({ semantic: true, llm: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-x' } });
  });
  it('clears through the account store', async () => {
    const { update } = render({ settings: { semantic: true, llm: { baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k' } } });
    await act(async () => button('Clear').click());
    const change = (update.mock.calls[0] as unknown as [(s: object) => object])[0];
    expect(change({ semantic: true, llm: { baseUrl: 'b', model: 'm', apiKey: 'k' } })).toEqual({ semantic: true });
  });
  it('Test reports Connected or the error', async () => {
    const ok = vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', { status: 200 }));
    render({ settings: { llm: { baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k' } } }, ok as never);
    await act(async () => button('Test').click());
    expect(host!.textContent).toContain('Connected');
    act(() => root!.unmount());
    host!.remove();
    const bad = vi.fn(async () => new Response('{}', { status: 401 }));
    render({ settings: { llm: { baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k' } } }, bad as never);
    await act(async () => button('Test').click());
    expect(host!.textContent).toContain('Your API key was rejected. Check Settings.');
  });
  it('names the first allowed origin, not a disallowed typed one', () => {
    render({});
    type(field('Base URL'), 'https://evil.example/v1');
    expect(host!.textContent).toContain('sent to https://api.openai.com.');
    expect(host!.textContent).not.toContain('evil.example');
  });
  it('Test with a disallowed base URL refuses and never calls fetch', async () => {
    const f = vi.fn();
    render({}, f as never);
    fill('https://evil.example/v1');
    await act(async () => button('Test').click());
    expect(host!.textContent).toContain('This deployment only allows: https://api.openai.com.');
    expect(f).not.toHaveBeenCalled();
  });
  it('Test shows fixed copy, never raw error text, for a thrown fetch', async () => {
    const f = vi.fn(async () => {
      throw new Error('secret-detail');
    });
    render({ settings: { llm: { baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k' } } }, f as never);
    await act(async () => button('Test').click());
    expect(host!.textContent).not.toContain('secret-detail');
    expect(host!.textContent).toContain('Couldn’t reach https://api.openai.com.');
  });
  it('says so when saved settings could not be read', () => {
    render({ unreadable: true });
    expect(host!.textContent).toContain('Saved Ask settings couldn’t be read. Enter them again.');
  });
});
