import { normalize } from './quantize';

/** Dot product; inputs are unit vectors, so this is the cosine similarity. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function noteScore(query: Float32Array, chunks: readonly Float32Array[]): { score: number; chunk: number } {
  let best = -Infinity;
  let at = -1;
  chunks.forEach((c, i) => {
    const s = cosine(query, c);
    if (s > best) {
      best = s;
      at = i;
    }
  });
  return { score: best, chunk: at };
}

export function meanVector(chunks: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(chunks[0]?.length ?? 0);
  for (const c of chunks) for (let i = 0; i < c.length; i++) out[i] += c[i];
  return normalize(out);
}

export function topK(
  target: Float32Array,
  candidates: readonly { id: string; vec: Float32Array }[],
  k: number,
  floor: number,
): { id: string; similarity: number }[] {
  return candidates
    .map((c) => ({ id: c.id, similarity: cosine(target, c.vec) }))
    .filter((c) => c.similarity >= floor)
    .sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : 1))
    .slice(0, k);
}
