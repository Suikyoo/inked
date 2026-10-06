import { describe, expect, it } from 'vitest';
import { folder, note, tree } from './fixtures';
import { buildVaultGraph } from './graph';
import { layoutVault, layoutWorld } from './layout';
import { arrowDir, buildScene, displayTitle, nearestInDirection, taperPath, type SceneInput } from './scene';

function input(vaultId: string, bodies: Record<string, string> = {}, ready = true): SceneInput {
  const t = tree(
    [folder('f1', null, 'Ops'), folder('f2', 'f1', 'Runbooks')],
    [note(`${vaultId}-a`, 'f1', 'Alpha'), note(`${vaultId}-b`, 'f2', 'Beta'), note(`${vaultId}-c`, null, '  ')],
  );
  const graph = buildVaultGraph(vaultId, t, bodies, ready);
  return { vaultId, graph, layout: layoutVault(graph) };
}

describe('buildScene', () => {
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

  it('merges a two-way link into one line and counts neighbours', () => {
    const s = buildScene([input('v1', { 'v1-a': '[[beta]]', 'v1-b': '[[alpha]]' })]);
    expect(s.links).toHaveLength(1);
    expect(s.dots.find((d) => d.id === 'v1-a')!.links).toBe(1);
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

describe('taperPath', () => {
  it('returns a closed outline with two points per vertex', () => {
    const d = taperPath([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 80, y: 40 }]);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
    expect(d.match(/L/g)).toHaveLength(5);
  });

  it('returns an empty path for fewer than two distinct points', () => {
    expect(taperPath([{ x: 1, y: 1 }])).toBe('');
    expect(taperPath([{ x: 1, y: 1 }, { x: 1, y: 1 }])).toBe('');
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
