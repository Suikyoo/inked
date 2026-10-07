import { describe, expect, it } from 'vitest';
import { folder, note, tree } from './fixtures';
import { buildVaultGraph } from './graph';
import { HUB_GAP, MIN_GAP, NOTE_SPREAD, layoutVault, layoutWorld, type VaultLayout } from './layout';
import type { FolderView, NoteView } from '../state/store';

const graphOf = (folders: FolderView[], notes: NoteView[]) => buildVaultGraph('v1', tree(folders, notes), {}, true);
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
/** Signed difference a - b, wrapped into (-pi, pi]. */
const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const angleOf = (p: { x: number; y: number }) => Math.atan2(p.y, p.x);

describe('layoutVault', () => {
  it('is deterministic, whatever order the tree lists things in', () => {
    const fs = [folder('f1', null, 'B'), folder('f2', null, 'A'), folder('f3', 'f1', 'C')];
    const ns = [note('n1', 'f1', 'x'), note('n2', 'f3', 'y'), note('n3', null, 'z'), note('n4', 'f2', 'w')];
    const a = layoutVault(graphOf(fs, ns));
    const b = layoutVault(graphOf([...fs].reverse(), [...ns].reverse()));
    expect(b).toEqual(a);
    expect(layoutVault(graphOf(fs, ns))).toEqual(a);
  });

  it('adding a note to folder A moves no dot in folder B or its subfolders', () => {
    const fs = [folder('fa', null, 'A'), folder('fb', null, 'B'), folder('fb2', 'fb', 'B2')];
    const ns = [note('a1', 'fa'), note('b1', 'fb'), note('b2', 'fb2'), note('r1', null)];
    const before = layoutVault(graphOf(fs, ns));
    const after = layoutVault(graphOf(fs, [...ns, note('a2', 'fa'), note('a3', 'fa')]));
    for (const id of ['fb', 'fb2']) expect(after.folders[id]).toEqual(before.folders[id]);
    for (const id of ['b1', 'b2', 'r1']) expect(after.notes[id]).toEqual(before.notes[id]);
  });

  it('the first root note in a folders-only vault moves no folder or note dot', () => {
    const fs = [folder('fa', null, 'A'), folder('fb', null, 'B'), folder('fb2', 'fb', 'B2')];
    const ns = [note('a1', 'fa'), note('b1', 'fb'), note('b2', 'fb2')];
    const before = layoutVault(graphOf(fs, ns));
    const after = layoutVault(graphOf(fs, [...ns, note('r1', null)]));
    expect(after.folders).toEqual(before.folders);
    for (const id of ['a1', 'b1', 'b2']) expect(after.notes[id]).toEqual(before.notes[id]);
  });

  it("clusters a folder's notes around its centre angle when the slice is wide", () => {
    const ns = Array.from({ length: 5 }, (_, i) => note(`n${i}`, 'fa'));
    const l = layoutVault(graphOf([folder('fa', null, 'A')], ns));
    const centre = angleOf(l.folders.fa);
    for (const n of ns) {
      const p = l.notes[n.id];
      const step = 2 * Math.asin(MIN_GAP / (2 * Math.hypot(p.x, p.y)));
      expect(Math.abs(angleDiff(angleOf(p), centre))).toBeLessThanOrEqual((NOTE_SPREAD * step * (ns.length - 1)) / 2 + 1e-9);
    }
  });

  it('leaves the HUB_GAP at the top of the circle free of dots', () => {
    const fs = [folder('f1', null), folder('f2', null), folder('f3', 'f1')];
    const ns = [
      ...Array.from({ length: 40 }, (_, i) => note(`a${i}`, 'f1')),
      ...Array.from({ length: 40 }, (_, i) => note(`r${i}`, null)),
      ...Array.from({ length: 40 }, (_, i) => note(`c${i}`, 'f3')),
    ];
    const l = layoutVault(graphOf(fs, ns));
    for (const p of [...Object.values(l.folders), ...Object.values(l.notes)])
      expect(Math.abs(angleDiff(angleOf(p), -Math.PI / 2))).toBeGreaterThanOrEqual(HUB_GAP / 2 - 1e-9);
  });

  it('places root notes around the hub with a null parent', () => {
    const l = layoutVault(graphOf([], [note('r1', null), note('r2', null)]));
    expect(Object.keys(l.notes).sort()).toEqual(['r1', 'r2']);
    expect(l.parent.r1).toBeNull();
    expect(dist(l.notes.r1, { x: 0, y: 0 })).toBeGreaterThan(0);
  });

  it('nests four folder levels outward, each parent recorded', () => {
    const fs = [folder('f1', null), folder('f2', 'f1'), folder('f3', 'f2'), folder('f4', 'f3')];
    const l = layoutVault(graphOf(fs, [note('n1', 'f4')]));
    const o = { x: 0, y: 0 };
    expect(dist(l.folders.f2, o)).toBeGreaterThan(dist(l.folders.f1, o));
    expect(dist(l.folders.f3, o)).toBeGreaterThan(dist(l.folders.f2, o));
    expect(dist(l.folders.f4, o)).toBeGreaterThan(dist(l.folders.f3, o));
    expect(l.parent).toMatchObject({ f1: null, f2: 'f1', f3: 'f2', f4: 'f3', n1: 'f4' });
    expect(l.radius).toBeGreaterThan(dist(l.notes.n1, o));
  });

  it('keeps neighbouring dots in one row at least MIN_GAP apart', () => {
    const fs = [folder('f1', null), folder('f2', null), folder('f3', 'f1')];
    const ns = [
      ...Array.from({ length: 60 }, (_, i) => note(`a${i}`, 'f1', `a${String(i).padStart(2, '0')}`)),
      ...Array.from({ length: 30 }, (_, i) => note(`r${i}`, null, `r${String(i).padStart(2, '0')}`)),
      ...Array.from({ length: 25 }, (_, i) => note(`c${i}`, 'f3', `c${String(i).padStart(2, '0')}`)),
    ];
    const l = layoutVault(graphOf(fs, ns));
    const rows = new Map<string, { x: number; y: number }[]>();
    for (const [id, p] of Object.entries(l.notes)) {
      const key = `${l.parent[id]}|${Math.round(Math.hypot(p.x, p.y) * 1000)}`;
      rows.set(key, [...(rows.get(key) ?? []), p]);
    }
    expect(rows.size).toBeGreaterThan(3);
    for (const pts of rows.values()) {
      for (let i = 0; i < pts.length; i++)
        for (let j = i + 1; j < pts.length; j++) expect(dist(pts[i], pts[j])).toBeGreaterThanOrEqual(MIN_GAP - 1e-6);
    }
  });

  it('gives an empty vault a hub-only layout', () => {
    const l = layoutVault(graphOf([], []));
    expect(l).toMatchObject({ vaultId: 'v1', folders: {}, notes: {}, parent: {} });
    expect(l.radius).toBeGreaterThan(0);
  });

  it('lays out 1,000 notes in 40 folders in under 50 ms', () => {
    const fs: FolderView[] = [];
    for (let i = 0; i < 10; i++) {
      fs.push(folder(`t${i}`, null, `top ${i}`));
      for (let j = 0; j < 3; j++) fs.push(folder(`t${i}c${j}`, `t${i}`, `child ${j}`));
    }
    const ns = Array.from({ length: 1000 }, (_, i) => note(`n${i}`, fs[i % fs.length].id, `note ${i}`));
    const g = graphOf(fs, ns);
    layoutVault(g); // warm-up
    const t0 = performance.now();
    const l = layoutVault(g);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(Object.keys(l.notes)).toHaveLength(1000);
  });
});

describe('layoutWorld', () => {
  it('places vault circles in rows without overlap, in the given order', () => {
    const fake = (id: string, radius: number): VaultLayout => ({ vaultId: id, radius, folders: {}, notes: {}, parent: {} });
    const ls = [fake('a', 60), fake('b', 200), fake('c', 90), fake('d', 300), fake('e', 75)];
    const c = layoutWorld(ls, 48);
    expect(Object.keys(c)).toEqual(['a', 'b', 'c', 'd', 'e']);
    for (let i = 0; i < ls.length; i++)
      for (let j = i + 1; j < ls.length; j++)
        expect(dist(c[ls[i].vaultId], c[ls[j].vaultId])).toBeGreaterThanOrEqual(ls[i].radius + ls[j].radius);
    expect(layoutWorld([])).toEqual({});
  });
});
