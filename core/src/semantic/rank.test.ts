import { describe, expect, it } from 'vitest';
import { mergeRank, semanticScore, MAX_MEANING_ONLY, MAX_RESULTS } from './rank';

describe('semanticScore', () => {
  it('maps the floor to 0, the ceiling and above to 1', () => {
    expect(semanticScore(0.55)).toBe(0);
    expect(semanticScore(0.7)).toBeCloseTo(0.5);
    expect(semanticScore(0.95)).toBe(1);
    expect(semanticScore(0.3)).toBe(0);
  });
});

describe('mergeRank', () => {
  it('normalises title scores within the query and gives text hits 0.5', () => {
    const r = mergeRank(
      [
        { noteId: 'a', kind: 'title', score: 80 },
        { noteId: 'b', kind: 'title', score: 40 },
        { noteId: 'c', kind: 'text', score: 0 },
      ],
      [],
      new Set(),
    );
    expect(r.map((x) => [x.noteId, x.fuzzy])).toEqual([
      ['a', 1],
      ['b', 0.5],
      ['c', 0.5],
    ]);
  });
  it('combines both signals with a bonus for agreement', () => {
    const [x] = mergeRank([{ noteId: 'a', kind: 'title', score: 10 }], [{ noteId: 'a', similarity: 0.7, chunk: 2 }], new Set());
    expect(x.score).toBeCloseTo(1 + 0.15 * 0.5);
    expect(x.why).toBe('title');
    expect(x.chunk).toBe(2);
  });
  it('tags meaning when semantic is the stronger signal and drops sub-floor matches', () => {
    const r = mergeRank([{ noteId: 't', kind: 'text', score: 0 }], [
      { noteId: 't', similarity: 0.85, chunk: 0 },
      { noteId: 'm', similarity: 0.8, chunk: 1 },
      { noteId: 'z', similarity: 0.5, chunk: 0 },
    ], new Set());
    expect(r.find((x) => x.noteId === 't')!.why).toBe('meaning');
    expect(r.find((x) => x.noteId === 'm')!.why).toBe('meaning');
    expect(r.find((x) => x.noteId === 'z')).toBeUndefined();
  });
  it('pins exact title matches first', () => {
    const r = mergeRank(
      [
        { noteId: 'exact', kind: 'title', score: 5 },
        { noteId: 'other', kind: 'title', score: 50 },
      ],
      [],
      new Set(['exact']),
    );
    expect(r[0].noteId).toBe('exact');
  });
  it('caps meaning-only results and the total', () => {
    const sem = Array.from({ length: 20 }, (_, i) => ({ noteId: `s${i}`, similarity: 0.8, chunk: 0 }));
    const fz = Array.from({ length: 40 }, (_, i) => ({ noteId: `f${i}`, kind: 'title' as const, score: 40 - i }));
    const r = mergeRank(fz, sem, new Set());
    expect(r.filter((x) => x.fuzzy === 0)).toHaveLength(MAX_MEANING_ONLY);
    expect(r).toHaveLength(MAX_RESULTS);
  });
});
