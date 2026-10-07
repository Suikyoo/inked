// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
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

  it('zoom keys with Ctrl, Meta or Alt held pass through to the browser (F2)', () => {
    render({ entries: [entry(base())] });
    const before = node('n1').getAttribute('transform');
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      for (const k of ['-', '+', '=', '0']) {
        const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, [mod]: true });
        fire(node('n1'), ev);
        expect(ev.defaultPrevented).toBe(false);
        expect(node('n1').getAttribute('transform')).toBe(before);
      }
    }
    const plain = new KeyboardEvent('keydown', { key: '-', bubbles: true, cancelable: true });
    fire(node('n1'), plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(node('n1').getAttribute('transform')).not.toBe(before);
  });

  it('Ctrl, Meta or Alt + Arrow on a dot passes through and does not move the roving focus (M2)', () => {
    const ring = tree([], Array.from({ length: 8 }, (_, i) => note(`r${i}`, null, `r${i}`)) as NoteView[]);
    render({ entries: [entry(ring)] });
    const rovingIds = () => nodes().filter((n) => n.getAttribute('tabindex') === '0').map((n) => n.dataset.note);
    const before = rovingIds();
    for (const mod of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      for (const k of ['ArrowRight', 'ArrowLeft']) {
        const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, [mod]: true });
        fire(node(before[0]!), ev);
        expect(ev.defaultPrevented).toBe(false);
        expect(rovingIds()).toEqual(before);
      }
    }
    const plain = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    fire(node(before[0]!), plain);
    expect(plain.defaultPrevented).toBe(true);
  });

  describe('folder labels (M1)', () => {
    const folderLabels = () => [...host!.querySelectorAll('.cmap-folders text')].map((t) => t.textContent);
    const wide = () =>
      tree([folder('f1', null, 'Ops'), folder('f2', 'f1', 'Runbooks'), folder('f3', null, 'Other')], [note('n1', 'f2', 'Alpha'), note('n2', 'f3', 'Beta'), note('n3', null, 'Gamma')]);
    const props = (p: Partial<ConceptMapProps> = {}) => ({ entries: [entry(wide())], ...p });
    /** Renders in a frame this narrow, so the fitted map is well below the folder-label scale. */
    const renderNarrow = (p: Partial<ConceptMapProps> = {}) => {
      const real = HTMLElement.prototype.getBoundingClientRect;
      HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
        return this.classList.contains('cmap') ? new DOMRect(0, 0, 160, 100) : real.call(this);
      };
      try {
        return render(props(p));
      } finally {
        HTMLElement.prototype.getBoundingClientRect = real;
      }
    };

    it('hides every folder label when the fitted map is small', () => {
      renderNarrow();
      expect(folderLabels()).toEqual([]);
    });
    it('shows only the labels on the path of a selected note, parents included', () => {
      renderNarrow();
      click(node('n1'));
      expect(folderLabels().sort()).toEqual(['Ops', 'Runbooks']);
    });
    it('shows the labels on the path of a search hit or a hot result', () => {
      const r = renderNarrow({ hits: new Set(['n2']) });
      expect(folderLabels()).toEqual(['Other']);
      r.rerender(props({ hot: 'n1' }));
      expect(folderLabels().sort()).toEqual(['Ops', 'Runbooks']);
    });
    it('shows every label once zoomed in past the threshold', () => {
      renderNarrow();
      const zoomIn = host!.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!;
      for (let i = 0; i < 12 && folderLabels().length < 3; i++) {
        fire(zoomIn, new MouseEvent('click', { bubbles: true }));
        act(() => void vi.advanceTimersByTime(1000));
      }
      expect(folderLabels().sort()).toEqual(['Ops', 'Other', 'Runbooks']);
    });
  });

  it('a mouse press released outside the map does not leave the pan armed (F4)', () => {
    render({ entries: [entry(base())] });
    const before = translate(node('n1'))!;
    const mouse = (type: string, x: number, y: number, buttons: number) => {
      const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons });
      Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
      Object.defineProperty(ev, 'pointerId', { value: 1 });
      fire(svg(), ev);
    };
    mouse('pointerdown', 100, 100, 1);
    mouse('pointermove', 102, 100, 1); // below the drag threshold; the button is then released off the map
    mouse('pointermove', 160, 140, 0); // back over the map with no button held
    mouse('pointermove', 220, 180, 0);
    expect(translate(node('n1'))).toEqual(before);
  });

  it('sizes the svg to the frame measured on mount (V1)', () => {
    const real = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.classList.contains('cmap') ? new DOMRect(0, 0, 1000, 500) : real.call(this);
    };
    try {
      render({ entries: [entry(base())] });
    } finally {
      HTMLElement.prototype.getBoundingClientRect = real;
    }
    expect(svg().getAttribute('viewBox')).toBe('0 0 1000 500');
    expect(svg().getAttribute('width')).toBe('1000');
    expect(svg().getAttribute('height')).toBe('500');
  });

  it('tells screen readers which vaults failed to load, outside the svg (F7)', () => {
    render({ entries: [entry(base()), entry(tree([], [], 'error'), 'v2')] });
    const status = [...host!.querySelectorAll('.cmap > p.sr-only')].map((p) => p.textContent);
    expect(status).toContain('Vault v2: couldn’t load');
    expect(status).not.toContain('Vault v1: couldn’t load');
    expect(host!.querySelector('g.cmap-folders')?.getAttribute('aria-hidden')).toBe('true');
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
