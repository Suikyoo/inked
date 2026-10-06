// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { NoteView, TreeView } from '../state/store';
import { ConceptMap, type ConceptMapProps } from './ConceptMap';
import { folder, note, tree, vault } from './fixtures';
import { buildVaultGraph } from './graph';
import { layoutVault } from './layout';
import { buildScene, nearestInDirection } from './scene';
import type { MapEntry } from './useVaultGraphs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-10-07T12:00:00.000Z');

function entry(t: TreeView, id = 'v1'): MapEntry {
  const graph = buildVaultGraph(id, t, {}, true);
  return { vaultId: id, vault: vault(id), status: t.status, level: 0, graph, layout: layoutVault(graph) };
}
const base = () =>
  tree(
    [folder('f1', null, 'Ops'), folder('f2', 'f1', 'Runbooks')],
    [note('n1', 'f1', 'Alpha'), note('n2', 'f2', 'Beta'), note('n3', null, 'Gamma'), note('n4', 'f1', 'Delta', { broken: true })],
  );

let root: Root | null = null;
let host: HTMLElement | null = null;

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
function ui(p: Partial<ConceptMapProps> & { entries: MapEntry[] }) {
  return (
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<ConceptMap hits={new Set()} hot={null} loading={false} now={NOW} {...p} />} />
        <Route path="/v/:v/n/:n" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
}
function render(p: Partial<ConceptMapProps> & { entries: MapEntry[] }) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui(p)));
  return { rerender: (q: Partial<ConceptMapProps> & { entries: MapEntry[] }) => act(() => root!.render(ui(q))) };
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const nodes = () => [...host!.querySelectorAll<SVGGElement>('g.cmap-node')];
const node = (id: string) => host!.querySelector<SVGGElement>(`g.cmap-node[data-note="${id}"]`)!;
const svg = () => host!.querySelector<SVGSVGElement>('svg.cmap-svg')!;
const fire = (el: Element, ev: Event) => act(() => void el.dispatchEvent(ev));
const click = (el: Element) => fire(el, new MouseEvent('click', { bubbles: true }));
const key = (el: Element, k: string) => fire(el, new KeyboardEvent('keydown', { key: k, bubbles: true }));
const pointer = (type: string, x: number, y: number) =>
  fire(svg(), new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
const translate = (el: Element) => {
  const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(el.getAttribute('transform') ?? '');
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
};

describe('ConceptMap', () => {
  it('draws one dot per non-broken note', () => {
    render({ entries: [entry(base())] });
    expect(nodes().map((n) => n.dataset.note).sort()).toEqual(['n1', 'n2', 'n3']);
  });

  it('clicking a dot selects it and shows the slip', () => {
    render({ entries: [entry(base())] });
    click(node('n1'));
    const slip = host!.querySelector('.cmap-slip');
    expect(slip?.textContent).toContain('Alpha');
    expect(slip?.textContent).toContain('Ops');
    expect(slip?.textContent).toContain('Open note →');
  });

  it('Enter on a dot opens the note', () => {
    render({ entries: [entry(base())] });
    key(node('n2'), 'Enter');
    expect(host!.querySelector('[data-testid="where"]')?.textContent).toBe('/v/v1/n/n2');
  });

  it('Escape clears the selection', () => {
    render({ entries: [entry(base())] });
    click(node('n1'));
    key(node('n1'), 'Escape');
    expect(host!.querySelector('.cmap-slip')).toBeNull();
  });

  it('a search fades the notes that do not match', () => {
    render({ entries: [entry(base())], hits: new Set(['n1']) });
    expect(node('n1').classList.contains('is-faded')).toBe(false);
    expect(node('n2').classList.contains('is-faded')).toBe(true);
    expect(host!.querySelectorAll('.cmap-ink path').length).toBe(1);
  });

  it('ArrowRight moves the roving focus to the nearest dot on the right', () => {
    const ring = tree([], Array.from({ length: 8 }, (_, i) => note(`r${i}`, null, `r${i}`)) as NoteView[]);
    const e = entry(ring);
    render({ entries: [e] });
    const dots = buildScene([e]).dots;
    const leftmost = dots.reduce((a, b) => (b.x < a.x ? b : a));
    const expected = nearestInDirection(leftmost, dots, 'right');
    expect(expected).not.toBeNull();
    fire(node(leftmost.id), new FocusEvent('focusin', { bubbles: true }));
    key(node(leftmost.id), 'ArrowRight');
    expect(node(expected!).getAttribute('tabindex')).toBe('0');
    expect(nodes().filter((n) => n.getAttribute('tabindex') === '0')).toHaveLength(1);
  });

  it('a drag pans the map and does not select the dot it ends on (Review Focus 4)', () => {
    render({ entries: [entry(base())] });
    const before = translate(node('n1'))!;
    pointer('pointerdown', 100, 100);
    pointer('pointermove', 130, 110);
    pointer('pointerup', 130, 110);
    click(node('n1'));
    expect(host!.querySelector('.cmap-slip')).toBeNull();
    const after = translate(node('n1'))!;
    expect(after.x - before.x).toBeCloseTo(30, 0);
    expect(after.y - before.y).toBeCloseTo(10, 0);
  });

  it('refits when a loading vault becomes ready (Review Focus 3)', () => {
    const { rerender } = render({ entries: [entry(tree([], [], 'loading'))], loading: true });
    expect(host!.querySelector('.cmap-msg')?.textContent).toBe('Decrypting your notes…');
    rerender({ entries: [entry(base())], loading: false });
    expect(host!.querySelector('.cmap-msg')).toBeNull();
    for (const n of nodes()) {
      const p = translate(n)!;
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(800);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(480);
    }
  });

  it('shows an empty vault as a hub alone, and says when a vault failed to load', () => {
    render({ entries: [entry(tree([], [])), entry(tree([], [], 'error'), 'v2')] });
    expect(nodes()).toHaveLength(0);
    expect(host!.textContent).toContain('Vault v1');
    expect(host!.querySelector('.cmap-hub-note')?.textContent).toBe('Couldn’t load');
  });
  it('focus state clears on blur, and the roving dot falls back to the most recent note', () => {
    const t = base();
    t.notes.n3 = { ...t.notes.n3, updatedAt: '2026-10-07T11:00:00.000Z' };
    render({ entries: [entry(t)] });
    click(node('n1'));
    fire(node('n1'), new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    click(svg());
    expect(node('n1').querySelector('.cmap-label')).toBeNull();
    expect(node('n1').querySelector('.cmap-dot')?.getAttribute('r')).toBe('4');
    expect(nodes().filter((n) => n.getAttribute('tabindex') === '0').map((n) => n.dataset.note)).toEqual(['n3']);
  });

  it('focusing a dot that is off screen pans it into view', () => {
    render({ entries: [entry(base())] });
    pointer('pointerdown', 100, 100);
    pointer('pointermove', 2100, 100);
    pointer('pointerup', 2100, 100);
    const roving = nodes().find((n) => n.getAttribute('tabindex') === '0')!;
    expect(translate(roving)!.x).toBeGreaterThan(800);
    fire(roving, new FocusEvent('focusin', { bubbles: true }));
    const p = translate(node(roving.dataset.note!))!;
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(800);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeLessThanOrEqual(480);
  });
});
