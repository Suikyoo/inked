import { SemanticStore, type SemanticState } from '../semantic/semanticStore';
import type { AppStore } from '../state/store';

/**
 * Test helpers for rendering under SemanticProvider. Plain functions (no vitest import), so they
 * also type-check with the app sources.
 */

/** A real SemanticStore on `app` for a deployment without the model: it never fetches, loads or embeds. */
export function unavailableSemanticStore(app: AppStore): SemanticStore {
  const refuse = () => Promise.reject(new Error('semantic search is unavailable in this test'));
  return new SemanticStore(app, {
    fetchManifest: async () => null,
    api: { listVectors: refuse, putVector: refuse },
    makeEmbedder: () => {
      throw new Error('semantic search is unavailable in this test');
    },
    prefs: { semantic: () => false, setSemantic: () => undefined },
    cache: { verify: async () => 0, clear: async () => undefined, persist: async () => false },
    delay: async () => undefined,
  });
}

export const SEMANTIC_STATE: SemanticState = {
  available: false,
  enabled: false,
  phase: 'unavailable',
  download: null,
  coverage: {},
  error: null,
  version: 0,
  persistDenied: false,
};

/**
 * A stand-in SemanticStore with a fixed state, for components that only read it. Methods do nothing;
 * wrap them with vi.fn (or replace them) to observe calls.
 */
export function semanticStub(state: Partial<SemanticState> = {}, methods: Partial<SemanticStore> = {}): SemanticStore {
  const snapshot = { ...SEMANTIC_STATE, ...state };
  const stub: Partial<SemanticStore> = {
    getState: () => snapshot,
    subscribe: () => () => undefined,
    setEnabled: async () => undefined,
    retry: () => undefined,
    search: async () => [],
    neighbours: () => [],
    chunkText: () => null,
    dispose: () => undefined,
    ...methods,
  };
  return stub as SemanticStore;
}
