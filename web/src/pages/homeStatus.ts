import type { MapSelection } from '../map/ConceptMap';
import type { AppState } from '../state/store';

/** True while Home is still waiting on data. A failed vault load is settled, not pending. */
export function homePending(state: Pick<AppState, 'vaultsStatus' | 'vaultOrder' | 'trees'>): boolean {
  if (state.vaultsStatus === 'error') return false;
  if (state.vaultsStatus !== 'ready') return true;
  return state.vaultOrder.some((id) => state.trees[id]?.status === 'loading');
}

/** True only when the vault load failed and there is nothing to show. A failed refresh keeps the data it had. */
export function homeError(state: Pick<AppState, 'vaultsStatus' | 'vaultOrder'>): boolean {
  return state.vaultsStatus === 'error' && state.vaultOrder.length === 0;
}

export type HomeColumn = 'search' | 'preview' | 'empty';

/** Which view fills Home's right column: a query wins, then a selection that still exists, else the hint. */
export function homeColumn(state: Pick<AppState, 'vaults' | 'trees'>, query: string, selection: MapSelection | null): HomeColumn {
  if (query.trim()) return 'search';
  if (!selection) return 'empty';
  const tree = state.trees[selection.vaultId];
  let alive: boolean;
  if (selection.kind === 'hub') {
    const v = state.vaults[selection.vaultId];
    alive = !!v && !v.broken && !!tree;
  } else if (selection.kind === 'folder') {
    const f = tree?.folders[selection.id];
    alive = !!f && !f.broken;
  } else {
    const n = tree?.notes[selection.id];
    alive = !!n && !n.broken;
  }
  return alive ? 'preview' : 'empty';
}
