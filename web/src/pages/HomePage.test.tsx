// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { folder, note, tree, vault } from '../map/fixtures';
import { StoreProvider } from '../state/StoreContext';
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

function mount(initial: AppState) {
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
          <HomePage />
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
