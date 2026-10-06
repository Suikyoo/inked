import { describe, expect, it } from 'vitest';
import { folder, note, tree, vault } from './fixtures';
import { mapEntries, type GraphState, type LayoutCache } from './useVaultGraphs';

function state(over: Partial<GraphState> = {}): GraphState {
  return {
    vaultOrder: ['v1', 'v2', 'v3'],
    vaults: { v1: vault('v1'), v2: vault('v2'), v3: { ...vault('v3'), broken: true } },
    trees: { v1: tree([folder('f1', null)], [note('n1', 'f1', 'One')]) },
    bodies: {},
    bodiesReady: { v1: true },
    ...over,
  };
}

describe('mapEntries', () => {
  it('skips broken vaults and shows a vault with no tree yet as loading and empty', () => {
    const e = mapEntries(state(), new Map());
    expect(e.map((x) => [x.vaultId, x.status, x.graph.notes.length])).toEqual([
      ['v1', 'ready', 1],
      ['v2', 'loading', 0],
    ]);
    expect(e[0].graph.linksReady).toBe(true);
    expect(e[1].graph.linksReady).toBe(false);
  });

  it('reuses the cached layout when only bodies or edit times change', () => {
    const cache: LayoutCache = new Map();
    const first = mapEntries(state(), cache);
    const edited = state({
      trees: { v1: tree([folder('f1', null)], [note('n1', 'f1', 'One', { updatedAt: '2026-10-06T00:00:00.000Z' })]) },
      bodies: { n1: 'text' },
    });
    expect(mapEntries(edited, cache)[0].layout).toBe(first[0].layout);
    const renamed = state({ trees: { v1: tree([folder('f1', null)], [note('n1', 'f1', 'Renamed')]) } });
    expect(mapEntries(renamed, cache)[0].layout).not.toBe(first[0].layout);
  });
});
