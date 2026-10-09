import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { AccountSettingsState, AccountSettingsStore } from './accountSettings';

const Ctx = createContext<AccountSettingsStore | null>(null);

export function AccountSettingsProvider({ store, children }: { store: AccountSettingsStore; children: ReactNode }) {
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useAccountSettingsStore(): AccountSettingsStore {
  const s = useContext(Ctx);
  if (!s) throw new Error('AccountSettingsProvider missing');
  return s;
}

export function useAccountSettings(): AccountSettingsState {
  const s = useAccountSettingsStore();
  return useSyncExternalStore(s.subscribe, s.getState);
}
