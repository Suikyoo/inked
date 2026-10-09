import type { AskState, AskStore } from '../ask/askStore';

/** A stand-in AskStore with a fixed state, for components that only read it. Methods do nothing. */
export function askStub(state: Partial<AskState> = {}, methods: Partial<AskStore> = {}): AskStore {
  const snapshot: AskState = { turns: [], busy: false, ...state };
  const stub: Partial<AskStore> = {
    getState: () => snapshot,
    subscribe: () => () => undefined,
    ask: async () => undefined,
    stop: () => undefined,
    retry: async () => undefined,
    clear: () => undefined,
    dispose: () => undefined,
    ...methods,
  };
  return stub as AskStore;
}
