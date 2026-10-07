import { describe, expect, it } from 'vitest';
import { chunkNote, MAX_CHUNKS } from './chunk';
import { dequantize, quantize } from './quantize';
import { cosine, meanVector, noteScore, topK } from './similarity';
import { isFresh } from './fresh';

const unit = (...xs: number[]) => {
  const v = Float32Array.from(xs);
  const n = Math.hypot(...xs);
  return v.map((x) => x / n);
};
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('chunkNote', () => {
  it('returns just the title for an empty or whitespace-only body', () => {
    expect(chunkNote('Plan', '')).toEqual(['Plan']);
    expect(chunkNote('Plan', '  \n\t ')).toEqual(['Plan']);
  });
  it('returns nothing when title and body are both empty', () => {
    expect(chunkNote('  ', '')).toEqual([]);
  });
  it('prefixes the title to the first chunk only', () => {
    const out = chunkNote('Title', words(700));
    expect(out[0].startsWith('Title\n')).toBe(true);
    expect(out[1].startsWith('Title')).toBe(false);
  });
  it('overlaps consecutive chunks', () => {
    const out = chunkNote('', words(700));
    const last0 = out[0].split(' ').slice(-10);
    expect(out[1].split(' ').slice(0, 60)).toEqual(expect.arrayContaining(last0));
  });
  it('keeps a short body in one chunk', () => {
    expect(chunkNote('T', words(100))).toHaveLength(1);
  });
  it('caps at MAX_CHUNKS for a very long note', () => {
    expect(chunkNote('T', words(50_000))).toHaveLength(MAX_CHUNKS);
  });
});

describe('quantize', () => {
  it('round-trips within tolerance and stays unit length', () => {
    const v = unit(0.3, -0.7, 0.2, 0.6);
    const back = dequantize(quantize(v));
    expect(cosine(v, back)).toBeGreaterThan(0.999);
    expect(Math.hypot(...back)).toBeCloseTo(1, 5);
  });
  it('clamps to [-127, 127]', () => {
    const q = quantize(unit(1, 0, 0));
    expect(q[0]).toBe(127);
  });
});

describe('similarity', () => {
  it('noteScore takes the best chunk', () => {
    const q = unit(1, 0);
    expect(noteScore(q, [unit(0, 1), unit(1, 0.1)])).toEqual({ score: expect.closeTo(0.995, 2), chunk: 1 });
  });
  it('meanVector is renormalised', () => {
    const m = meanVector([unit(1, 0), unit(0, 1)]);
    expect(Math.hypot(...m)).toBeCloseTo(1, 5);
  });
  it('topK sorts, applies the floor and the limit', () => {
    const t = unit(1, 0);
    const c = [
      { id: 'a', vec: unit(1, 0.2) },
      { id: 'b', vec: unit(0, 1) },
      { id: 'c', vec: unit(1, 0.5) },
    ];
    expect(topK(t, c, 1, 0.55).map((x) => x.id)).toEqual(['a']);
    expect(topK(t, c, 5, 0.55).map((x) => x.id)).toEqual(['a', 'c']);
  });
});

describe('isFresh', () => {
  const note = { updatedAt: '2026-10-08T10:00:00.000Z' };
  it('needs the same model and a source no older than the note', () => {
    expect(isFresh({ model: 'm', sourceUpdatedAt: '2026-10-08T10:00:00.000Z' }, note, 'm')).toBe(true);
    expect(isFresh({ model: 'm', sourceUpdatedAt: '2026-10-08T09:59:59.999Z' }, note, 'm')).toBe(false);
    expect(isFresh({ model: 'old', sourceUpdatedAt: '2026-10-08T10:00:00.000Z' }, note, 'm')).toBe(false);
    expect(isFresh(undefined, note, 'm')).toBe(false);
  });
});
