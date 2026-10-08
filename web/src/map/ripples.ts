/** At most this many saved notes ripple at once; the rest only flash. */
export const RIPPLE_MAX = 6;
/** Each rippling dot starts this much after the one before it. */
export const RIPPLE_STAGGER_MS = 120;

export function planRipples(ids: readonly string[], onMap: ReadonlySet<string>): { ripple: { id: string; delay: number }[]; flash: string[] } {
  const unique = [...new Set(ids)].filter((id) => onMap.has(id));
  return {
    ripple: unique.slice(0, RIPPLE_MAX).map((id, i) => ({ id, delay: i * RIPPLE_STAGGER_MS })),
    flash: unique.slice(RIPPLE_MAX),
  };
}
