import { useCallback, useEffect, useRef, useState } from 'react';

type Phase = 'closed' | 'enter' | 'open' | 'exit';
export type PresenceState = 'enter' | 'open' | 'exit';
export type PresenceRef = (el: HTMLElement | SVGElement | null) => void;

/**
 * Keeps an element mounted while it animates out. Render while `mounted`, put `ref` and
 * `data-state={state}` on the animated root, and let CSS animate enter/exit. Unmounting waits
 * for animationend/transitionend on that root, or `exitMs + 50` as a fallback.
 */
export function usePresence(open: boolean, exitMs: number): { mounted: boolean; state: PresenceState; ref: PresenceRef } {
  const [phase, setPhase] = useState<Phase>('closed');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const elRef = useRef<HTMLElement | SVGElement | null>(null);
  const ref = useCallback<PresenceRef>((el) => {
    elRef.current = el;
  }, []);

  useEffect(() => {
    if (open) {
      if (phaseRef.current === 'closed') setPhase('enter');
      const settle = () => setPhase('open');
      if (typeof requestAnimationFrame === 'function') {
        // Double rAF so the [data-state=enter] styles resolve before the transition starts.
        let inner = 0;
        const outer = requestAnimationFrame(() => {
          inner = requestAnimationFrame(settle);
        });
        return () => {
          cancelAnimationFrame(outer);
          cancelAnimationFrame(inner);
        };
      }
      const id = setTimeout(settle, 0);
      return () => clearTimeout(id);
    }
    // Closing: nothing to animate if it never mounted.
    if (phaseRef.current === 'closed') return;
    setPhase('exit');
    const el = elRef.current;
    const done = () => setPhase('closed');
    // animationend/transitionend bubble: only the root's own events count.
    const onEnd = (e: Event) => {
      if (e.target === el) done();
    };
    el?.addEventListener('animationend', onEnd);
    el?.addEventListener('transitionend', onEnd);
    const id = setTimeout(done, exitMs + 50);
    return () => {
      clearTimeout(id);
      el?.removeEventListener('animationend', onEnd);
      el?.removeEventListener('transitionend', onEnd);
    };
  }, [open, exitMs]);

  return { mounted: phase !== 'closed', state: phase === 'closed' ? 'exit' : phase, ref };
}
