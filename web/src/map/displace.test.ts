import { describe, expect, it } from 'vitest';
import { folder, note, tree } from './fixtures';
import { buildVaultGraph } from './graph';
import { displaceScene } from './displace';
import { layoutVault } from './layout';
import { buildScene } from './scene';

const scene = () => {
  const g = buildVaultGraph('v1', tree([folder('f1', null, 'A'), folder('f2', 'f1', 'B')], [note('a', 'f1', 'A1'), note('b', 'f2', 'B1'), note('c', null, 'C1')]), {}, true);
  return buildScene([{ vaultId: 'v1', graph: g, layout: layoutVault(g) }]);
};

describe('displaceScene', () => {
  it('returns the same scene when nothing moves', () => {
    const s = scene();
    expect(displaceScene(s, new Map())).toBe(s);
  });

  it('moves a dot and the edge and ink chain that end on it, and nothing else', () => {
    const s = scene();
    const d = displaceScene(s, new Map([['a', { x: 10, y: -5 }]]));
    const before = s.dots.find((x) => x.id === 'a')!;
    const after = d.dots.find((x) => x.id === 'a')!;
    expect([after.x - before.x, after.y - before.y]).toEqual([10, -5]);
    const e0 = s.pencil.find((x) => x.id === 'a')!;
    const e1 = d.pencil.find((x) => x.id === 'a')!;
    expect([e1.x2 - e0.x2, e1.y2 - e0.y2, e1.x1 - e0.x1]).toEqual([10, -5, 0]);
    const chain0 = s.chains.a;
    const chain1 = d.chains.a;
    expect(chain1[chain1.length - 1].x - chain0[chain0.length - 1].x).toBe(10);
    expect(d.dots.find((x) => x.id === 'c')).toBe(s.dots.find((x) => x.id === 'c'));
  });

  it('moves the start of every edge below a displaced folder, and the folder chain of its notes', () => {
    const s = scene();
    const d = displaceScene(s, new Map([['f1', { x: 7, y: 3 }]]));
    const e0 = s.pencil.find((x) => x.id === 'f2')!;
    const e1 = d.pencil.find((x) => x.id === 'f2')!;
    expect([e1.x1 - e0.x1, e1.y1 - e0.y1]).toEqual([7, 3]);
    expect(d.chains.b[1].x - s.chains.b[1].x).toBe(7);
  });
});
