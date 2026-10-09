import { cosine } from '../semantic/similarity';

export const RAG_K = 8;
export const RAG_FLOOR = 0.45;
export const RAG_PER_NOTE = 2;

export interface ChunkHit {
  noteId: string;
  chunk: number;
  score: number;
}

/** Best chunks across notes for a query vector: floor, then at most perNote per note, then the top k. */
export function retrieve(
  query: Float32Array,
  candidates: readonly { noteId: string; chunks: readonly Float32Array[] }[],
  opts: { k?: number; floor?: number; perNote?: number } = {},
): ChunkHit[] {
  const { k = RAG_K, floor = RAG_FLOOR, perNote = RAG_PER_NOTE } = opts;
  const all: ChunkHit[] = [];
  for (const c of candidates) c.chunks.forEach((v, chunk) => {
    const score = cosine(query, v);
    if (score >= floor) all.push({ noteId: c.noteId, chunk, score });
  });
  all.sort((a, b) => b.score - a.score || (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : a.chunk - b.chunk));
  const per = new Map<string, number>();
  const out: ChunkHit[] = [];
  for (const h of all) {
    const n = per.get(h.noteId) ?? 0;
    if (n >= perNote) continue;
    per.set(h.noteId, n + 1);
    out.push(h);
    if (out.length >= k) break;
  }
  return out;
}
