// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsProvider } from '../state/AccountSettingsContext';
import { accountStub } from '../test/account';
import { StoreProvider } from '../state/StoreContext';
import type { AppState, AppStore } from '../state/store';
import { askStub } from '../test/ask';
import { AskProvider } from './AskContext';
import { AskAnswer, askLitIds } from './AskAnswer';
import type { AskState, AskTurnView } from './askStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sources = [
  { noteId: 'a', vaultId: 'v', title: 'Deploy runbook', path: 'Work', text: 't', score: 0.9 },
  { noteId: 'b', vaultId: 'v', title: 'Rollback drill', path: 'Work / Ops', text: 't', score: 0.8 },
];
const turn = (p: Partial<AskTurnView>): AskTurnView => ({
  id: 1,
  question: 'How do I roll back?',
  answer: 'Flip it [[Deploy runbook]].',
  sources,
  cited: ['a'],
  via: 'meaning',
  status: 'done',
  error: null,
  ...p,
});

describe('askLitIds', () => {
  it('lights sources while streaming and only cited notes when done', () => {
    expect([...askLitIds({ turns: [turn({ status: 'streaming', cited: [] })], busy: true })]).toEqual(['a', 'b']);
    expect([...askLitIds({ turns: [turn({})], busy: false })]).toEqual(['a']);
    expect(askLitIds({ turns: [], busy: false }).size).toBe(0);
  });
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function render(state: Partial<AskState>, methods = {}) {
  const onSelect = vi.fn();
  const createNote = vi.fn(async () => ({ id: 'new' }));
  const appState = {
    vaults: { v: { id: 'v', name: 'Work' } },
    vaultOrder: ['v'],
    trees: {
      v: {
        folders: { f: { id: 'f', vaultId: 'v', parentId: null, name: 'Ops' } },
        notes: { a: { id: 'a', vaultId: 'v', folderId: null }, b: { id: 'b', vaultId: 'v', folderId: 'f' } },
      },
    },
  } as unknown as AppState;
  const app = { getState: () => appState, subscribe: () => () => undefined, createNote } as unknown as AppStore;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter>
        <StoreProvider store={app}>
          <AccountSettingsProvider store={accountStub()}>
            <AskProvider store={askStub(state, methods)}>
              <AskAnswer entries={[]} onSelect={onSelect} />
            </AskProvider>
          </AccountSettingsProvider>
        </StoreProvider>
      </MemoryRouter>,
    ),
  );
  return { onSelect, createNote };
}
const button = (name: string) => [...host!.querySelectorAll('button')].find((b) => b.textContent === name)!;

describe('AskAnswer', () => {
  it('renders the answer with citations that select the note on the map', () => {
    const { onSelect } = render({ turns: [turn({})] });
    const link = host!.querySelector<HTMLAnchorElement>('a.wl')!;
    expect(link.textContent).toBe('Deploy runbook');
    act(() => link.click());
    expect(onSelect).toHaveBeenCalledWith({ kind: 'note', vaultId: 'v', id: 'a' });
    expect(host!.textContent).toContain('1 source lit on the map');
  });
  it('renders links and images from the model as plain text', () => {
    const { onSelect } = render({ turns: [turn({ answer: 'A [x](https://evil.example) B [y](/settings) C ![pic](https://evil.example/x.png) D [[Deploy runbook]]' })] });
    expect(host!.querySelectorAll('a')).toHaveLength(1);
    expect(host!.querySelector('img')).toBeNull();
    expect(host!.querySelector('a[target]')).toBeNull();
    for (const w of ['x', 'y', 'pic']) expect(host!.querySelector('.ask-a')!.textContent).toContain(w);
    act(() => host!.querySelector<HTMLAnchorElement>('a.wl')!.click());
    expect(onSelect).toHaveBeenCalledWith({ kind: 'note', vaultId: 'v', id: 'a' });
  });
  it('does not link titles that are not sources', () => {
    render({ turns: [turn({ answer: 'See [[Elsewhere]].', cited: [] })] });
    expect(host!.querySelector('a.wl')).toBeNull();
  });
  it('shows the text fallback footer, the empty state and errors with Retry', () => {
    render({ turns: [turn({ via: 'text' })] });
    expect(host!.textContent).toContain('Found by text. Turn on search by meaning for better sources.');
    act(() => root!.unmount());
    host!.remove();
    render({ turns: [turn({ status: 'empty', answer: '' })] });
    expect(host!.textContent).toContain('No notes match closely enough.');
    act(() => root!.unmount());
    host!.remove();
    const retry = vi.fn(async () => undefined);
    render({ turns: [turn({ status: 'error', error: 'cut', answer: 'part' })] }, { retry });
    expect(host!.textContent).toContain('Answer cut off.');
    act(() => button('Retry').click());
    expect(retry).toHaveBeenCalled();
  });
  it('setup errors link to Settings', () => {
    render({ turns: [turn({ status: 'error', error: 'setup', answer: '' })] });
    expect(host!.querySelector('a[href="/settings"]')?.textContent).toBe('Set up Ask in Settings');
  });
  it('saves the answer as a note in the first cited note’s folder by default', async () => {
    const { createNote } = render({ turns: [turn({ cited: ['b'], answer: 'Use the drill [[Rollback drill]].' })] });
    act(() => button('Save as note').click());
    const select = host!.querySelector<HTMLSelectElement>('select')!;
    expect(select.value).toBe('v:f');
    await act(async () => button('Save').click());
    expect(createNote).toHaveBeenCalledWith('v', 'f', 'How do I roll back?', 'Use the drill [[Rollback drill]].\n\n## Sources\n\n- [[Rollback drill]]\n');
  });
});
