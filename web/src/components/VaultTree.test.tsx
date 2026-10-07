// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StoreProvider } from '../state/StoreContext';
import type { AppStore, FolderView, NoteView, TreeView, VaultView } from '../state/store';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cssRules } from '../styles/cssRules';
import { VaultTree } from './VaultTree';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Resolved from this file, not the cwd. (A `?raw` import comes back empty: vitest stubs CSS.)
const shellCss = readFileSync(join(import.meta.dirname, '../styles/shell.css'), 'utf8');

const T = '2026-01-01T00:00:00.000Z';
const vault = { id: 'v1', name: 'Vault', color: '', createdAt: T, updatedAt: T, noteCount: 0, activeNoteCount7d: 0 } as VaultView;
const folder = (id: string, name: string, parentId: string | null = null): FolderView => ({
  id,
  vaultId: 'v1',
  parentId,
  name,
  createdAt: T,
  updatedAt: T,
});
const note = (id: string, title: string, folderId: string | null, createdAt = T): NoteView => ({
  id,
  vaultId: 'v1',
  folderId,
  title,
  size: 1,
  createdAt,
  updatedAt: T,
});
const treeOf = (folders: FolderView[], notes: NoteView[]): TreeView => ({
  status: 'ready',
  folders: Object.fromEntries(folders.map((f) => [f.id, f])),
  notes: Object.fromEntries(notes.map((n) => [n.id, n])),
});

let root: Root;
let host: HTMLElement;
let loc: { pathname: string; state: unknown };
function Probe() {
  const l = useLocation();
  loc = { pathname: l.pathname, state: l.state };
  return null;
}

function mount(tree: TreeView, opts: { path?: string; activeNoteId?: string | null; store?: Partial<AppStore>; startOpen?: string[]; signal?: number } = {}) {
  const store = (opts.store ?? {}) as AppStore;
  function Harness({ signal }: { signal: number }) {
    const [expanded, setExpanded] = useState(new Set<string>(opts.startOpen ?? []));
    return (
      <VaultTree
        vault={vault}
        tree={tree}
        activeNoteId={opts.activeNoteId ?? null}
        expanded={expanded}
        setExpanded={(fn) => setExpanded((s) => fn(s))}
        newFolderSignal={signal}
      />
    );
  }
  const render = (signal: number) =>
    act(() =>
      root.render(
        <MemoryRouter initialEntries={[opts.path ?? '/v/v1']}>
          <StoreProvider store={store}>
            <Probe />
            <Harness signal={signal} />
          </StoreProvider>
        </MemoryRouter>,
      ),
    );
  render(0);
  return { render };
}

beforeEach(() => {
  // jsdom has no <dialog>.close(); the Dialog falls back to the open attribute for show.
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
});

const row = (id: string) => host.querySelector<HTMLElement>(`[data-id="${id}"] > .tree-row`)!;
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

const base = () =>
  treeOf(
    [folder('f1', 'Notes')],
    [note('idx', 'Index', 'f1', '2026-01-02T00:00:00.000Z'), note('a', 'Alpha', 'f1'), note('z', 'Zeta', 'f1', '2026-01-03T00:00:00.000Z')],
  );

describe('Index row', () => {
  it('renders first in its folder with the tree-index class, diamond and label', () => {
    // 'Index' sorts after 'Alpha' alphabetically; it must still come first.
    mount(base(), { startOpen: ['f1'] });
    const rows = [...host.querySelectorAll('[data-id="f1"] .tree-group > li')].map((li) => li.getAttribute('data-id'));
    expect(rows).toEqual(['idx', 'a', 'z']);
    const r = row('idx');
    expect(r.classList.contains('tree-index')).toBe(true);
    const glyph = r.querySelector('svg.index-icon')!;
    expect(glyph).not.toBeNull();
    // An outline ◇: stroked in currentColor (--ink-light from .tree-chev), never filled.
    expect(glyph.getAttribute('fill')).toBe('none');
    expect(glyph.getAttribute('stroke')).toBe('currentColor');
    expect(glyph.querySelector('path')!.hasAttribute('fill')).toBe(false);
    expect(r.querySelector('.tree-label')?.textContent).toBe('Index');
    expect(row('a').classList.contains('tree-index')).toBe(false);
  });
});

describe('expanding opens the Index', () => {
  it('navigates to the Index when a collapsed folder is expanded', () => {
    mount(base());
    click(row('f1'));
    expect(loc.pathname).toBe('/v/v1/n/idx');
  });

  it('does not navigate when the open note is inside the folder', () => {
    mount(base(), { path: '/v/v1/n/a', activeNoteId: 'a' });
    // The active note's ancestors auto-expand; collapse then expand again by the user.
    click(row('f1'));
    expect(loc.pathname).toBe('/v/v1/n/a');
    click(row('f1'));
    expect(loc.pathname).toBe('/v/v1/n/a');
  });

  it('never navigates on collapse', () => {
    mount(base(), { startOpen: ['f1'] });
    click(row('f1'));
    expect(loc.pathname).toBe('/v/v1');
  });

  it('does not navigate for a folder without an Index', () => {
    mount(treeOf([folder('f1', 'Notes')], [note('a', 'Alpha', 'f1')]));
    click(row('f1'));
    expect(loc.pathname).toBe('/v/v1');
  });

  it('keeps collapsed children mounted but marks the group closed', () => {
    mount(base());
    const wrap = host.querySelector('[data-id="f1"] .tree-collapse')!;
    expect(wrap.getAttribute('data-open')).toBe('false');
    click(row('f1'));
    expect(host.querySelector('[data-id="f1"] .tree-collapse')!.getAttribute('data-open')).toBe('true');
  });
});

describe('nested collapse', () => {
  it('a closed ancestor wraps an open descendant; only closed wrappers set visibility', () => {
    const open = cssRules(shellCss, ".tree-collapse[data-open='true']");
    const closed = cssRules(shellCss, ".tree-collapse[data-open='false']");
    expect(open).toHaveLength(1);
    expect(open[0]).not.toContain('visibility');
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatch(/(^|;)visibility:hidden(;|$)/);

    mount(
      treeOf([folder('a', 'A'), folder('b', 'B', 'a')], [note('bn', 'Deep', 'b')]),
      { startOpen: ['b'] },
    );
    const outer = host.querySelector('[data-id="a"] > .tree-collapse')!;
    const inner = host.querySelector('[data-id="b"] > .tree-collapse')!;
    expect(outer.getAttribute('data-open')).toBe('false');
    expect(inner.getAttribute('data-open')).toBe('true');
    expect(outer.contains(inner)).toBe(true);
  });
});

describe('creating a folder', () => {
  it('opens the new Index in edit mode', async () => {
    const created = folder('new', 'Fresh');
    const tree = treeOf([created], [note('newidx', 'Index', 'new')]);
    const store = {
      createFolder: vi.fn(async () => created),
      getState: () => ({ trees: { v1: tree } }),
    } as unknown as Partial<AppStore>;
    const { render } = mount(treeOf([], [note('x', 'X', null)]), { store });
    render(1);
    const input = document.querySelector<HTMLInputElement>('#prompt-input')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, 'Fresh');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => void input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(loc.pathname).toBe('/v/v1/n/newidx');
    expect(loc.state).toEqual({ mode: 'edit' });
  });
});
