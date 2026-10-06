import { describe, expect, it } from 'vitest';
import { folder, note, tree } from './fixtures';
import { buildVaultGraph, noteLinkTargets } from './graph';

describe('noteLinkTargets', () => {
  it('resolves wiki-links case-insensitively, with or without an alias', () => {
    const titles = new Map([['alpha', 'n1']]);
    expect([...noteLinkTargets('see [[Alpha]] and [[ALPHA|the a note]]', 'v1', titles)]).toEqual(['n1']);
  });

  it('resolves root-relative note links in the same vault, with or without a suffix', () => {
    const src = '[a](/v/v1/n/n2) [b](/v/v1/n/n3#part) [c](/v/v1/n/n4?x=1) [d](</v/v1/n/n5>) [e](/v/v1/n/n6 "t")';
    expect([...noteLinkTargets(src, 'v1', new Map())].sort()).toEqual(['n2', 'n3', 'n4', 'n5', 'n6']);
  });

  it('ignores other vaults, other routes and absolute URLs', () => {
    const src = '[a](/v/v2/n/n2) [b](/v/v1/n/n2/extra) [c](/v/v1) [d](https://x.example/v/v1/n/n9)';
    expect(noteLinkTargets(src, 'v1', new Map()).size).toBe(0);
  });
});

describe('buildVaultGraph', () => {
  it('drops self-links and unknown targets, and merges duplicate links', () => {
    const t = tree([], [note('n1', null, 'one'), note('n2', null, 'two')]);
    const bodies = { n1: '[[one]] [[two]] [[TWO]] [x](/v/v1/n/n2) [[ghost]] [y](/v/v1/n/zzz)' };
    expect(buildVaultGraph('v1', t, bodies, true).links).toEqual([{ from: 'n1', to: 'n2' }]);
  });

  it('leaves out broken notes and folders; a note in a broken folder goes to the root', () => {
    const t = tree([folder('f1', null, 'Bad', { broken: true })], [note('n1', 'f1'), note('n2', null, 'x', { broken: true })]);
    const g = buildVaultGraph('v1', t, {}, true);
    expect(g.folders).toEqual([]);
    expect(g.notes).toEqual([{ id: 'n1', folderId: null, title: 'n1', updatedAt: expect.any(String) }]);
  });

  it('survives folder cycles and missing parents (Review Focus 1)', () => {
    const t = tree([folder('f1', 'f2'), folder('f2', 'f1'), folder('f3', 'gone')], [note('n1', 'f1')]);
    const g = buildVaultGraph('v1', t, {}, true);
    const f3 = g.folders.find((f) => f.id === 'f3')!;
    expect(f3).toMatchObject({ parentId: null, depth: 0 });
    const cyc = g.folders.filter((f) => f.id !== 'f3');
    expect(cyc.map((f) => f.depth).sort()).toEqual([0, 1]);
    expect(cyc.filter((f) => f.parentId === null)).toHaveLength(1);
  });

  it('resolves a duplicate title to the most recently edited note (Review Focus 2)', () => {
    const t = tree([], [
      note('a', null, 'Same', { updatedAt: '2026-10-01T00:00:00.000Z' }),
      note('b', null, 'Same', { updatedAt: '2026-10-05T00:00:00.000Z' }),
      note('c', null, 'Linker'),
    ]);
    expect(buildVaultGraph('v1', t, { c: '[[same]]' }, true).links).toEqual([{ from: 'c', to: 'b' }]);
  });

  it('records folder depth and mirrors bodiesReady', () => {
    const t = tree([folder('f1', null), folder('f2', 'f1')], []);
    const g = buildVaultGraph('v1', t, {}, false);
    expect(g.folders.map((f) => [f.id, f.depth])).toEqual([['f1', 0], ['f2', 1]]);
    expect(g.linksReady).toBe(false);
  });
});
