import { mergeRank, normalizeQuery, type BodyHit, type FuzzyMatch, type SearchEntry, type SemanticInput, type Snippet, type TitleHit, type Why } from 'inked-core';

export interface SearchRow {
  entry: SearchEntry;
  why: Why;
  titleMatch: FuzzyMatch | null;
  snippet: Snippet | null;
  chunk: number | null;
}

/** Merge title, body-text and meaning hits into one ranked, tagged list. */
export function buildRows(titleHits: TitleHit[], bodyHits: BodyHit[], semantic: SemanticInput[], entries: SearchEntry[], query: string): SearchRow[] {
  const byId = new Map(entries.map((e) => [e.noteId, e]));
  const titleBy = new Map(titleHits.map((h) => [h.entry.noteId, h.match]));
  const snipBy = new Map(bodyHits.map((h) => [h.entry.noteId, h.snippet]));
  const nq = normalizeQuery(query);
  const exact = new Set(entries.filter((e) => normalizeQuery(e.text.slice(e.titleStart)) === nq).map((e) => e.noteId));
  const ranked = mergeRank(
    [
      ...titleHits.map((h) => ({ noteId: h.entry.noteId, kind: 'title' as const, score: h.match.score })),
      ...bodyHits.map((h) => ({ noteId: h.entry.noteId, kind: 'text' as const, score: 0 })),
    ],
    semantic.filter((s) => byId.has(s.noteId)),
    exact,
  );
  return ranked.map((r) => ({
    entry: byId.get(r.noteId)!,
    why: r.why,
    titleMatch: titleBy.get(r.noteId) ?? null,
    snippet: snipBy.get(r.noteId) ?? null,
    chunk: r.chunk,
  }));
}
