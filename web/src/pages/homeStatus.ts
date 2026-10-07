import type { AppState } from '../state/store';

/** True while Home is still waiting on data. A failed vault load is settled, not pending. */
export function homePending(state: Pick<AppState, 'vaultsStatus' | 'vaultOrder' | 'trees'>): boolean {
  if (state.vaultsStatus === 'error') return false;
  if (state.vaultsStatus !== 'ready') return true;
  return state.vaultOrder.some((id) => state.trees[id]?.status === 'loading');
}
