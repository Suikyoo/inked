import { describe, expect, it } from 'vitest';
import { folder, note, tree } from './fixtures';
import { buildVaultGraph } from './graph';
import { LOCAL_CAP, localGraph } from './localGraph';

const at = (i: number) => new Date(Date.UTC(2026, 8, 1) + i * 3_600_000).toISOString();

describe('localGraph', () => {
  it('caps each group at 12, most recently edited first, and counts the rest', () => {
    const sibs = Array.from({ length: 15 }, (_, i) => note(`s${i}`, 'f1', `s${i}`, { updatedAt: at(i) }));
    const g = buildVaultGraph('v1', tree([folder('f1', null, 'Ops')], [note('c', 'f1', 'c'), ...sibs]), {}, true);
    const lg = localGraph(g, 'c')!;
    expect(lg.siblings).toHaveLength(LOCAL_CAP);
    expect(lg.siblingsMore).toBe(3);
    expect(lg.siblings[0].id).toBe('s14');
    expect(lg.parent).toEqual({ kind: 'folder', folder: expect.objectContaining({ id: 'f1', name: 'Ops' }) });
  });

  it('lists a two-way link once, as outgoing, and takes linked notes out of the siblings', () => {
    const t = tree([folder('f1', null)], [note('c', 'f1', 'c'), note('x', null, 'x'), note('s', 'f1', 's'), note('i', null, 'i')]);
    const g = buildVaultGraph('v1', t, { c: '[[x]] [[s]]', x: '[[c]]', i: '[[c]]' }, true);
    const lg = localGraph(g, 'c')!;
    expect(lg.outgoing.map((n) => n.id).sort()).toEqual(['s', 'x']);
    expect(lg.incoming.map((n) => n.id)).toEqual(['i']);
    expect(lg.siblings).toEqual([]);
  });

  it('uses the hub as parent for a root note and returns null for an unknown note', () => {
    const g = buildVaultGraph('v1', tree([], [note('c', null)]), {}, true);
    expect(localGraph(g, 'c')!.parent).toEqual({ kind: 'hub' });
    expect(localGraph(g, 'nope')).toBeNull();
  });
});
