import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { AskState, AskStore } from './askStore';

const Ctx = createContext<AskStore | null>(null);

export function AskProvider({ store, children }: { store: AskStore; children: ReactNode }) {
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useAskStore(): AskStore {
  const s = useContext(Ctx);
  if (!s) throw new Error('AskProvider missing');
  return s;
}

export function useAsk(): AskState {
  const s = useAskStore();
  return useSyncExternalStore(s.subscribe, s.getState);
}
