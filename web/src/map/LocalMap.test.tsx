// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { folder, note, tree } from './fixtures';
import { buildVaultGraph, type VaultGraph } from './graph';
import { LocalMap } from './LocalMap';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
function render(graph: VaultGraph, noteId = 'c') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<LocalMap graph={graph} noteId={noteId} vaultName="Work" vaultColor="#9d7cf2" level={0.5} />} />
          <Route path="/v/:v/n/:n" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const graph = (ready = true) =>
  buildVaultGraph(
    'v1',
    tree([folder('f1', null, 'Ops')], [note('c', 'f1', 'c'), note('s1', 'f1', 's1'), note('s2', 'f1', 's2'), note('o1', null, 'o1'), note('i1', null, 'i1')]),
    { c: '[[o1]]', i1: '[[c]]' },
    ready,
  );
const row = (id: string) => host!.querySelector<SVGGElement>(`g.cmap-node[data-note="${id}"]`);

describe('LocalMap', () => {
  it('puts links in, siblings and links out in three columns', () => {
    render(graph());
    expect(row('i1')?.dataset.kind).toBe('incoming');
    expect(row('i1')?.getAttribute('transform')).toMatch(/^translate\(12 /);
    expect(row('s1')?.getAttribute('transform')).toMatch(/^translate\(117 /);
    expect(row('o1')?.getAttribute('transform')).toMatch(/^translate\(222 /);
    expect(row('c')).toBeNull();
    expect(host!.textContent).toContain('Ops');
  });

  it('clicking a neighbour opens it', () => {
    render(graph());
    act(() => void row('o1')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(host!.querySelector('[data-testid="where"]')?.textContent).toBe('/v/v1/n/o1');
  });

  it('caps a column and says how many more there are', () => {
    const sibs = Array.from({ length: 15 }, (_, i) => note(`s${i}`, 'f1', `s${i}`));
    render(buildVaultGraph('v1', tree([folder('f1', null)], [note('c', 'f1', 'c'), ...sibs]), {}, true));
    expect(host!.querySelectorAll('g.cmap-node[data-kind="siblings"]')).toHaveLength(12);
    expect(host!.querySelector('.lmap-more')?.textContent).toBe('+3 more');
  });

  it('says when links are still being drawn, and when there are no neighbours', () => {
    render(graph(false));
    expect(host!.querySelector('.lmap-msg')?.textContent).toBe('Drawing links…');
    act(() => root?.unmount());
    host?.remove();
    render(buildVaultGraph('v1', tree([], [note('c', null)]), {}, true));
    expect(host!.querySelector('.lmap-msg')?.textContent).toBe('No neighbours yet');
  });
});
