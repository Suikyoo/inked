import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { SemanticState, SemanticStore } from './semanticStore';

const Ctx = createContext<SemanticStore | null>(null);

export function SemanticProvider({ store, children }: { store: SemanticStore; children: ReactNode }) {
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useSemanticStore(): SemanticStore {
  const s = useContext(Ctx);
  if (!s) throw new Error('SemanticProvider missing');
  return s;
}

export function useSemantic(): SemanticState {
  const s = useSemanticStore();
  return useSyncExternalStore(s.subscribe, s.getState);
}
