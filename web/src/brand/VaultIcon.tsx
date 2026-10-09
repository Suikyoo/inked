import { useRef } from 'react';

/** The ink drop of the busy-button loader (InkFill); vaults use the hexagon mark below. */
export const DROP = 'M8 1.2C7.2 3 3.3 6.5 3.3 10.1a4.7 4.7 0 0 0 9.4 0C12.7 6.5 8.8 3 8 1.2z';

export function inkLevelLabel(level: number): string {
  return `${Math.round(Math.max(0, Math.min(1, level)) * 100)}% of notes edited this week`;
}

const HEX = 'M12 2.5L20.23 7.25V16.75L12 21.5L3.77 16.75V7.25z';
const CORE = 'M12 7.6L15.81 9.8V14.2L12 16.4L8.19 14.2V9.8z';
/** Core to outline corner, lowest first, so the ink rises: bottom, lower sides, upper sides, top. */
const SPOKES = [
  'M12 16.4V21.5',
  'M8.19 14.2L3.77 16.75',
  'M15.81 14.2L20.23 16.75',
  'M8.19 9.8L3.77 7.25',
  'M15.81 9.8L20.23 7.25',
  'M12 7.6V2.5',
];

/** How many of the six spokes are drawn for `level` (0 to 1). The others are not drawn at all. */
export const spokeCount = (level: number): number => Math.round(Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0)) * SPOKES.length);

/** Stagger between spokes as they draw in or out. */
const SPOKE_STEP_MS = 45;

/**
 * A solid hexagon core inside an outline hexagon. Spokes join them from the bottom up as the share of notes
 * edited this week (`level`, activeNoteCount7d / max(noteCount, 1)) grows: none at 0, all six at 100%.
 * All six are always in the DOM: an unlit spoke is a stroke with nothing drawn, so a change in level draws the
 * spokes in (or out) one after another, and the core gives one pulse when ink is added. Nothing animates on mount.
 */
export function VaultIcon({ color, level, size = 14 }: { color: string; level: number; size?: number }) {
  const lvl = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
  const n = spokeCount(lvl);
  const last = useRef(n);
  const pulses = useRef(0);
  if (n > last.current) pulses.current++;
  last.current = n;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="vault-icon" aria-hidden="true" focusable="false">
      <title>{inkLevelLabel(lvl)}</title>
      <path d={HEX} fill="none" stroke={color} strokeWidth="1.3" strokeLinejoin="round" />
      {SPOKES.map((d, k) => (
        <path
          key={k}
          d={d}
          pathLength={1}
          data-lit={k < n ? '' : undefined}
          className={`vi-spoke${k < n ? ' is-lit' : ''}`}
          style={{ transitionDelay: `${(k < n ? k : SPOKES.length - 1 - k) * SPOKE_STEP_MS}ms` }}
          fill="none"
          stroke={color}
          strokeWidth="1.1"
          strokeLinecap="round"
        />
      ))}
      <path
        key={pulses.current}
        d={CORE}
        className={`vi-core${pulses.current > 0 ? ' is-pulse' : ''}`}
        fill={color}
        stroke={color}
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}
