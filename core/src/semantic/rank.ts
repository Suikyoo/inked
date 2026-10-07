export const SEM_FLOOR = 0.55;
export const SEM_CEIL = 0.85;
export const AGREE = 0.15;
export const MAX_RESULTS = 30;
export const MAX_MEANING_ONLY = 8;
/** A substring hit in the note text: present, but weaker than a strong title match. Also the floor of the title scale. */
export const TEXT_HIT_SCORE = 0.5;

export type Why = 'title' | 'text' | 'meaning';
export interface FuzzyInput {
  noteId: string;
  kind: 'title' | 'text';
  /**
   * Raw `FuzzyMatch.score` for title hits; may be zero or negative. Title hits are min-max
   * normalised within the query into [TEXT_HIT_SCORE, 1] (all equal → 1). Text hits pass 0, which is ignored.
   */
  score: number;
}
export interface SemanticInput {
  noteId: string;
  similarity: number;
  chunk: number;
}
export interface Ranked {
  noteId: string;
  score: number;
  why: Why;
  fuzzy: number;
  semantic: number;
  chunk: number | null;
}

export const semanticScore = (similarity: number) =>
  Math.max(0, Math.min(1, (similarity - SEM_FLOOR) / (SEM_CEIL - SEM_FLOOR)));

export function mergeRank(
  fuzzy: readonly FuzzyInput[],
  semantic: readonly SemanticInput[],
  exactTitles: ReadonlySet<string>,
): Ranked[] {
  const titleScores = fuzzy.filter((h) => h.kind === 'title').map((h) => h.score);
  const lo = titleScores.length ? Math.min(...titleScores) : 0;
  const hi = titleScores.length ? Math.max(...titleScores) : 0;
  const fuzzyIds = new Set(fuzzy.map((h) => h.noteId));
  const rows = new Map<string, { fuzzy: number; kind: 'title' | 'text' | null; semantic: number; chunk: number | null }>();
  for (const h of fuzzy) {
    const f =
      h.kind === 'title'
        ? hi === lo
          ? 1
          : TEXT_HIT_SCORE + ((1 - TEXT_HIT_SCORE) * (h.score - lo)) / (hi - lo)
        : TEXT_HIT_SCORE;
    const prev = rows.get(h.noteId);
    if (!prev || f > prev.fuzzy) rows.set(h.noteId, { fuzzy: f, kind: h.kind, semantic: prev?.semantic ?? 0, chunk: prev?.chunk ?? null });
  }
  for (const h of semantic) {
    if (h.similarity <= SEM_FLOOR) continue;
    const s = semanticScore(h.similarity);
    const prev = rows.get(h.noteId) ?? { fuzzy: 0, kind: null, semantic: 0, chunk: null };
    if (s >= prev.semantic) rows.set(h.noteId, { ...prev, semantic: s, chunk: h.chunk });
  }
  const ranked: Ranked[] = [...rows].map(([noteId, r]) => ({
    noteId,
    fuzzy: r.fuzzy,
    semantic: r.semantic,
    chunk: r.chunk,
    score: Math.max(r.fuzzy, r.semantic) + AGREE * Math.min(r.fuzzy, r.semantic),
    why: r.kind && r.fuzzy >= r.semantic ? r.kind : 'meaning',
  }));
  ranked.sort(
    (a, b) =>
      Number(exactTitles.has(b.noteId)) - Number(exactTitles.has(a.noteId)) ||
      b.score - a.score ||
      (a.noteId < b.noteId ? -1 : 1),
  );
  const out: Ranked[] = [];
  let meaningOnly = 0;
  for (const r of ranked) {
    if (!fuzzyIds.has(r.noteId)) {
      if (meaningOnly >= MAX_MEANING_ONLY) continue;
      meaningOnly++;
    }
    out.push(r);
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}
