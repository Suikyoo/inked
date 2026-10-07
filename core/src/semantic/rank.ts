export const SEM_FLOOR = 0.55;
export const SEM_CEIL = 0.85;
export const AGREE = 0.15;
export const MAX_RESULTS = 30;
export const MAX_MEANING_ONLY = 8;
/** A substring hit in the note text: present, but weaker than a strong title match. */
export const TEXT_HIT_SCORE = 0.5;

export type Why = 'title' | 'text' | 'meaning';
export interface FuzzyInput {
  noteId: string;
  kind: 'title' | 'text';
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
  const maxTitle = Math.max(0, ...fuzzy.filter((h) => h.kind === 'title').map((h) => h.score));
  const rows = new Map<string, { fuzzy: number; kind: 'title' | 'text' | null; semantic: number; chunk: number | null }>();
  for (const h of fuzzy) {
    const f = h.kind === 'title' ? (maxTitle > 0 ? h.score / maxTitle : 1) : TEXT_HIT_SCORE;
    const prev = rows.get(h.noteId);
    if (!prev || f > prev.fuzzy) rows.set(h.noteId, { fuzzy: f, kind: h.kind, semantic: prev?.semantic ?? 0, chunk: prev?.chunk ?? null });
  }
  for (const h of semantic) {
    if (h.similarity < SEM_FLOOR) continue;
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
    if (r.fuzzy === 0) {
      if (meaningOnly >= MAX_MEANING_ONLY) continue;
      meaningOnly++;
    }
    out.push(r);
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}
