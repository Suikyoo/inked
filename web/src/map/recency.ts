export type InkTier = 'wet' | 'fresh' | 'drying' | 'dry';

const DAY = 86_400_000;

/** How wet a note's ink is: recency of its last edit. Unknown or future times read as wet. */
export function inkTier(updatedAt: string, now: number): InkTier {
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return 'wet';
  const age = now - t;
  if (age < DAY) return 'wet';
  if (age < 7 * DAY) return 'fresh';
  if (age < 30 * DAY) return 'drying';
  return 'dry';
}
