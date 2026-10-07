import { describe, expect, it } from 'vitest';
import { folder, note, tree } from './fixtures';
import { buildVaultGraph } from './graph';
import { layoutVault, layoutWorld } from './layout';
import { arrowDir, buildScene, chainPath, curvePath, densityClass, displayTitle, edgeWidth, linkPath, nearestInDirection, selRingRadius, type SceneInput } from './scene';

function input(vaultId: string, bodies: Record<string, string> = {}, ready = true): SceneInput {
  const t = tree(
    [folder('f1', null, 'Ops'), folder('f2', 'f1', 'Runbooks')],
    [note(`${vaultId}-a`, 'f1', 'Alpha'), note(`${vaultId}-b`, 'f2', 'Beta'), note(`${vaultId}-c`, null, '  ')],
  );
  const graph = buildVaultGraph(vaultId, t, bodies, ready);
  return { vaultId, graph, layout: layoutVault(graph) };
}

describe('buildScene', () => {
  it('gives each dot its top-down folder chain (M1)', () => {
    const s = buildScene([input('v1')]);
    const ids = (id: string) => s.dots.find((d) => d.id === id)!.folderIds;
    expect(ids('v1-b')).toEqual(['f1', 'f2']);
    expect(ids('v1-a')).toEqual(['f1']);
    expect(ids('v1-c')).toEqual([]);
  });

  it('puts each hub at its world centre and offsets every dot from it', () => {
    const a = input('v1');
    const b = input('v2');
    const s = buildScene([a, b]);
    const centres = layoutWorld([a.layout, b.layout], 48);
    expect(s.hubs.map((h) => [h.vaultId, h.x, h.y])).toEqual([
      ['v1', centres.v1.x, centres.v1.y],
      ['v2', centres.v2.x, centres.v2.y],
    ]);
    const dot = s.dots.find((d) => d.id === 'v2-b')!;
    expect(dot.x).toBeCloseTo(centres.v2.x + b.layout.notes['v2-b'].x, 9);
  });

  it('draws one pencil line per folder and note, and chains hub → folders → note', () => {
    const s = buildScene([input('v1')]);
    expect(s.pencil).toHaveLength(2 + 3);
    const chain = s.chains['v1-b'];
    expect(chain).toHaveLength(4);
    expect(chain[0]).toEqual({ x: s.hubs[0].x, y: s.hubs[0].y });
    const f1 = s.folders.find((f) => f.id === 'f1')!;
    expect(chain[1]).toEqual({ x: f1.x, y: f1.y });
  });

  it('merges a two-way link into one line', () => {
    const s = buildScene([input('v1', { 'v1-a': '[[beta]]', 'v1-b': '[[alpha]]' })]);
    expect(s.links).toHaveLength(1);
    expect(s.linksPending).toBe(false);
  });

  it('draws no links while note text is still decrypting', () => {
    const s = buildScene([input('v1', { 'v1-a': '[[beta]]' }, false)]);
    expect(s.links).toEqual([]);
    expect(s.linksPending).toBe(true);
  });

  it('names folder paths and labels untitled notes "Untitled" (Review Focus 5)', () => {
    const s = buildScene([input('v1')]);
    const by = (id: string) => s.dots.find((d) => d.id === id)!;
    expect(by('v1-b').folderPath).toBe('Ops / Runbooks');
    expect(by('v1-c').folderPath).toBe('');
    expect(by('v1-c').title).toBe('Untitled');
    expect(displayTitle(' x ')).toBe('x');
  });

  it('gives pencil edges a depth and a kind, and widths by depth', () => {
    const s = buildScene([input('v1')]);
    const by = (id: string) => s.pencil.find((p) => p.id === id)!;
    expect(by('f1')).toMatchObject({ depth: 0, kind: 'folder' });
    expect(by('f2')).toMatchObject({ depth: 1, kind: 'folder' });
    expect(by('v1-c')).toMatchObject({ depth: 0, kind: 'note' });
    expect(by('v1-a')).toMatchObject({ depth: 1, kind: 'note' });
    expect(by('v1-b')).toMatchObject({ depth: 2, kind: 'note' });
    expect([by('f1'), by('f2'), by('v1-b')].map(edgeWidth)).toEqual([1.5, 1.1, 0.8]);
  });

  it('folder nodes carry depth and their direct note and subfolder counts', () => {
    const s = buildScene([input('v1')]);
    const f1 = s.folders.find((f) => f.id === 'f1')!;
    const f2 = s.folders.find((f) => f.id === 'f2')!;
    expect(f1).toMatchObject({ id: 'f1', vaultId: 'v1', name: 'Ops', depth: 0, noteCount: 1, folderCount: 1 });
    expect(f2).toMatchObject({ name: 'Runbooks', depth: 1, noteCount: 1, folderCount: 0 });
    expect(s.chains.f2).toEqual([{ x: s.hubs[0].x, y: s.hubs[0].y }, { x: f1.x, y: f1.y }, { x: f2.x, y: f2.y }]);
    expect(s.chainFolders.f2).toEqual(['f1', 'f2']);
    const b = s.folderBounds.f1;
    const b2 = s.chains['v1-b'][3];
    expect(b.minX).toBeLessThanOrEqual(Math.min(f1.x, f2.x, b2.x));
    expect(b.maxX).toBeGreaterThanOrEqual(Math.max(f1.x, f2.x, b2.x));
    expect(b.minY).toBeLessThanOrEqual(Math.min(f1.y, f2.y, b2.y));
    expect(b.maxY).toBeGreaterThanOrEqual(Math.max(f1.y, f2.y, b2.y));
  });

  it('gives an Index note no dot, but a hit on it inks the path to its folder', () => {
    const t = tree(
      [folder('f1', null, 'Ops'), folder('f2', 'f1', 'Runbooks')],
      [note('a', 'f2', 'Alpha'), note('ix', 'f2', 'Index'), note('rootix', null, 'Index')],
    );
    const graph = buildVaultGraph('v1', t, {}, true);
    const s = buildScene([{ vaultId: 'v1', graph, layout: layoutVault(graph) }]);
    expect(s.dots.map((d) => d.id)).toEqual(['a']);
    expect(s.pencil.map((p) => p.id).sort()).toEqual(['a', 'f1', 'f2']);
    expect(s.chains.ix).toEqual(s.chains.f2);
    expect(s.chainFolders.ix).toEqual(['f1', 'f2']);
    expect(s.chains.rootix).toEqual([{ x: s.hubs[0].x, y: s.hubs[0].y }]);
    expect(s.folders.find((f) => f.id === 'f2')!.noteCount).toBe(1);
  });

  it('bounds cover every vault circle', () => {
    const s = buildScene([input('v1'), input('v2')]);
    for (const h of s.hubs) {
      expect(s.bounds.minX).toBeLessThanOrEqual(h.x - h.radius);
      expect(s.bounds.maxY).toBeGreaterThanOrEqual(h.y + h.radius);
      expect(s.vaultBounds[h.vaultId]).toEqual({ minX: h.x - h.radius, minY: h.y - h.radius, maxX: h.x + h.radius, maxY: h.y + h.radius });
    }
    expect(buildScene([]).bounds).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

describe('quill curves', () => {
  it('curvePath is one quadratic bowed perpendicular to the segment by bend × length', () => {
    expect(curvePath({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.12)).toBe('M0.0 0.0 Q50.0 12.0 100.0 0.0');
    expect(curvePath({ x: 0, y: 0 }, { x: 0, y: 50 }, 0.2)).toBe('M0.0 0.0 Q-10.0 25.0 0.0 50.0');
  });

  it('linkPath bows by 0.25', () => {
    expect(linkPath({ x: 0, y: 0 }, { x: 100, y: 0 })).toBe('M0.0 0.0 Q50.0 25.0 100.0 0.0');
  });

  it('chainPath joins the segments into one path with a single M', () => {
    const d = chainPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }], 0.12);
    expect(d).toBe('M0.0 0.0 Q50.0 12.0 100.0 0.0 Q94.0 25.0 100.0 50.0');
    expect(d.match(/M/g)).toHaveLength(1);
    expect(d.match(/Q/g)).toHaveLength(2);
  });

  it('chainPath is empty for fewer than two points', () => {
    expect(chainPath([{ x: 1, y: 1 }], 0.12)).toBe('');
    expect(chainPath([], 0.12)).toBe('');
  });
});

describe('arrow-key navigation', () => {
  const pts = [
    { id: 'a', x: 10, y: 0 },
    { id: 'b', x: 5, y: 6 },
    { id: 'c', x: 30, y: 1 },
    { id: 'd', x: 1, y: -8 },
  ];
  it('finds the nearest dot within the 90° cone of the direction', () => {
    expect(nearestInDirection({ x: 0, y: 0 }, pts, 'right')).toBe('a');
    expect(nearestInDirection({ x: 0, y: 0 }, pts, 'up')).toBe('d');
    expect(nearestInDirection({ x: 0, y: 0 }, pts, 'left')).toBeNull();
  });
  it('maps arrow keys', () => {
    expect(arrowDir('ArrowLeft')).toBe('left');
    expect(arrowDir('ArrowDown')).toBe('down');
    expect(arrowDir('Enter')).toBeNull();
  });
});

describe('link density', () => {
  function densityScene() {
    const t = tree([], ['a', 'b', 'c', 'd', 'e'].map((id) => note(id, null, id.toUpperCase())));
    const graph = buildVaultGraph('v1', t, { a: '[[B]] [[C]]', d: '[[A]]' }, true);
    return buildScene([{ vaultId: 'v1', graph, layout: layoutVault(graph) }]);
  }
  it('counts links in plus out per dot', () => {
    const s = densityScene();
    const deg = (id: string) => s.dots.find((d) => d.id === id)!.degree;
    expect([deg('a'), deg('b'), deg('c'), deg('d'), deg('e')]).toEqual([3, 1, 1, 1, 0]);
  });
  it('carries the two note ids on each link', () => {
    const s = densityScene();
    expect(s.links.map((l) => [l.a, l.b].sort().join('|')).sort()).toEqual(['a|b', 'a|c', 'a|d']);
  });
  it('counts a two-way link once, as it is drawn once', () => {
    const t = tree([], [note('a', null, 'A'), note('b', null, 'B')]);
    const graph = buildVaultGraph('v1', t, { a: '[[B]]', b: '[[A]]' }, true);
    const s = buildScene([{ vaultId: 'v1', graph, layout: layoutVault(graph) }]);
    expect(s.dots.map((d) => d.degree)).toEqual([1, 1]);
  });
  it('has degree 0 while links are pending', () => {
    const t = tree([], [note('a', null, 'A'), note('b', null, 'B')]);
    const graph = buildVaultGraph('v1', t, {}, false);
    const dots = buildScene([{ vaultId: 'v1', graph, layout: layoutVault(graph) }]).dots;
    expect(dots.map((d) => d.degree)).toEqual([0, 0]);
    expect(dots.every((d) => !d.linksReady)).toBe(true);
  });
  it('keeps linksReady per vault', () => {
    const mk = (id: string, ready: boolean) => {
      const g = buildVaultGraph(id, tree([], [note(`${id}a`, null, 'A'), note(`${id}b`, null, 'B')]), ready ? { [`${id}a`]: '[[B]]' } : {}, ready);
      return { vaultId: id, graph: g, layout: layoutVault(g) };
    };
    const s = buildScene([mk('v1', true), mk('v2', false)]);
    expect(s.dots.map((d) => [d.id, d.linksReady, d.degree])).toEqual([['v1a', true, 1], ['v1b', true, 1], ['v2a', false, 0], ['v2b', false, 0]]);
  });
  it('sizes the selection ring and picks the density class by degree', () => {
    expect([0, 1, 2, 3, 9].map(selRingRadius)).toEqual([7, 7, 9, 11.5, 11.5]);
    expect([0, 1, 2, 3, 9].map(densityClass)).toEqual(['hollow', '', 'r1', 'r2', 'r2']);
  });
});
