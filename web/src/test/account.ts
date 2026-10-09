import type { AccountSettingsState, AccountSettingsStore } from '../state/accountSettings';

/** A stand-in AccountSettingsStore with a fixed state, for components that only read it. */
export function accountStub(state: Partial<AccountSettingsState> = {}, methods: Partial<AccountSettingsStore> = {}): AccountSettingsStore {
  const snapshot: AccountSettingsState = { loaded: true, settings: {}, unreadable: false, llmOrigins: [], ...state };
  const stub: Partial<AccountSettingsStore> = {
    getState: () => snapshot,
    subscribe: () => () => undefined,
    update: async () => undefined,
    dispose: () => undefined,
    ...methods,
  };
  return stub as AccountSettingsStore;
}
