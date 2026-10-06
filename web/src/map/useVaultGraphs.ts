import { useMemo, useRef } from 'react';
import { vaultStats } from '../state/StoreContext';
import type { AppState, TreeView, VaultView } from '../state/store';
import { buildVaultGraph, structureKey, type VaultGraph } from './graph';
import { layoutVault, type VaultLayout } from './layout';
import type { SceneInput } from './scene';

export interface MapEntry extends SceneInput {
  vault: VaultView;
  status: TreeView['status'];
  /** Ink level for the hub icon (share of notes edited this week). */
  level: number;
}
export type LayoutCache = Map<string, { key: string; layout: VaultLayout }>;
export type GraphState = Pick<AppState, 'vaultOrder' | 'vaults' | 'trees' | 'bodies' | 'bodiesReady'>;

const EMPTY_TREE: TreeView = { status: 'loading', folders: {}, notes: {} };

/** One entry per usable vault, in sidebar order. Layouts are reused until the folder/note structure changes. */
export function mapEntries(state: GraphState, cache: LayoutCache, now = Date.now()): MapEntry[] {
  const out: MapEntry[] = [];
  for (const id of state.vaultOrder) {
    const vault = state.vaults[id];
    if (!vault || vault.broken) continue;
    const tree = state.trees[id] ?? EMPTY_TREE;
    const graph = buildVaultGraph(id, tree, state.bodies, !!state.bodiesReady[id]);
    const key = structureKey(graph);
    let hit = cache.get(id);
    if (!hit || hit.key !== key) {
      hit = { key, layout: layoutVault(graph) };
      cache.set(id, hit);
    }
    out.push({ vaultId: id, vault, status: tree.status, level: vaultStats(vault, state.trees[id], now).level, graph, layout: hit.layout });
  }
  return out;
}

export function useVaultGraphs(state: AppState): MapEntry[] {
  const cache = useRef<LayoutCache>(new Map());
  const { vaultOrder, vaults, trees, bodies, bodiesReady } = state;
  return useMemo(
    () => mapEntries({ vaultOrder, vaults, trees, bodies, bodiesReady }, cache.current),
    [vaultOrder, vaults, trees, bodies, bodiesReady],
  );
}

/** The link graph of one vault, or null before its tree has loaded. */
export function useVaultGraph(state: AppState, vaultId: string): VaultGraph | null {
  const tree = state.trees[vaultId];
  const ready = !!state.bodiesReady[vaultId];
  const { bodies } = state;
  return useMemo(() => (tree ? buildVaultGraph(vaultId, tree, bodies, ready) : null), [vaultId, tree, bodies, ready]);
}
