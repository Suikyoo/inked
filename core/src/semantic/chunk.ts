export const EMBED_DIM = 384;
export const CHUNK_TOKENS = 400;
export const CHUNK_OVERLAP = 64;
export const MAX_CHUNKS = 16;
/** Approximate tokens per whitespace-separated word; the real tokenizer only runs in the worker. */
const TOKENS_PER_WORD = 1.3;

/** Approximate token count, the same estimate the chunker uses. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * TOKENS_PER_WORD);
}

/** Splits a note into overlapping windows for embedding; the title leads the first chunk. */
export function chunkNote(title: string, body: string): string[] {
  const head = title.trim();
  const words = body.split(/\s+/).filter(Boolean);
  if (words.length === 0) return head ? [head] : [];
  const per = Math.floor(CHUNK_TOKENS / TOKENS_PER_WORD);
  const step = per - Math.floor(CHUNK_OVERLAP / TOKENS_PER_WORD);
  const out: string[] = [];
  for (let i = 0; out.length < MAX_CHUNKS; i += step) {
    out.push(words.slice(i, i + per).join(' '));
    if (i + per >= words.length) break;
  }
  if (head) out[0] = `${head}\n${out[0]}`;
  return out;
}
