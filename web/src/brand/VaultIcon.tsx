import { useId } from 'react';

export const DROP = 'M8 1.2C7.2 3 3.3 6.5 3.3 10.1a4.7 4.7 0 0 0 9.4 0C12.7 6.5 8.8 3 8 1.2z';

export function inkLevelLabel(level: number): string {
  return `${Math.round(Math.max(0, Math.min(1, level)) * 100)}% of notes edited this week`;
}

/**
 * Tip-up ink drop with a node hole. The fill rises with `level`
 * (activeNoteCount7d / max(noteCount, 1)).
 */
export function VaultIcon({ color, level, size = 14 }: { color: string; level: number; size?: number }) {
  const base = 'vi-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const lvl = Math.max(0, Math.min(1, Number.isFinite(level) ? level : 0));
  const y = (14.8 - lvl * 13.6).toFixed(2);
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="vault-icon" aria-hidden="true" focusable="false">
      <title>{inkLevelLabel(lvl)}</title>
      <defs>
        <mask id={`${base}-h`} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
          <rect width="16" height="16" fill="#fff" />
          <circle cx="8" cy="10.2" r="1.8" fill="#000" />
        </mask>
        <mask id={`${base}-f`} maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
          <rect x="0" y={y} width="16" height="16" fill="#fff" />
          <circle cx="8" cy="10.2" r="1.8" fill="#000" />
        </mask>
      </defs>
      <path d={DROP} fill={color} opacity=".3" mask={`url(#${base}-h)`} />
      <path d={DROP} fill={color} mask={`url(#${base}-f)`} />
    </svg>
  );
}
