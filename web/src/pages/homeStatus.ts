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
