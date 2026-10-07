import { useId } from 'react';
import { useReducedMotion } from '../motion';
import { DROP } from './VaultIcon';

/** Fill level while keys derive: 85% of the drop, as a y offset in the 16-unit viewBox. */
const PENDING_Y = 14.8 - 0.85 * 13.6;

/**
 * 14px ink drop for busy buttons. The ink rises toward 85% while work runs and
 * completes to 100% when `done`. Under reduced motion it stays still and pulses.
 */
export function InkFill({ done }: { done: boolean }) {
  const id = 'if-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const reduced = useReducedMotion();
  const cls = ['ink-fill', done ? 'is-done' : '', reduced ? 'is-static' : ''].filter(Boolean).join(' ');
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className={cls} aria-hidden="true" focusable="false">
      <defs>
        <mask id={`${id}-h`} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
          <rect width="16" height="16" fill="#fff" />
          <circle cx="8" cy="10.2" r="1.8" fill="#000" />
        </mask>
        <mask id={`${id}-f`} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
          <rect data-ink-level="" className="ink-fill-level" x="0" y={done ? 0 : PENDING_Y} width="16" height="16" fill="#fff" />
          <circle cx="8" cy="10.2" r="1.8" fill="#000" />
        </mask>
      </defs>
      <path d={DROP} fill="currentColor" opacity=".3" mask={`url(#${id}-h)`} />
      <path d={DROP} fill="currentColor" mask={`url(#${id}-f)`} />
    </svg>
  );
}
