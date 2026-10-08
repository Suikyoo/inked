// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoteView, TreeView } from '../state/store';
import { ConceptMap, resetWriteOnForTests, type ConceptMapProps, type MapSelection } from './ConceptMap';
import { folder, note, tree, vault } from './fixtures';
import { buildVaultGraph } from './graph';
import { layoutVault } from './layout';
import { buildScene, nearestInDirection } from './scene';
import type { MapEntry } from './useVaultGraphs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-10-07T12:00:00.000Z');

function entry(t: TreeView, id = 'v1', linksReady = true, bodies: Record<string, string> = {}): MapEntry {
  const graph = buildVaultGraph(id, t, bodies, linksReady);
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
type Props = Partial<ConceptMapProps> & { entries: MapEntry[] };
/** Every onSelect call, in order. The harness also feeds the selection back, as HomePage does. */
let onSelect = vi.fn<(s: MapSelection | null) => void>();
function Controlled(p: Props) {
  const [selected, setSelected] = useState<MapSelection | null>(null);
  return (
    <ConceptMap
      hits={new Set()}
      hot={null}
      loading={false}
      now={NOW}
      selected={selected}
      {...p}
      onSelect={(s) => {
        onSelect(s);
        setSelected(s);
      }}
    />
  );
}
function ui(p: Props) {
  return (
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Controlled {...p} />} />
        <Route path="/v/:v/n/:n" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
}
function render(p: Props) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(ui(p)));
  return { rerender: (q: Partial<ConceptMapProps> & { entries: MapEntry[] }) => act(() => root!.render(ui(q))) };
}
beforeEach(() => {
  vi.useFakeTimers();
  onSelect = vi.fn<(s: MapSelection | null) => void>();
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
const folderNode = (id: string) => host!.querySelector<SVGGElement>(`g.cmap-folder[data-folder="${id}"]`)!;
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

  it('clicking a dot selects it through onSelect and rings it; there is no slip or legend', () => {
    render({ entries: [entry(base())] });
    click(node('n1'));
    expect(onSelect.mock.calls).toEqual([[{ kind: 'note', vaultId: 'v1', id: 'n1' }]]);
    expect(node('n1').querySelector('.cmap-sel')).not.toBeNull();
    expect(host!.querySelector('.cmap-ink path[data-ink="n1"]')).not.toBeNull();
    expect(host!.querySelector('.cmap-slip')).toBeNull();
    expect(host!.querySelector('.cmap-legend')).toBeNull();
  });

  it('Enter on a dot opens the note', () => {
    render({ entries: [entry(base())] });
    key(node('n2'), 'Enter');
    expect(host!.querySelector('[data-testid="where"]')?.textContent).toBe('/v/v1/n/n2');
  });

  it('Space on a dot selects the note for the preview and does not open it', () => {
    render({ entries: [entry(base())] });
    key(node('n2'), ' ');
    expect(onSelect.mock.calls).toEqual([[{ kind: 'note', vaultId: 'v1', id: 'n2' }]]);
    expect(node('n2').querySelector('.cmap-sel')).not.toBeNull();
    expect(host!.querySelector('[data-testid="where"]')).toBeNull();
  });

  it('the keyboard help says Enter opens a note and Space selects it', () => {
    render({ entries: [entry(base())] });
    const help = document.getElementById(svg().getAttribute('aria-describedby')!)?.textContent ?? '';
    expect(help).toContain('Enter opens a note and Space selects it');
    expect(help).toContain('Enter or Space selects a folder or vault');
  });

  it('Escape clears the selection through onSelect(null)', () => {
    render({ entries: [entry(base())] });
    click(node('n1'));
    key(node('n1'), 'Escape');
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(host!.querySelector('.cmap-sel')).toBeNull();
  });

  it('a background click clears the selection through onSelect(null)', () => {
    render({ entries: [entry(base())] });
    click(node('n1'));
    click(svg());
    expect(onSelect).toHaveBeenLastCalledWith(null);
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
    const s = buildScene([e]);
    const dots = s.dots;
    const leftmost = dots.reduce((a, b) => (b.x < a.x ? b : a));
    const expected = nearestInDirection(leftmost, [...dots, { id: 'hub:v1', x: s.hubs[0].x, y: s.hubs[0].y }], 'right');
    expect(expected).not.toBeNull();
    expect(expected).not.toBe('hub:v1');
    fire(node(leftmost.id), new FocusEvent('focusin', { bubbles: true }));
    key(node(leftmost.id), 'ArrowRight');
    expect(node(expected!).getAttribute('tabindex')).toBe('0');
    expect(svg().querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it('a drag pans the map and does not select the dot it ends on (Review Focus 4)', () => {
    render({ entries: [entry(base())] });
    const before = translate(node('n1'))!;
    pointer('pointerdown', 100, 100);
    pointer('pointermove', 130, 110);
    pointer('pointerup', 130, 110);
    click(node('n1'));
    expect(onSelect).not.toHaveBeenCalled();
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
    // n1 has no links, so it is a hollow orphan at its resting radius (3.4).
    expect(node('n1').querySelector('.cmap-dot')?.getAttribute('r')).toBe('3.4');
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
    const folderLabels = () => [...host!.querySelectorAll('.cmap-folder-label:not(.is-hidden)')].map((t) => t.textContent);
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
    // Folder labels are inside their node, which names itself with aria-label.
    expect(host!.querySelector('.cmap-folder-label')?.closest('g.cmap-folder')?.getAttribute('aria-label')).toMatch(/^folder /);
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

  describe('folder nodes', () => {
    const folders = () =>
      tree(
        [folder('f1', null, 'Ops'), folder('f2', 'f1', 'Runbooks')],
        [note('a', 'f1', 'Alpha'), note('b', 'f1', 'Bravo'), note('ix', 'f1', 'Index'), note('c', 'f2', 'Charlie'), note('r', null, 'Root')],
      );

    it('renders folders as focusable squares named with their note and subfolder counts', () => {
      render({ entries: [entry(folders())] });
      const f1 = folderNode('f1');
      expect(f1.getAttribute('role')).toBe('button');
      expect(f1.getAttribute('aria-label')).toBe('folder Ops, 2 notes, 1 subfolder');
      expect(folderNode('f2').getAttribute('aria-label')).toBe('folder Runbooks, 1 note');
      expect(f1.querySelector('rect.cmap-sq')).not.toBeNull();
      expect(f1.getAttribute('tabindex')).toBe('-1');
    });

    it('names a folder with several subfolders in the plural', () => {
      const t = tree([folder('p', null, 'Parent'), folder('k1', 'p', 'Kid one'), folder('k2', 'p', 'Kid two')], [note('a', 'p', 'Alpha')]);
      render({ entries: [entry(t)] });
      expect(folderNode('p').getAttribute('aria-label')).toBe('folder Parent, 1 note, 2 subfolders');
      expect(folderNode('k1').getAttribute('aria-label')).toBe('folder Kid one, 0 notes');
    });

    it('gives an Index note no dot', () => {
      render({ entries: [entry(folders())] });
      expect(nodes().map((n) => n.dataset.note).sort()).toEqual(['a', 'b', 'c', 'r']);
    });

    it('a search hit on an Index inks the path to its folder and turns it into a diamond', () => {
      render({ entries: [entry(folders())], hits: new Set(['ix']) });
      expect(host!.querySelector('.cmap-ink path[data-ink="ix"]')).not.toBeNull();
      expect(folderNode('f1').classList.contains('on')).toBe(true);
      expect(folderNode('f2').classList.contains('on')).toBe(false);
    });

    it('clicking a folder selects it, inks its path and turns its chain into diamonds', () => {
      render({ entries: [entry(folders())] });
      click(folderNode('f2'));
      expect(onSelect.mock.calls).toEqual([[{ kind: 'folder', vaultId: 'v1', id: 'f2' }]]);
      expect(folderNode('f2').classList.contains('on')).toBe(true);
      expect(folderNode('f1').classList.contains('on')).toBe(true);
      expect(folderNode('f2').querySelector('.cmap-sel')).not.toBeNull();
      expect(host!.querySelector('.cmap-ink path[data-ink="f2"]')).not.toBeNull();
    });

    it('Enter or Space on a folder selects it', () => {
      render({ entries: [entry(folders())] });
      key(folderNode('f1'), 'Enter');
      key(folderNode('f2'), ' ');
      expect(onSelect.mock.calls).toEqual([[{ kind: 'folder', vaultId: 'v1', id: 'f1' }], [{ kind: 'folder', vaultId: 'v1', id: 'f2' }]]);
    });

    it('clicking the hub selects the vault', () => {
      render({ entries: [entry(folders())] });
      click(host!.querySelector('g.cmap-hub')!);
      expect(onSelect.mock.calls).toEqual([[{ kind: 'hub', vaultId: 'v1' }]]);
      expect(host!.querySelector('g.cmap-hub .cmap-sel')).not.toBeNull();
    });

    it('the hub is a keyboard node: a named button that Enter or Space selects', () => {
      render({ entries: [entry(folders())] });
      const hub = host!.querySelector<SVGGElement>('g.cmap-hub')!;
      expect(hub.getAttribute('role')).toBe('button');
      expect(hub.getAttribute('aria-label')).toBe('vault Vault v1');
      expect(hub.hasAttribute('aria-hidden')).toBe(false);
      key(hub, 'Enter');
      key(hub, ' ');
      expect(onSelect.mock.calls).toEqual([[{ kind: 'hub', vaultId: 'v1' }], [{ kind: 'hub', vaultId: 'v1' }]]);
    });

    it('keeps exactly one tab stop across notes, folders and hubs, and arrows can reach the hub', () => {
      const e = entry(folders());
      render({ entries: [e], selected: { kind: 'hub', vaultId: 'v1' } });
      const stops = () => [...svg().querySelectorAll('[tabindex="0"]')];
      expect(stops()).toHaveLength(1);
      expect(stops()[0].getAttribute('data-hub')).toBe('v1');
      expect(svg().querySelectorAll('g.cmap-node[tabindex], g.cmap-folder[tabindex], g.cmap-hub[tabindex]')).toHaveLength(4 + 2 + 1);
      // From the hub, an arrow moves to the nearest node in that direction and the hub stops being the tab stop.
      const s = buildScene([e]);
      const hub = { x: s.hubs[0].x, y: s.hubs[0].y };
      const all = [...s.dots, ...s.folders];
      const dir = (['left', 'right', 'up', 'down'] as const).find((d) => nearestInDirection(hub, all, d))!;
      const keyOf = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' };
      key(stops()[0], keyOf[dir]);
      expect(stops()).toHaveLength(1);
      expect(stops()[0].getAttribute('data-hub')).toBeNull();
      expect(stops()[0].getAttribute('data-note') ?? stops()[0].getAttribute('data-folder')).toBe(nearestInDirection(hub, all, dir));
    });

    it('a hit on the root Index lights the hub instead of drawing an empty stroke', () => {
      const t = folders();
      t.notes.rix = note('rix', null, 'Index');
      render({ entries: [entry(t)], hits: new Set(['rix']) });
      expect(host!.querySelector('g.cmap-hub')!.classList.contains('on')).toBe(true);
      expect(host!.querySelector('g.cmap-hub .cmap-hub-ink')).not.toBeNull();
      expect(host!.querySelector('.cmap-ink path')).toBeNull();
      expect(nodes().map((n) => n.dataset.note)).not.toContain('rix');
    });

    it('selecting the root Index note lights the hub too', () => {
      const t = folders();
      t.notes.rix = note('rix', null, 'Index');
      render({ entries: [entry(t)], selected: { kind: 'note', vaultId: 'v1', id: 'rix' } });
      expect(host!.querySelector('g.cmap-hub')!.classList.contains('on')).toBe(true);
    });

    it('double-clicking a folder fits the view to its subtree', () => {
      render({ entries: [entry(folders())] });
      const gap = () => {
        const f = translate(folderNode('f2'))!;
        const c = translate(node('c'))!;
        return Math.hypot(f.x - c.x, f.y - c.y);
      };
      const before = gap();
      fire(folderNode('f2'), new MouseEvent('dblclick', { bubbles: true }));
      expect(gap()).toBeGreaterThan(before * 1.5);
    });

    it('a changed fitRequest.n fits that folder or hub; the same n does not', () => {
      const e = entry(folders());
      const { rerender } = render({ entries: [e], fitRequest: null });
      const at = () => translate(folderNode('f2'))!;
      const before = at();
      const req = { sel: { kind: 'folder', vaultId: 'v1', id: 'f2' } as MapSelection, n: 1 };
      rerender({ entries: [e], fitRequest: req });
      const fitted = at();
      expect(fitted).not.toEqual(before);
      rerender({ entries: [e], fitRequest: { ...req } });
      expect(at()).toEqual(fitted);
      rerender({ entries: [e], fitRequest: { sel: { kind: 'hub', vaultId: 'v1' }, n: 2 } });
      expect(at()).not.toEqual(fitted);
    });

    it('arrow keys rove between folders and notes', () => {
      const e = entry(folders());
      render({ entries: [e] });
      const s = buildScene([e]);
      const all = [...s.dots, ...s.folders];
      const isFolder = (id: string) => s.folders.some((f) => f.id === id);
      const dirs = ['left', 'right', 'up', 'down'] as const;
      const keyOf = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' };
      const step = (fromId: string, want: (id: string) => boolean) => {
        const from = all.find((n) => n.id === fromId)!;
        for (const d of dirs) {
          const next = nearestInDirection(from, all, d);
          if (next && want(next)) return { d, next };
        }
        throw new Error(`no ${fromId} neighbour of the wanted kind`);
      };
      const roving = () => [...host!.querySelectorAll('[tabindex="0"]')].map((el) => el.getAttribute('data-note') ?? el.getAttribute('data-folder'));

      const toFolder = step('c', isFolder);
      fire(node('c'), new FocusEvent('focusin', { bubbles: true }));
      key(node('c'), keyOf[toFolder.d]);
      expect(roving()).toEqual([toFolder.next]);

      const toNote = step(toFolder.next, (id) => !isFolder(id));
      key(folderNode(toFolder.next), keyOf[toNote.d]);
      expect(roving()).toEqual([toNote.next]);
    });
  });

  describe('motion', () => {
    const motionOn = () => {
      window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    };
    afterEach(() => {
      delete (window as { matchMedia?: unknown }).matchMedia;
    });
    const unmount = () => {
      act(() => root?.unmount());
      host?.remove();
      root = null;
    };
    const edge = (id: string) => host!.querySelector<SVGPathElement>(`.cmap-pencil path[data-edge="${id}"]`)!;
    const ink = (id: string) => host!.querySelector<SVGPathElement>(`.cmap-ink path[data-ink="${id}"]`);

    it('writes on with depth-staggered edges on the first mount of a session only (Review Focus 5)', () => {
      motionOn();
      resetWriteOnForTests();
      render({ entries: [entry(base())] });
      expect(svg().classList.contains('is-writing')).toBe(true);
      expect(edge('f1').style.animationDelay).toBe('0ms');
      expect(edge('f2').style.animationDelay).toBe('140ms');
      expect(edge('n2').style.animationDelay).toBe('280ms');
      expect(edge('n2').getAttribute('pathLength')).toBe('1');
      // Squares and dots fade in once their edge has finished drawing (edge delay + --dur-ink).
      expect(host!.querySelector<SVGGElement>('g.cmap-folder[data-folder="f1"]')!.style.animationDelay).toBe('520ms');
      expect(host!.querySelector<SVGGElement>('g.cmap-folder[data-folder="f2"]')!.style.animationDelay).toBe('660ms');
      expect(node('n3').style.animationDelay).toBe('520ms');
      expect(node('n2').style.animationDelay).toBe('800ms');
      unmount();
      render({ entries: [entry(base())] });
      expect(svg().classList.contains('is-writing')).toBe(false);
    });

    it('keeps the write-on for the first paint that has something to draw', () => {
      motionOn();
      resetWriteOnForTests();
      const r = render({ entries: [entry(tree([], [], 'loading'))], loading: true });
      expect(svg().classList.contains('is-writing')).toBe(false);
      r.rerender({ entries: [entry(base())] });
      expect(svg().classList.contains('is-writing')).toBe(true);
    });

    it('skips the write-on under reduced motion', () => {
      resetWriteOnForTests();
      render({ entries: [entry(base())] });
      expect(svg().classList.contains('is-writing')).toBe(false);
    });

    it('draws ink only for newly inked ids', () => {
      const r = render({ entries: [entry(base())], hits: new Set(['n1']) });
      expect(ink('n1')!.classList.contains('ink-draw')).toBe(false);
      expect(ink('n1')!.getAttribute('pathLength')).toBe('1');
      r.rerender({ entries: [entry(base())], hits: new Set(['n1', 'n2']) });
      expect(ink('n1')!.classList.contains('ink-draw')).toBe(false);
      expect(ink('n2')!.classList.contains('ink-draw')).toBe(true);
      r.rerender({ entries: [entry(base())], hits: new Set(['n2']) });
      expect(ink('n1')).toBeNull();
      r.rerender({ entries: [entry(base())], hits: new Set(['n1', 'n2']) });
      expect(ink('n1')!.classList.contains('ink-draw')).toBe(true);
    });

    it('pulses a dot whose updatedAt changed, never on first render', () => {
      const r = render({ entries: [entry(base())] });
      expect(host!.querySelector('.cmap-pulse')).toBeNull();
      const t = base();
      t.notes.n1 = { ...t.notes.n1, updatedAt: '2026-10-07T11:59:00.000Z' };
      r.rerender({ entries: [entry(t)] });
      expect(node('n1').querySelector('.cmap-pulse')).not.toBeNull();
      expect(node('n2').querySelector('.cmap-pulse')).toBeNull();
    });

    it('shows the pending-links caption while links are not ready, then fades it out', () => {
      const r = render({ entries: [entry(base(), 'v1', false)] });
      expect(host!.querySelector('.cmap-pending')?.textContent).toBe('Links appear once note text is decrypted.');
      r.rerender({ entries: [entry(base())] });
      act(() => void vi.advanceTimersByTime(1000));
      expect(host!.querySelector('.cmap-pending')).toBeNull();
    });
  });
});

describe('link density cues', () => {
  const linked = () => {
    const t = tree([], ['a', 'b', 'c', 'd', 'e'].map((id) => note(id, null, id.toUpperCase())));
    return [entry(t, 'v1', true, { a: '[[B]] [[C]]', d: '[[A]]' })];
  };
  it('draws two rings and counts the links for a hub note', () => {
    render({ entries: linked() });
    expect(node('a').querySelectorAll('.cmap-dens')).toHaveLength(2);
    expect(node('a').getAttribute('aria-label')).toMatch(/, 3 links$/);
    expect(node('a').classList.contains('is-orphan')).toBe(false);
  });
  it('leaves a single-link note ringless', () => {
    render({ entries: linked() });
    expect(node('b').querySelector('.cmap-dens')).toBeNull();
    expect(node('b').getAttribute('aria-label')).toMatch(/, 1 link$/);
  });
  it('marks an unlinked note as a hollow orphan with no count', () => {
    render({ entries: linked() });
    expect(node('e').classList.contains('is-orphan')).toBe(true);
    expect(node('e').querySelector('.cmap-dens')).toBeNull();
    expect(node('e').getAttribute('aria-label')).not.toMatch(/link/);
  });
  it('moves the selection ring outward with density', () => {
    render({ entries: linked() });
    click(node('a'));
    expect(node('a').querySelector('.cmap-sel')!.getAttribute('r')).toBe('11.5');
  });
  it('draws a plain solid dot with no cue while links are pending', () => {
    const t = tree([], [note('a', null, 'A'), note('b', null, 'B')]);
    render({ entries: [entry(t, 'v1', false)] });
    expect(node('a').classList.contains('is-orphan')).toBe(false);
    expect(node('a').querySelector('.cmap-dot')!.getAttribute('r')).toBe('4');
    expect(node('a').querySelector('.cmap-dens')).toBeNull();
    expect(node('a').getAttribute('aria-label')).not.toMatch(/link/);
  });
  it('keeps the rings of a ready vault while another vault is pending', () => {
    const t1 = tree([], ['a', 'b', 'c'].map((id) => note(id, null, id.toUpperCase())));
    const t2 = tree([], [note('x', null, 'X')]);
    render({ entries: [entry(t1, 'v1', true, { a: '[[B]] [[C]]' }), entry(t2, 'v2', false)] });
    expect(node('a').querySelectorAll('.cmap-dens')).toHaveLength(1);
    expect(node('x').classList.contains('is-orphan')).toBe(false);
  });
});

describe('lit state', () => {
  const t = () =>
    tree(
      [folder('f1', null, 'Ops'), folder('f2', null, 'Misc')],
      [note('a', 'f1', 'Alpha'), note('b', 'f1', 'Beta'), note('c', 'f2', 'Gamma'), note('d', null, 'Delta')],
    );
  const linked = () => entry(t(), 'v1', true, { a: '[[Beta]]' });
  const hoverDot = (id: string) => {
    fire(node(id), new MouseEvent('pointerover', { bubbles: true }));
    act(() => void vi.advanceTimersByTime(40));
  };
  const dimmed = () => nodes().filter((n) => n.classList.contains('is-dim')).map((n) => n.dataset.note).sort();
  const noMotion = () => {
    window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  };
  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('dims unrelated dots on hover and flows one dash per link into the focus', () => {
    render({ entries: [linked()] });
    expect(dimmed()).toEqual([]);
    hoverDot('a');
    expect(dimmed()).toEqual(['c', 'd']);
    expect(host!.querySelectorAll('.cmap-alink')).toHaveLength(1);
    expect(host!.querySelector('.cmap-links')!.classList.contains('is-dim-links')).toBe(true);
    expect(folderNode('f2').classList.contains('is-dim-soft')).toBe(true);
    expect(folderNode('f1').classList.contains('is-dim-soft')).toBe(false);
  });

  it('does not dim on hover while searching', () => {
    render({ entries: [linked()], hits: new Set(['c']) });
    hoverDot('a');
    expect(dimmed()).toEqual([]);
    expect(host!.querySelectorAll('.cmap-alink')).toHaveLength(0);
  });

  it('applies hover once per frame and cancels a pending frame on unmount', () => {
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    render({ entries: [linked()] });
    fire(node('a'), new MouseEvent('pointerover', { bubbles: true }));
    expect(dimmed()).toEqual([]);
    act(() => void root!.unmount());
    root = null;
    expect(cancel).toHaveBeenCalled();
    cancel.mockRestore();
  });

  it('draws a ring when a note is selected and removes it on animationend', () => {
    noMotion();
    render({ entries: [linked()] });
    expect(host!.querySelector('.cmap-ring')).toBeNull();
    click(node('b'));
    expect(node('b').querySelector('.cmap-ring')).not.toBeNull();
    fire(node('b').querySelector('.cmap-ring')!, new Event('animationend', { bubbles: true }));
    expect(host!.querySelector('.cmap-ring')).toBeNull();
  });

  it('does not dim a search hit outside the selection while searching', () => {
    render({ entries: [linked()], hits: new Set(['c']), selected: { kind: 'note', vaultId: 'v1', id: 'a' } });
    expect(dimmed()).toEqual([]);
    expect(host!.querySelectorAll('.cmap-alink')).toHaveLength(1);
    expect(host!.querySelector('.cmap-links')!.classList.contains('is-dim-links')).toBe(false);
  });

  it('plays no ring on mount with a selection, and one when the selection changes later', () => {
    noMotion();
    const sel = (id: string): MapSelection => ({ kind: 'note', vaultId: 'v1', id });
    const { rerender } = render({ entries: [linked()], selected: sel('a') });
    expect(host!.querySelector('.cmap-ring')).toBeNull();
    rerender({ entries: [linked()], selected: sel('b') });
    expect(node('b').querySelector('.cmap-ring')).not.toBeNull();
  });

  it('asks for meaning neighbours once per focus, not on every render', () => {
    const neighbours = vi.fn(() => []);
    const entries = [linked()];
    const { rerender } = render({ entries, neighbours });
    click(node('b'));
    const calls = neighbours.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    rerender({ entries, neighbours, now: NOW + 1000 });
    rerender({ entries, neighbours, now: NOW + 2000 });
    expect(neighbours).toHaveBeenCalledTimes(calls);
  });

  it('draws no ring under reduced motion', () => {
    window.matchMedia = vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    render({ entries: [linked()] });
    click(node('b'));
    expect(host!.querySelector('.cmap-ring')).toBeNull();
  });
});
