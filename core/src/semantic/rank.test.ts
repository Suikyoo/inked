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
    const sem = Array.from({ length: 20 }, (_, i) => ({ noteId: `s${i}`, similarity: 0.9, chunk: 0 }));
    const fz = Array.from({ length: 40 }, (_, i) => ({ noteId: `f${i}`, kind: 'title' as const, score: 40 - i }));
    const r = mergeRank(fz, sem, new Set());
    expect(r.filter((x) => x.fuzzy === 0)).toHaveLength(MAX_MEANING_ONLY);
    expect(r).toHaveLength(MAX_RESULTS);
  });
  it('keeps negative and zero title scores in order, all within [0.5, 1]', () => {
    const r = mergeRank(
      [
        { noteId: 'neg', kind: 'title', score: -30 },
        { noteId: 'zero', kind: 'title', score: 0 },
        { noteId: 'top', kind: 'title', score: 5 },
      ],
      [],
      new Set(),
    );
    expect(r.map((x) => x.noteId)).toEqual(['top', 'zero', 'neg']);
    for (const x of r) {
      expect(x.fuzzy).toBeGreaterThanOrEqual(0.5);
      expect(x.fuzzy).toBeLessThanOrEqual(1);
    }
    const allNonPositive = mergeRank(
      [
        { noteId: 'a', kind: 'title', score: -30 },
        { noteId: 'b', kind: 'title', score: -10 },
        { noteId: 'c', kind: 'title', score: 0 },
      ],
      [],
      new Set(),
    );
    expect(allNonPositive.map((x) => x.noteId)).toEqual(['c', 'b', 'a']);
    expect(allNonPositive.map((x) => x.fuzzy)).toEqual([1, expect.closeTo(0.8333, 3), 0.5]);
  });
  it('does not count the lowest-scoring title hit as meaning-only', () => {
    const sem = Array.from({ length: 10 }, (_, i) => ({ noteId: `s${i}`, similarity: 0.9, chunk: 0 }));
    const r = mergeRank(
      [
        { noteId: 'top', kind: 'title', score: 10 },
        { noteId: 'low', kind: 'title', score: 0 },
      ],
      sem,
      new Set(),
    );
    expect(r.find((x) => x.noteId === 'low')).toBeDefined();
    expect(r.filter((x) => x.noteId.startsWith('s'))).toHaveLength(MAX_MEANING_ONLY);
  });
  it('drops semantic hits at exactly the floor', () => {
    expect(mergeRank([], [{ noteId: 'x', similarity: 0.55, chunk: 0 }], new Set())).toEqual([]);
  });
});
