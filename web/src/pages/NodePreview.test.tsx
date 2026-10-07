// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { folder, note, tree, vault } from '../map/fixtures';
import type { MapSelection } from '../map/ConceptMap';
import { StoreProvider } from '../state/StoreContext';
import type { AppState, AppStore } from '../state/store';
import { NodePreview } from './NodePreview';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const NOW = new Date().toISOString();
export function makeState(over: Partial<AppState> = {}): AppState {
  const t = tree(
    [folder('f1', null, 'Ops'), folder('f2', 'f1', 'Runbooks'), folder('f3', null, 'Bare')],
    [
      note('n1', 'f1', 'Alpha', { updatedAt: NOW }),
      note('n2', 'f1', 'Index'),
      note('n3', null, 'Index'),
      note('n4', 'f1', 'Linker'),
      note('n5', null, 'Loose'),
    ],
  );
  return {
    vaultsStatus: 'ready',
    vaults: { v1: vault('v1', 'Work') },
    vaultOrder: ['v1'],
    trees: { v1: t },
    bodies: { n1: 'Hello **bold** [[Linker]]\n\n- [ ] todo', n2: '# Ops\n\nThe *ops* folder.', n3: 'Root **desc**', n4: 'see [[Alpha]]', n5: '' },
    bodiesReady: { v1: true },
    ...over,
  } as unknown as AppState;
}

function Where() {
  const l = useLocation();
  return (
    <p data-testid="where" data-state={JSON.stringify(l.state)}>
      {l.pathname}
    </p>
  );
}

function mount(state: AppState, selection: MapSelection, store: Partial<AppStore> = {}, onZoom = vi.fn()) {
  const full = { getState: () => state, subscribe: () => () => undefined, ...store } as unknown as AppStore;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={['/']}>
        <StoreProvider store={full}>
          <Routes>
            <Route path="/" element={<NodePreview selection={selection} onZoom={onZoom} />} />
            <Route path="/v/:v/n/:n" element={<Where />} />
          </Routes>
        </StoreProvider>
      </MemoryRouter>,
    ),
  );
  return onZoom;
}
const text = () => host!.textContent ?? '';
const link = (label: string) => [...host!.querySelectorAll('a')].find((a) => a.textContent === label);
const button = (label: string) => [...host!.querySelectorAll('button')].find((b) => b.textContent === label);
const click = (el: Element | undefined) => act(() => void el!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
const where = () => host!.querySelector('[data-testid=where]');

describe('NodePreview', () => {
  it('note: title, folder path, edited, markdown, backlinks and actions', () => {
    mount(makeState(), { kind: 'note', vaultId: 'v1', id: 'n1' });
    expect(text()).toContain('Alpha');
    expect(text()).toContain('Work / Ops');
    expect(text()).toContain('edited');
    expect(host!.querySelector('.md strong')?.textContent).toBe('bold');
    expect(host!.querySelector('.preview-backlinks')?.textContent).toContain('Linker');
    expect(link('Open note')?.getAttribute('href')).toBe('/v/v1/n/n1');
    expect(link('Edit')?.getAttribute('href')).toBe('/v/v1/n/n1');
  });

  it('note: Edit opens the note in edit mode without the fresh (title-select) state', () => {
    mount(makeState(), { kind: 'note', vaultId: 'v1', id: 'n1' });
    click(link('Edit'));
    expect(where()?.getAttribute('data-state')).toBe('{"mode":"edit"}');
  });

  it('note: a wiki-link in the body routes in-app', () => {
    mount(makeState(), { kind: 'note', vaultId: 'v1', id: 'n1' });
    const a = host!.querySelector<HTMLAnchorElement>('.md a[data-wikilink]')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    act(() => void a.dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(true);
    expect(where()?.textContent).toBe('/v/v1/n/n4');
  });

  it('note: task checkboxes are read-only in the preview', () => {
    mount(makeState(), { kind: 'note', vaultId: 'v1', id: 'n1' });
    const box = host!.querySelector<HTMLInputElement>('.md input.task-checkbox')!;
    expect(box.checked).toBe(false);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    act(() => void box.dispatchEvent(ev));
    expect(ev.defaultPrevented).toBe(true);
    expect(box.checked).toBe(false);
  });

  it('note: body not decrypted yet shows Decrypting…', () => {
    mount(makeState({ bodies: {}, bodiesReady: {} }), { kind: 'note', vaultId: 'v1', id: 'n1' });
    expect(text()).toContain('Decrypting…');
    expect(host!.querySelector('.md')).toBeNull();
  });

  it('folder with Index: Index body, counts, notes without the Index, actions', () => {
    const onZoom = mount(makeState(), { kind: 'folder', vaultId: 'v1', id: 'f1' });
    expect(host!.querySelector('.md em')?.textContent).toBe('ops');
    expect(text()).toContain('2 notes');
    expect(text()).toContain('1 subfolder');
    expect([...host!.querySelectorAll('.preview-notes a')].map((a) => a.textContent)).toEqual(['Alpha', 'Linker']);
    expect(link('Open Index')?.getAttribute('href')).toBe('/v/v1/n/n2');
    expect(button('New note here')).toBeTruthy();
    click(button('Zoom to folder'));
    expect(onZoom).toHaveBeenCalledWith({ kind: 'folder', vaultId: 'v1', id: 'f1' });
  });

  it('folder without Index: Add description calls the store', () => {
    const addDescription = vi.fn().mockResolvedValue(note('nx', 'f3', 'Index'));
    mount(makeState(), { kind: 'folder', vaultId: 'v1', id: 'f3' }, { addDescription } as unknown as Partial<AppStore>);
    expect(link('Open Index')).toBeUndefined();
    click(button('Add description'));
    expect(addDescription).toHaveBeenCalledWith('v1', 'f3');
  });

  it('New note here creates a note in the folder and opens it', async () => {
    const createNote = vi.fn().mockResolvedValue(note('nz', 'f1', 'Untitled'));
    mount(makeState(), { kind: 'folder', vaultId: 'v1', id: 'f1' }, { createNote } as unknown as Partial<AppStore>);
    await act(async () => void click(button('New note here')));
    expect(createNote).toHaveBeenCalledWith('v1', 'f1', 'Untitled');
    expect(where()?.textContent).toBe('/v/v1/n/nz');
  });

  it('hub uses the root Index', () => {
    mount(makeState(), { kind: 'hub', vaultId: 'v1' });
    expect(host!.querySelector('.md strong')?.textContent).toBe('desc');
    expect(text()).toContain('Work');
    expect(link('Open Index')?.getAttribute('href')).toBe('/v/v1/n/n3');
    expect([...host!.querySelectorAll('.preview-notes a')].map((a) => a.textContent)).toEqual(['Loose']);
  });
});
