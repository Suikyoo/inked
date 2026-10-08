// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folder, note, tree, vault } from '../map/fixtures';
import type { SemanticInput } from 'inked-core';
import { SemanticProvider } from '../semantic/SemanticContext';
import type { SemanticStore } from '../semantic/semanticStore';
import { StoreProvider } from '../state/StoreContext';
import { semanticStub } from '../test/semantic';
import type { AppState, AppStore } from '../state/store';
import { HomePage } from './HomePage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const baseState = (): AppState =>
  ({
    vaultsStatus: 'ready',
    vaults: { v1: vault('v1', 'Work') },
    vaultOrder: ['v1'],
    trees: {
      v1: tree(
        [folder('f1', null, 'Ops')],
        [note('n1', 'f1', 'Alpha'), note('n2', 'f1', 'Alphabet soup'), note('n3', null, 'Beta'), note('n4', 'f1', 'Gamma')],
      ),
    },
    bodies: { n1: 'Hello **bold**', n2: '', n3: '', n4: '' },
    bodiesReady: { v1: true },
  }) as unknown as AppState;

function mount(initial: AppState, semantic?: SemanticStore) {
  let state = initial;
  const listeners = new Set<() => void>();
  const store = {
    getState: () => state,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    loadAll: async () => undefined,
  } as unknown as AppStore;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter>
        <StoreProvider store={store}>
          <SemanticProvider store={semantic ?? semanticStub()}>
            <HomePage />
          </SemanticProvider>
        </StoreProvider>
      </MemoryRouter>,
    ),
  );
  return {
    set: (next: AppState) => {
      state = next;
      act(() => listeners.forEach((l) => l()));
    },
  };
}

const column = () => host!.querySelector('aside.results')!;
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
function type(value: string) {
  const input = host!.querySelector<HTMLInputElement>('input#q')!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const rows = () => [...host!.querySelectorAll<HTMLElement>('aside.results li')];
const titleOf = (li: Element) => li.querySelector('.res-title')?.textContent;

describe('HomePage right column', () => {
  it('shows the empty hint, and no Recently edited', () => {
    mount(baseState());
    expect(column().textContent).toContain('Select a folder or note on the map.');
    expect(host!.textContent).not.toContain('Recently edited');
  });

  it('previews the selected note, and returns to the hint when it is deleted', () => {
    const h = mount(baseState());
    click(host!.querySelector('g.cmap-node[data-note="n1"]')!);
    expect(column().textContent).toContain('Alpha');
    expect(column().querySelector('.md strong')?.textContent).toBe('bold');
    const s = baseState();
    delete s.trees.v1!.notes.n1;
    h.set(s);
    expect(column().textContent).toContain('Select a folder or note on the map.');
    expect(column().querySelector('.preview')).toBeNull();
  });

  it('keeps no preview text after a lock clears trees and bodies', () => {
    const h = mount(baseState());
    click(host!.querySelector('g.cmap-node[data-note="n1"]')!);
    expect(column().textContent).toContain('bold');
    h.set({ ...baseState(), trees: {}, bodies: {}, bodiesReady: {} });
    expect(column().querySelector('.preview')).toBeNull();
    expect(column().textContent).not.toContain('bold');
    expect(column().textContent).not.toContain('Alpha');
  });

  it('a query takes over from the selection, and the preview returns when it clears', () => {
    mount(baseState());
    click(host!.querySelector('g.cmap-node[data-note="n1"]')!);
    type('beta');
    expect(column().querySelector('.preview')).toBeNull();
    expect(rows().map(titleOf)).toContain('Beta');
    type('');
    expect(column().querySelector('.preview')).not.toBeNull();
  });

  it('marks only rows that newly enter the result set with data-new', () => {
    mount(baseState());
    type('alpha');
    const first = rows().filter((r) => r.querySelector('a.res'));
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((r) => r.hasAttribute('data-new'))).toBe(true);
    const had = new Set(first.map(titleOf));
    // The entry animation ends; the flags are spent.
    act(() => rows().forEach((r) => void r.dispatchEvent(new Event('animationend', { bubbles: true }))));
    type('alph');
    type('a');
    const after = rows().filter((r) => r.querySelector('a.res'));
    expect(after.length).toBeGreaterThan(first.length);
    for (const r of after) expect(r.hasAttribute('data-new')).toBe(!had.has(titleOf(r)));
  });

  it('staggers only the first reveal, capped at 8 rows', () => {
    const many = baseState();
    many.trees.v1 = tree([], Array.from({ length: 12 }, (_, i) => note(`m${i}`, null, `Memo ${i}`)));
    many.bodies = {};
    mount(many);
    type('memo');
    const idx = rows()
      .filter((r) => r.querySelector('a.res'))
      .map((r) => Number(r.style.getPropertyValue('--i')));
    expect(idx.slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(Math.max(...idx)).toBe(7);
    act(() => rows().forEach((r) => void r.dispatchEvent(new Event('animationend', { bubbles: true }))));
    type('memo 1');
    expect(rows().every((r) => r.style.getPropertyValue('--i') === '')).toBe(true);
  });

  it('keeps data-new and --i through re-renders inside the animation window', () => {
    mount(baseState());
    type('alpha');
    const snap = () => rows().filter((r) => r.querySelector('a.res')).map((r) => [r.hasAttribute('data-new'), r.style.getPropertyValue('--i')]);
    const before = snap();
    expect(before[0]).toEqual([true, '0']);
    // A hover sets the hot note and re-renders; so does a store update.
    act(() => void host!.querySelector('a.res')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    expect(snap()).toEqual(before);
    type('alpha');
    expect(snap()).toEqual(before);
  });
});

describe('HomePage search by meaning', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  const ready = { phase: 'ready', enabled: true, available: true, coverage: { v1: { done: 1, total: 2 } } } as const;
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const sem = (results: () => Promise<SemanticInput[]>, state: Parameters<typeof semanticStub>[0] = ready) => {
    const search = vi.fn(results);
    return { search, store: semanticStub(state, { search, chunkText: () => 'Gamma talks about cars\nsecond line' }) };
  };

  it('adds a meaning row tagged "◇ meaning" after the 250 ms debounce', async () => {
    const { search, store } = sem(async () => [{ noteId: 'n4', similarity: 0.8, chunk: 0 }]);
    mount(baseState(), store);
    type('car');
    expect(search).not.toHaveBeenCalled();
    await advance(250);
    expect(search).toHaveBeenCalledTimes(1);
    const row = rows().find((r) => titleOf(r)?.endsWith('Gamma'))!;
    expect(row.querySelector('.res-why')?.textContent).toBe('◇ meaning');
    expect(row.querySelector('.res-snippet')?.textContent).toBe('Gamma talks about cars');
  });

  it('notes how much of the vault meaning covers, and shows the indexing bar', async () => {
    const { store } = sem(async () => []);
    mount(baseState(), store);
    type('car');
    await advance(250);
    expect(column().querySelector('.results-title')?.textContent).toContain('meaning covers 1 of 2 notes');
    expect(host!.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(host!.querySelector('.progress-label')?.textContent).toBe('Indexing by meaning · 1 / 2');
  });

  it('shows the model download in the bar', () => {
    const { store } = sem(async () => [], { phase: 'downloading', enabled: true, download: { loaded: 12e6, total: 90e6 } });
    mount(baseState(), store);
    expect(host!.querySelector('.progress-label')?.textContent).toBe('Downloading model · 12 / 90 MB');
  });

  it('shows no bar while the model loads', () => {
    const { store } = sem(async () => [], { phase: 'loading', enabled: true });
    mount(baseState(), store);
    expect(host!.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('does not reorder rows under focus, and applies the new order on blur', async () => {
    let resolve!: (r: SemanticInput[]) => void;
    const { store } = sem(() => new Promise<SemanticInput[]>((r) => (resolve = r)));
    mount(baseState(), store);
    type('alpha');
    await advance(250);
    const titles = () => rows().filter((r) => r.querySelector('a.res')).map(titleOf);
    const before = titles();
    expect(before.some((t) => t?.endsWith('Gamma'))).toBe(false);
    act(() => host!.querySelector<HTMLAnchorElement>('a.res')!.focus());
    await act(async () => resolve([{ noteId: 'n4', similarity: 0.9, chunk: 0 }]));
    expect(titles()).toEqual(before);
    act(() => host!.querySelector<HTMLInputElement>('input#q')!.focus());
    expect(titles().some((t) => t?.endsWith('Gamma'))).toBe(true);
  });

  it('never searches by meaning unless the model is ready', async () => {
    const { search, store } = sem(async () => [], { phase: 'off', enabled: false, available: true });
    mount(baseState(), store);
    type('alpha');
    await advance(1000);
    expect(search).not.toHaveBeenCalled();
  });

  it('aborts the previous semantic query when a newer one starts', async () => {
    const signals: AbortSignal[] = [];
    const search = vi.fn(async (_q: string, signal?: AbortSignal) => {
      signals.push(signal!);
      return [] as SemanticInput[];
    });
    mount(baseState(), semanticStub(ready, { search }));
    type('car');
    await advance(250);
    type('cars');
    expect(signals[0].aborted).toBe(true);
    await advance(250);
    expect(search).toHaveBeenCalledTimes(2);
  });
});

describe('HomePage meaning neighbours', () => {
  it('asks for three neighbours among the map dots, and keeps the same lookup until the vectors change', () => {
    const neighbours = vi.fn<SemanticStore['neighbours']>(() => []);
    mount(baseState(), semanticStub({}, { neighbours }));
    click(host!.querySelector('g.cmap-node[data-note="n1"]')!);
    expect(neighbours).toHaveBeenCalled();
    const mapCalls = () => neighbours.mock.calls.filter((c) => c[2]);
    const [id, k, among] = mapCalls().at(-1)!;
    expect([id, k]).toEqual(['n1', 3]);
    expect([...among!].sort()).toEqual(['n1', 'n2', 'n3', 'n4']);
    // Typing a query with no hits re-renders Home but changes neither the focus nor the map: no new lookups.
    const calls = mapCalls().length;
    type('zzzz');
    expect(mapCalls()).toHaveLength(calls);
  });
});
