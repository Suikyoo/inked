// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { AppStore } from '../state/store';
import { unavailableSemanticStore } from '../test/semantic';
import { SemanticProvider, useSemantic } from './SemanticContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Phase() {
  const { phase, available } = useSemantic();
  return <p>{`${phase}:${String(available)}`}</p>;
}

describe('SemanticContext', () => {
  it('re-renders when the store learns the model is unavailable', async () => {
    let state = { phase: 'locked', trees: {}, bodies: {}, bodiesReady: {} };
    const listeners = new Set<() => void>();
    const app = {
      getState: () => state,
      subscribe: (f: () => void) => (listeners.add(f), () => listeners.delete(f)),
      onNotesSaved: () => () => undefined,
    } as unknown as AppStore;
    const semantic = unavailableSemanticStore(app);
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() =>
      root.render(
        <SemanticProvider store={semantic}>
          <Phase />
        </SemanticProvider>,
      ),
    );
    expect(host.textContent).toBe('off:null');
    await act(async () => {
      state = { ...state, phase: 'unlocked' };
      listeners.forEach((f) => f());
    });
    expect(host.textContent).toBe('unavailable:false');
    act(() => root.unmount());
    semantic.dispose();
  });
});
