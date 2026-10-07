# Semantic Search and Map Cues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Round 4a adds opt-in semantic search: an in-browser embedding model, vectors stored encrypted on the server, a merged search ranking with a tag saying why each result matched, progress bars, and "Related" notes in the preview panel. Round 4b gives the Home concept map a shared lit state (hover, focus and click), link-density rings, meaning threads and live ripples when notes are saved.

**Architecture:**
- Pure maths and crypto live in `core` (`core/src/semantic/*`, plus a new vector field in `core/src/crypto`).
- The server stores opaque vector ciphertext in a new `note_vectors` table. It also serves the model files from `web/dist/models/`, which the Docker build fills when `INKED_SEMANTIC=1`.
- In the browser:
  - a Web Worker runs transformers.js;
  - a `SemanticStore` next to the `AppStore` owns vectors, the embedding queue, coverage and the model phase;
  - Home, Settings, NodePreview and ConceptMap read it through a React context.
- The map cues are a set of class toggles and small overlay layers on the existing `ConceptMap` SVG. They are fed by pure helpers (`litSet`, `planRipples`) and a new `AppStore` "notes saved" event.

**Tech Stack:** TypeScript, React 18, Vite 8, vitest + jsdom, Fastify + node:sqlite, `@huggingface/transformers` (new; ONNX runtime WASM), WebCrypto AES-GCM.

**Specs:**
- `docs/superpowers/specs/2026-10-08-semantic-search-design.md` (4a)
- `docs/superpowers/specs/2026-10-08-map-cues-design.md` (4b)

## Global Constraints

### Zero-knowledge
- The server never sees plaintext, and never sees plaintext vectors.
- Embeddings are computed only in the browser.
- Stored vectors are encrypted with the vault key.

### Semantic model
- Model: `Xenova/bge-small-en-v1.5`, int8-quantized ONNX (`onnx/model_quantized.onnx`). It produces 384-dimensional vectors with CLS pooling, normalised. Query prefix: `Represent this sentence for searching relevant passages: `.
- Chunking: about 400 tokens per chunk with 64 tokens of overlap, at most 16 chunks per note, and the title prepended to the first chunk. Approximate tokens as words × 1.3.

### Search scoring
- Semantic floor 0.55, ceiling 0.85: `s = clamp((sim − 0.55) / 0.30, 0, 1)`.
- Merged score: `max(f, s) + 0.15 × min(f, s)`. Exact title matches always come first.
- At most 30 results, and at most 8 that match only by meaning.
- Semantic search runs only for queries of 3+ characters, debounced 250 ms.

### Opt-in and loading
- Per-device toggle "Search by meaning", off by default, stored in `prefs`.
- Per-deployment build arg `INKED_SEMANTIC` (default `1`). When `/models/manifest.json` returns 404, the toggle is hidden.
- When the toggle is off, no worker, transformers.js or model may load. Semantic code sits behind dynamic `import()`.

### Policies
- Vector freshness: `vector.model === currentModel && Date.parse(vector.sourceUpdatedAt) >= Date.parse(note.updatedAt)`.
- Upload retry backoff: 1 s, 4 s, 16 s, then the next save or unlock. On 422, drop the vector and re-queue the note.
- Ripples: `RIPPLE_MAX = 6`, `RIPPLE_STAGGER_MS = 120`.
- Click ring 700 ms. Thread draw 640 ms, staggered 90 ms. Pulse 420 ms at delay `520 + 90 × i` ms. Flowing links 1.4 s loop. Threads 2.2 s loop.

### Tokens, motion, security
- Colours come from `web/src/styles/tokens.css`: `--ink-wet` #b69cff, `--ink-fresh`, `--ink-drying`, `--ink-dry`, `--ink-lighter` #d6c8ff. Motion tokens: `--dur-1..4`, `--dur-ink`, `--ease-out`.
- Every new animation has a `prefers-reduced-motion: reduce` path: no rings or pulses, static threads and links, instant dimming.
- The CSP in `server/src/app.ts` stays unchanged: `script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self'`. No CDN fetches at runtime: `env.allowRemoteModels = false`, and the WASM paths are on the same origin.

### Process
- New dependencies: only `@huggingface/transformers`, pinned to an exact version published at least 2 weeks before 2026-10-08. Use the newest 3.x that qualifies, and record it in the task report.
- Tests:
  - `npm test -w core`
  - `npm test -w server`
  - `npm test -w web`
  - `npm run build -w web`
  - All must stay green after every task.
- Local Docker only with `docker compose -p inked-test -f compose.yaml -f compose.local.yaml …`, followed by `down -v`. Never join or touch the external `cloudflared-net` network.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A note edited while it is being embedded.** The vector upload gets 422 (or arrives stale). It must be dropped and the note re-queued, never stored as fresh. Tested in Task 7.
2. **Locking mid-embed or mid-upload.** Nothing may upload after the lock, the worker must be terminated, and decrypted vectors must be dropped. Tested in Task 7.
3. **A deployment without the model.** The SPA fallback would answer `/models/manifest.json` with `index.html` 200. The server must return 404 for `/models/*`, and the client must treat non-JSON as "unavailable". Tested in Tasks 4 and 6.
4. **Edge-case note sizes.** An empty note (title only), a whitespace-only body, and a note longer than 16 chunks must chunk sanely. Tested in Task 1.
5. **An MCP burst of 50 saves.** The embed queue must hold each note once, re-debounced. Ripples must be capped at 6, with the rest flash-only. Tested in Tasks 7 and 14.

---

## File Structure

**core**
- `core/src/semantic/chunk.ts`: `chunkNote`.
- `core/src/semantic/quantize.ts`: int8 quantize/dequantize.
- `core/src/semantic/similarity.ts`: cosine, `noteScore`, `meanVector`, `topK`.
- `core/src/semantic/fresh.ts`: `isFresh`.
- `core/src/semantic/rank.ts`: `mergeRank` and its constants.
- `core/src/semantic/index.ts`: barrel export.
- `core/src/crypto/aad.ts` (modify): `aad.noteVector`.
- `core/src/crypto/fields.ts` (modify): `encryptNoteVector`, `decryptNoteVector`.
- `core/src/index.ts` (modify): export `./semantic`.

**server**
- `server/src/db.ts` (modify): `note_vectors` table and `NoteVectorRow`.
- `server/src/routes/vectors.ts`: GET vault vectors, PUT note vector.
- `server/src/schemas.ts` (modify): `encVec`, `modelName`.
- `server/src/app.ts` (modify): register the vector routes, `/models/*` cache headers, and 404 for missing `/models/*`.
- `server/test/vectors.test.ts`.

**build**
- `scripts/fetch-model.mjs`: downloads the pinned model, checks hashes, copies the ORT WASM files, writes the manifest.
- `Dockerfile`, `compose.yaml`, `.gitignore`, `web/package.json` (modify).
- `docs/deploy.md` (modify).

**web semantic**
- `web/src/semantic/manifest.ts`: `Manifest` type and `fetchManifest`.
- `web/src/semantic/protocol.ts`: worker message types.
- `web/src/semantic/embedder.worker.ts`: transformers.js in the worker.
- `web/src/semantic/embedderClient.ts`: `Embedder` (promise wrapper, restart once).
- `web/src/semantic/modelCache.ts`: cache verification, clearing, persistence.
- `web/src/semantic/semanticStore.ts`: `SemanticStore`.
- `web/src/semantic/SemanticContext.tsx`: provider and `useSemantic`, `useSemanticStore`.
- `web/src/lib/prefs.ts` (modify): `semantic()`, `setSemantic()`.
- `web/src/api/client.ts` (modify): `listVectors`, `putVector`.
- `web/src/state/store.ts` (modify):
  - `onNotesSaved`, `consumeUnseenSaves`;
  - `encryptVector`, `decryptVector`;
  - `noteHead`.

**web UI**
- `web/src/pages/SettingsPage.tsx` (modify): the "Search by meaning" card.
- `web/src/components/ProgressBar.tsx`: a shared bar.
- `web/src/pages/HomePage.tsx`, `web/src/pages/searchRows.ts`: merged ranking rows, why tags, indexing bar.
- `web/src/pages/NodePreview.tsx` (modify): the Related list.

**map (4b)**
- `web/src/map/scene.ts` (modify): `SceneDot.degree`, `LinkSeg` (`a`, `b`).
- `web/src/map/lit.ts`: `litSet`, `mapFocus`.
- `web/src/map/ripples.ts`: `planRipples` and `useRipples`.
- `web/src/map/ConceptMap.tsx` (modify), `web/src/styles/map.css` (modify).
- `DESIGN.md` (modify).

---

## Task 1: core semantic maths (chunk, quantize, similarity, freshness)

**Files:**
- Create: `core/src/semantic/chunk.ts`, `core/src/semantic/quantize.ts`, `core/src/semantic/similarity.ts`, `core/src/semantic/fresh.ts`, `core/src/semantic/index.ts`
- Modify: `core/src/index.ts`
- Test: `core/src/semantic/semantic.test.ts`

**Interfaces:**
- Produces:
  - `chunkNote(title: string, body: string): string[]`
  - `EMBED_DIM = 384`, `MAX_CHUNKS = 16`
  - `quantize(v: Float32Array): Int8Array`, `dequantize(q: Int8Array): Float32Array`
  - `cosine(a: Float32Array, b: Float32Array): number`
  - `noteScore(query: Float32Array, chunks: readonly Float32Array[]): { score: number; chunk: number }`
  - `meanVector(chunks: readonly Float32Array[]): Float32Array`
  - `topK(target: Float32Array, candidates: readonly { id: string; vec: Float32Array }[], k: number, floor: number): { id: string; similarity: number }[]`
  - `isFresh(v: { model: string; sourceUpdatedAt: string } | undefined, note: { updatedAt: string }, model: string): boolean`

- [ ] **Step 1: Write the failing tests**

```ts
// core/src/semantic/semantic.test.ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w core -- semantic`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 3: Implement**

```ts
// core/src/semantic/chunk.ts
export const EMBED_DIM = 384;
export const CHUNK_TOKENS = 400;
export const CHUNK_OVERLAP = 64;
export const MAX_CHUNKS = 16;
/** Approximate tokens per whitespace-separated word; the real tokenizer only runs in the worker. */
const TOKENS_PER_WORD = 1.3;

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
```

```ts
// core/src/semantic/quantize.ts
function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

/** Unit-normalises, then scales to int8 (×127, rounded, clamped). */
export function quantize(v: Float32Array): Int8Array {
  const u = normalize(v);
  const out = new Int8Array(u.length);
  for (let i = 0; i < u.length; i++) out[i] = Math.max(-127, Math.min(127, Math.round(u[i] * 127)));
  return out;
}

export function dequantize(q: Int8Array): Float32Array {
  const v = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) v[i] = q[i] / 127;
  return normalize(v);
}

export { normalize };
```

```ts
// core/src/semantic/similarity.ts
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
```

```ts
// core/src/semantic/fresh.ts
/** A stored vector still describes the note: same model, computed from this version or a later one. */
export function isFresh(
  v: { model: string; sourceUpdatedAt: string } | undefined,
  note: { updatedAt: string },
  model: string,
): boolean {
  return !!v && v.model === model && Date.parse(v.sourceUpdatedAt) >= Date.parse(note.updatedAt);
}
```

```ts
// core/src/semantic/index.ts
export * from './chunk';
export { quantize, dequantize } from './quantize';
export * from './similarity';
export * from './fresh';
```

Add `export * from './semantic';` to `core/src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w core`
Expected: PASS (all core tests).

- [ ] **Step 5: Commit**

```bash
git add core/src/semantic core/src/index.ts
git commit -m "feat(core): chunking, int8 quantization, similarity and freshness for semantic search

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: core merged ranking

**Files:**
- Create: `core/src/semantic/rank.ts`
- Modify: `core/src/semantic/index.ts`
- Test: `core/src/semantic/rank.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `SEM_FLOOR = 0.55`, `SEM_CEIL = 0.85`, `AGREE = 0.15`, `MAX_RESULTS = 30`, `MAX_MEANING_ONLY = 8`, `TEXT_HIT_SCORE = 0.5`
  - `type Why = 'title' | 'text' | 'meaning'`
  - `interface FuzzyInput { noteId: string; kind: 'title' | 'text'; score: number }`. `score` is the raw `FuzzyMatch.score` for title hits; text hits pass 0, which is ignored.
  - `interface SemanticInput { noteId: string; similarity: number; chunk: number }`
  - `interface Ranked { noteId: string; score: number; why: Why; fuzzy: number; semantic: number; chunk: number | null }`
  - `semanticScore(similarity: number): number`
  - `mergeRank(fuzzy: readonly FuzzyInput[], semantic: readonly SemanticInput[], exactTitles: ReadonlySet<string>): Ranked[]`

- [ ] **Step 1: Write the failing tests**

```ts
// core/src/semantic/rank.test.ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w core -- rank`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// core/src/semantic/rank.ts
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
```

Add `export * from './rank';` to `core/src/semantic/index.ts`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/semantic
git commit -m "feat(core): merged fuzzy + semantic ranking with why tags

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: core encrypted vector field

**Files:**
- Modify: `core/src/crypto/aad.ts`, `core/src/crypto/fields.ts`
- Test: `core/src/crypto/vector.test.ts`

**Interfaces:**
- Consumes: `EMBED_DIM`, `MAX_CHUNKS` (Task 1).
- Produces:
  - `aad.noteVector(vaultId: string, noteId: string, model: string): string`, which returns `inked/note-vector/${vaultId}/${noteId}/${model}`
  - `encryptNoteVector(key: CryptoKey, vaultId: string, noteId: string, model: string, chunks: readonly Int8Array[]): Promise<string>`
  - `decryptNoteVector(key: CryptoKey, vaultId: string, noteId: string, model: string, ct: string): Promise<Int8Array[]>`, which throws `CryptoError('format')` on a bad shape.

Ruling: the spec wrote the AAD as `vec|noteId|model`. The house AAD style (`inked/<kind>/<vault>/<id>`) wins, with the vault id added. It binds the same things.

- [ ] **Step 1: Write the failing test**

```ts
// core/src/crypto/vector.test.ts
import { describe, expect, it } from 'vitest';
import { decryptNoteVector, encryptNoteVector } from './fields';
import { CryptoError } from './errors';

const key = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
const row = (seed: number) => Int8Array.from({ length: 384 }, (_, i) => ((i * seed) % 255) - 127);

describe('note vector field', () => {
  it('round-trips chunk rows', async () => {
    const k = await key();
    const ct = await encryptNoteVector(k, 'v', 'n', 'm@1', [row(3), row(7)]);
    const back = await decryptNoteVector(k, 'v', 'n', 'm@1', ct);
    expect(back.map((r) => Array.from(r))).toEqual([Array.from(row(3)), Array.from(row(7))]);
  });
  it('fails when moved to another note or model', async () => {
    const k = await key();
    const ct = await encryptNoteVector(k, 'v', 'n', 'm@1', [row(3)]);
    await expect(decryptNoteVector(k, 'v', 'other', 'm@1', ct)).rejects.toBeInstanceOf(CryptoError);
    await expect(decryptNoteVector(k, 'v', 'n', 'm@2', ct)).rejects.toBeInstanceOf(CryptoError);
  });
  it('rejects zero or too many chunks when encrypting', async () => {
    const k = await key();
    await expect(encryptNoteVector(k, 'v', 'n', 'm', [])).rejects.toThrow();
    await expect(encryptNoteVector(k, 'v', 'n', 'm', Array.from({ length: 17 }, () => row(1)))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w core -- vector`
Expected: FAIL (`encryptNoteVector` is not exported).

- [ ] **Step 3: Implement**

In `core/src/crypto/aad.ts`, add inside `aad`:

```ts
  noteVector: (vaultId: string, noteId: string, model: string) => `inked/note-vector/${vaultId}/${noteId}/${model}`,
```

In `core/src/crypto/fields.ts`, append:

```ts
import { EMBED_DIM, MAX_CHUNKS } from '../semantic/chunk';

/** Plaintext: [chunk count: u8][count × EMBED_DIM int8]. */
export async function encryptNoteVector(
  key: CryptoKey,
  vaultId: string,
  noteId: string,
  model: string,
  chunks: readonly Int8Array[],
): Promise<string> {
  if (chunks.length < 1 || chunks.length > MAX_CHUNKS || chunks.some((c) => c.length !== EMBED_DIM)) {
    throw new CryptoError('format', 'Vector has the wrong shape');
  }
  const buf = new Uint8Array(1 + chunks.length * EMBED_DIM);
  buf[0] = chunks.length;
  chunks.forEach((c, i) => buf.set(new Uint8Array(c.buffer, c.byteOffset, c.length), 1 + i * EMBED_DIM));
  return encryptBytes(key, buf, aad.noteVector(vaultId, noteId, model));
}

export async function decryptNoteVector(
  key: CryptoKey,
  vaultId: string,
  noteId: string,
  model: string,
  ct: string,
): Promise<Int8Array[]> {
  const buf = await decryptBytes(key, ct, aad.noteVector(vaultId, noteId, model));
  const n = buf[0];
  if (!n || n > MAX_CHUNKS || buf.length !== 1 + n * EMBED_DIM) throw new CryptoError('format', 'Vector has the wrong shape');
  return Array.from({ length: n }, (_, i) => new Int8Array(buf.buffer, buf.byteOffset + 1 + i * EMBED_DIM, EMBED_DIM).slice());
}
```

(Place the import at the top of the file with the other imports, and check `CryptoError` accepts `'format'`, as `decryptJSON` already uses it.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/src/crypto
git commit -m "feat(core): encrypted note vector field bound to vault, note and model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: server vector storage and model file serving

**Files:**
- Modify: `server/src/db.ts`, `server/src/schemas.ts`, `server/src/app.ts`
- Create: `server/src/routes/vectors.ts`
- Test: `server/test/vectors.test.ts`. Also update `server/test/data.test.ts` if its "every data route" X-Inked-User test lists routes: add the two new routes there.

**Interfaces:**
- Produces HTTP:
  - `GET /api/vaults/:id/vectors` returns `{ vectors: { noteId: string; model: string; encVec: string; sourceUpdatedAt: string }[] }`.
  - `PUT /api/notes/:id/vector` takes `{ model, encVec, sourceUpdatedAt }` and returns `{ ok: true }`. It answers 422 `stale` when `sourceUpdatedAt` is later than the note's `updated_at`, and 400 for an invalid date.
  - `GET /models/<path>` serves static files from `<webDist>/models/`. `manifest.json` gets `cache-control: no-cache`, other files `public, max-age=31536000, immutable`. A missing file returns 404 JSON, never the SPA fallback.

Ruling: the spec says vector PUTs are "rate-limited like note saves". Note saves have no limiter, so none is added. The body schema caps the size.

- [ ] **Step 1: Write the failing tests**

```ts
// server/test/vectors.test.ts
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Account, call, fakeCipher, inviteUser, makeApp, setupAdmin, type TestApp } from './helpers.js';

let t: TestApp;
let alice: Account;
let bob: Account;
beforeEach(async () => {
  t = await makeApp();
  alice = await setupAdmin(t.app, 'alice');
  bob = await inviteUser(t.app, alice, 'bob');
});
afterEach(async () => {
  await t.close();
});

const as = (who: Account) => ({
  get: (url: string) => call(t.app, 'GET', url, { cookie: who.cookie }),
  post: (url: string, body: unknown) => call(t.app, 'POST', url, { cookie: who.cookie, body }),
  put: (url: string, body: unknown) => call(t.app, 'PUT', url, { cookie: who.cookie, body }),
  del: (url: string) => call(t.app, 'DELETE', url, { cookie: who.cookie }),
});

async function vaultWithNote(who: Account) {
  const vaultId = randomUUID();
  expect((await as(who).post('/api/vaults', { id: vaultId, encMeta: fakeCipher(), wrappedKey: fakeCipher(60) })).statusCode).toBe(200);
  const noteId = randomUUID();
  const res = await as(who).post(`/api/vaults/${vaultId}/notes`, { id: noteId, folderId: null, encMeta: fakeCipher(), encBody: fakeCipher() });
  return { vaultId, noteId, updatedAt: res.json().note.updatedAt as string };
}

describe('note vectors', () => {
  it('stores, lists and replaces a vector without touching the note', async () => {
    const { vaultId, noteId, updatedAt } = await vaultWithNote(alice);
    const body = { model: 'bge-small-en-v1.5@abcd1234', encVec: fakeCipher(1600), sourceUpdatedAt: updatedAt };
    expect((await as(alice).put(`/api/notes/${noteId}/vector`, body)).statusCode).toBe(200);
    const again = { ...body, encVec: fakeCipher(1600) };
    expect((await as(alice).put(`/api/notes/${noteId}/vector`, again)).statusCode).toBe(200);
    const list = (await as(alice).get(`/api/vaults/${vaultId}/vectors`)).json().vectors;
    expect(list).toEqual([{ noteId, model: body.model, encVec: again.encVec, sourceUpdatedAt: updatedAt }]);
    const note = (await as(alice).get(`/api/notes/${noteId}`)).json().note;
    expect(note.updatedAt).toBe(updatedAt);
  });
  it('answers 422 for a sourceUpdatedAt newer than the note and 400 for a bad date', async () => {
    const { noteId } = await vaultWithNote(alice);
    const future = new Date(Date.now() + 60_000).toISOString();
    const r = await as(alice).put(`/api/notes/${noteId}/vector`, { model: 'm', encVec: fakeCipher(), sourceUpdatedAt: future });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe('stale');
    const bad = await as(alice).put(`/api/notes/${noteId}/vector`, { model: 'm', encVec: fakeCipher(), sourceUpdatedAt: 'nope' });
    expect(bad.statusCode).toBe(400);
  });
  it('validates the model name and size', async () => {
    const { noteId, updatedAt } = await vaultWithNote(alice);
    const badModel = await as(alice).put(`/api/notes/${noteId}/vector`, { model: 'a b', encVec: fakeCipher(), sourceUpdatedAt: updatedAt });
    expect(badModel.statusCode).toBe(400);
    const huge = await as(alice).put(`/api/notes/${noteId}/vector`, { model: 'm', encVec: fakeCipher(8000), sourceUpdatedAt: updatedAt });
    expect(huge.statusCode).toBe(400);
  });
  it("keeps users apart: 404 for another user's note or vault", async () => {
    const { vaultId, noteId, updatedAt } = await vaultWithNote(alice);
    expect((await as(bob).put(`/api/notes/${noteId}/vector`, { model: 'm', encVec: fakeCipher(), sourceUpdatedAt: updatedAt })).statusCode).toBe(404);
    expect((await as(bob).get(`/api/vaults/${vaultId}/vectors`)).statusCode).toBe(404);
  });
  it('deletes vectors with their note and their vault', async () => {
    const { vaultId, noteId, updatedAt } = await vaultWithNote(alice);
    await as(alice).put(`/api/notes/${noteId}/vector`, { model: 'm', encVec: fakeCipher(), sourceUpdatedAt: updatedAt });
    await as(alice).del(`/api/notes/${noteId}`);
    expect((await as(alice).get(`/api/vaults/${vaultId}/vectors`)).json().vectors).toEqual([]);
    const other = await vaultWithNote(alice);
    await as(alice).put(`/api/notes/${other.noteId}/vector`, { model: 'm', encVec: fakeCipher(), sourceUpdatedAt: other.updatedAt });
    expect((await as(alice).del(`/api/vaults/${other.vaultId}`)).statusCode).toBe(200);
    const left = t.app.db.prepare('SELECT COUNT(*) AS n FROM note_vectors').get() as { n: number };
    expect(left.n).toBe(0);
  });
  it('requires a session', async () => {
    expect((await call(t.app, 'GET', `/api/vaults/${randomUUID()}/vectors`)).statusCode).toBe(401);
  });
});

describe('model files', () => {
  it('serves models with immutable caching, the manifest with no-cache, and 404 when missing', async () => {
    const web = path.join(t.dataDir, 'web');
    mkdirSync(path.join(web, 'models', 'abcd1234'), { recursive: true });
    writeFileSync(path.join(web, 'index.html'), '<!doctype html>');
    writeFileSync(path.join(web, 'models', 'manifest.json'), '{"model":"m"}');
    writeFileSync(path.join(web, 'models', 'abcd1234', 'config.json'), '{}');
    const s = await makeApp({ webDist: web });
    try {
      const m = await call(s.app, 'GET', '/models/manifest.json');
      expect(m.statusCode).toBe(200);
      expect(m.headers['cache-control']).toBe('no-cache');
      const f = await call(s.app, 'GET', '/models/abcd1234/config.json');
      expect(f.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      const missing = await call(s.app, 'GET', '/models/nope.json');
      expect(missing.statusCode).toBe(404);
      expect(missing.headers['content-type']).toMatch(/json/);
    } finally {
      await s.close();
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w server -- vectors`
Expected: FAIL (404 for the routes, and the cache header assertions).

- [ ] **Step 3: Implement**

`server/src/db.ts`: append to `SCHEMA`:

```sql
CREATE TABLE IF NOT EXISTS note_vectors (
  note_id           TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
  vault_id          TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  model             TEXT NOT NULL,
  enc_vec           TEXT NOT NULL,
  source_updated_at TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS note_vectors_vault ON note_vectors(vault_id);
```

Add the row type:

```ts
export interface NoteVectorRow {
  note_id: string;
  vault_id: string;
  model: string;
  enc_vec: string;
  source_updated_at: string;
  updated_at: string;
}
```

`server/src/schemas.ts`:

```ts
/** 1 + 16×384 int8 plaintext, plus IV and tag, base64url: about 8.3k chars. */
export const ENC_VEC_MAX = 9 * 1024;
export const encVec = ciphertext(ENC_VEC_MAX);
export const modelName = { type: 'string', pattern: '^[A-Za-z0-9._@/-]{1,80}$' } as const;
```

`server/src/routes/vectors.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { type AppContext, currentUser, requireUser } from '../context.js';
import { nowIso, type NoteVectorRow } from '../db.js';
import { ApiError } from '../errors.js';
import { encVec, idParams, modelName } from '../schemas.js';
import { ownedNote, ownedVault } from './access.js';

type IdParams = { Params: { id: string } };
interface PutBody {
  model: string;
  encVec: string;
  sourceUpdatedAt: string;
}

const putSchema = {
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['model', 'encVec', 'sourceUpdatedAt'],
    properties: { model: modelName, encVec, sourceUpdatedAt: { type: 'string', maxLength: 64 } },
  },
} as const;

export function vectorRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const auth = { onRequest: requireUser(ctx) };

  app.get<IdParams>('/api/vaults/:id/vectors', { ...auth, schema: { params: idParams } }, async (request) => {
    const vault = ownedVault(db, currentUser(request).id, request.params.id);
    const rows = db
      .prepare('SELECT note_id, model, enc_vec, source_updated_at FROM note_vectors WHERE vault_id = ? ORDER BY note_id')
      .all(vault.id) as unknown as Pick<NoteVectorRow, 'note_id' | 'model' | 'enc_vec' | 'source_updated_at'>[];
    return {
      vectors: rows.map((r) => ({ noteId: r.note_id, model: r.model, encVec: r.enc_vec, sourceUpdatedAt: r.source_updated_at })),
    };
  });

  app.put<IdParams & { Body: PutBody }>('/api/notes/:id/vector', { ...auth, schema: putSchema }, async (request) => {
    const note = ownedNote(db, currentUser(request).id, request.params.id);
    const { model, encVec: ct, sourceUpdatedAt } = request.body;
    const source = Date.parse(sourceUpdatedAt);
    if (Number.isNaN(source)) throw new ApiError(400, 'invalid_request', 'sourceUpdatedAt must be an ISO-8601 timestamp');
    if (source > Date.parse(note.updated_at)) throw new ApiError(422, 'stale', 'The vector is newer than the note');
    db.prepare(
      `INSERT INTO note_vectors (note_id, vault_id, model, enc_vec, source_updated_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(note_id) DO UPDATE SET model = excluded.model, enc_vec = excluded.enc_vec,
         source_updated_at = excluded.source_updated_at, updated_at = excluded.updated_at`,
    ).run(note.id, note.vault_id, model, ct, new Date(source).toISOString(), nowIso());
    return { ok: true };
  });
}
```

`server/src/app.ts`:
- `import { vectorRoutes } from './routes/vectors.js';` and call `vectorRoutes(app, ctx);` after `noteRoutes`.
- In `setHeaders`, replace the body with:

```ts
        const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
        const model = filePath.includes(`${path.sep}models${path.sep}`) && path.basename(filePath) !== 'manifest.json';
        reply.header('cache-control', hashed || model ? 'public, max-age=31536000, immutable' : 'no-cache');
```

- In `setNotFoundHandler`, before the SPA fallback:

```ts
    if (request.url.startsWith('/models/')) return reply.code(404).send({ error: 'not_found' });
```

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w server`
Expected: PASS (all, including the existing data tests).

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "feat(server): encrypted note vectors table and routes; model files served with cache rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: model fetch script, Docker build arg, deploy docs

**Files:**
- Create: `scripts/fetch-model.mjs`
- Modify: `web/package.json` (dependency and script), `.gitignore`, `Dockerfile`, `compose.yaml`, `docs/deploy.md`
- Test: `scripts/fetch-model.test.mjs` (node:test, run with `node --test scripts/`)

**Interfaces:**
- Produces:
  - `node scripts/fetch-model.mjs <outDir>` writes:
    - `<outDir>/manifest.json`
    - `<outDir>/<rev8>/bge-small-en-v1.5/{config.json,tokenizer.json,tokenizer_config.json,special_tokens_map.json,onnx/model_quantized.onnx}`
    - `<outDir>/ort-<ortVersion>/<ort wasm files>`
  - The manifest shape (consumed by Task 6):

```json
{ "model": "bge-small-en-v1.5", "id": "bge-small-en-v1.5@<rev8>", "revision": "<full sha>",
  "modelPath": "<rev8>/", "ortPath": "ort-<ortVersion>/",
  "files": [{ "path": "<rev8>/bge-small-en-v1.5/config.json", "sha256": "<hex>", "bytes": 123 }] }
```

All paths are relative to `/models/`.

- [ ] **Step 1: Add the dependency**

Run: `npm view @huggingface/transformers time --json`. Pick the newest `3.x` version published before 2026-09-24, then run `npm i -w web --save-exact @huggingface/transformers@<that version>`.

Then run `ls node_modules/onnxruntime-web/dist/` and note the `ort-wasm-simd-threaded*.{mjs,wasm}` files this version ships. The transformers WASM backend loads the `.jsep.mjs` / `.jsep.wasm` pair; copy whichever pair exists. Record the version and file names in the report.

- [ ] **Step 2: Pin the revision and hashes**

Run: `curl -s https://huggingface.co/api/models/Xenova/bge-small-en-v1.5/revision/main` and read `.sha`. Then confirm the file list exists in `.siblings[].rfilename`: config.json, tokenizer.json, tokenizer_config.json, special_tokens_map.json, onnx/model_quantized.onnx.

Run the script once with `--pin` (Step 3 implements it). It downloads the files and prints `{ path: sha256 }`. Paste the output into `PINNED` in the script.

- [ ] **Step 3: Write the script**

```js
// scripts/fetch-model.mjs
// Downloads the pinned embedding model and the ONNX runtime WASM into <outDir> and writes manifest.json.
// Usage: node scripts/fetch-model.mjs <outDir> [--pin]
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const REPO = 'Xenova/bge-small-en-v1.5';
export const MODEL = 'bge-small-en-v1.5';
export const REVISION = '<paste full sha from Step 2>';
export const FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model_quantized.onnx'];
/** sha256 of each FILES entry at REVISION; regenerate with --pin when REVISION changes. */
export const PINNED = {
  // 'config.json': '<hex>',
};

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function manifestFor({ revision, ortVersion, files }) {
  const rev8 = revision.slice(0, 8);
  return { model: MODEL, id: `${MODEL}@${rev8}`, revision, modelPath: `${rev8}/`, ortPath: `ort-${ortVersion}/`, files };
}

async function main() {
  const [outDir, flag] = process.argv.slice(2);
  if (!outDir) throw new Error('usage: fetch-model.mjs <outDir> [--pin]');
  const pin = flag === '--pin';
  const rev8 = REVISION.slice(0, 8);
  const files = [];
  const hashes = {};
  for (const f of FILES) {
    const res = await fetch(`https://huggingface.co/${REPO}/resolve/${REVISION}/${f}`);
    if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const hex = sha256(buf);
    hashes[f] = hex;
    if (!pin && PINNED[f] !== hex) throw new Error(`${f}: sha256 ${hex} does not match the pinned value`);
    const rel = `${rev8}/${MODEL}/${f}`;
    mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
    writeFileSync(path.join(outDir, rel), buf);
    files.push({ path: rel, sha256: hex, bytes: buf.length });
  }
  if (pin) {
    console.log(JSON.stringify(hashes, null, 2));
    return;
  }
  const require = createRequire(path.resolve('web/package.json'));
  const ortDir = path.dirname(require.resolve('onnxruntime-web/package.json'));
  const ortVersion = JSON.parse(readFileSync(path.join(ortDir, 'package.json'), 'utf8')).version;
  for (const name of ORT_FILES) {
    const rel = `ort-${ortVersion}/${name}`;
    mkdirSync(path.join(outDir, `ort-${ortVersion}`), { recursive: true });
    copyFileSync(path.join(ortDir, 'dist', name), path.join(outDir, rel));
    const buf = readFileSync(path.join(outDir, rel));
    files.push({ path: rel, sha256: sha256(buf), bytes: buf.length });
  }
  writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifestFor({ revision: REVISION, ortVersion, files }), null, 2));
  console.log(`model ${MODEL}@${rev8} and ORT ${ortVersion} written to ${outDir}`);
}

/** The ORT runtime pair transformers.js loads (names from Step 1). */
export const ORT_FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fetch-model.mjs')) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
```

Note: when `npm run models:fetch -w web` runs, the working directory is `web/`, so the script resolves `web/package.json` relative to the repo root. Make `createRequire` use `new URL('../web/package.json', import.meta.url)` instead, so it works from any working directory.

- [ ] **Step 4: Write a small test for the manifest shape**

```js
// scripts/fetch-model.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { manifestFor, MODEL, sha256 } from './fetch-model.mjs';

test('manifest paths are relative to /models and carry the short revision', () => {
  const m = manifestFor({ revision: '0123456789abcdef', ortVersion: '1.22.0', files: [] });
  assert.equal(m.id, `${MODEL}@01234567`);
  assert.equal(m.modelPath, '01234567/');
  assert.equal(m.ortPath, 'ort-1.22.0/');
});

test('sha256 is lowercase hex', () => {
  assert.match(sha256(Buffer.from('x')), /^[0-9a-f]{64}$/);
});
```

Run: `node --test scripts/`
Expected: PASS. The import must not trigger `main()`; the guard checks `process.argv[1]`.

- [ ] **Step 5: Wire up the scripts, ignores, Docker and compose**

- `web/package.json`, scripts: `"models:fetch": "node ../scripts/fetch-model.mjs public/models"`.
- `.gitignore`: add `web/public/models/`.
- `Dockerfile`, build stage:
  - add `COPY scripts scripts` after `COPY web web`;
  - add `ARG INKED_SEMANTIC=1`;
  - before the build line: `RUN if [ "$INKED_SEMANTIC" = "1" ]; then node scripts/fetch-model.mjs web/public/models; fi`.

  Vite copies `public/` into `dist/`, so the runtime stage needs no change.
- `compose.yaml`, under `build:` for the app service:

```yaml
    build:
      context: .
      args:
        INKED_SEMANTIC: ${INKED_SEMANTIC:-1}
```

  (Keep any existing keys. If `build: .` is a scalar today, expand it to this mapping.)
- `docs/deploy.md`: add a "Semantic search model" section:
  - `INKED_SEMANTIC=0 docker compose build` leaves the model out (about 45 MB smaller), and the toggle is then hidden;
  - the model is downloaded at build time from Hugging Face, pinned and sha256-checked;
  - nothing is fetched at runtime.

- [ ] **Step 6: Verify the download for real**

Run: `npm run models:fetch -w web`
Expected: "model bge-small-en-v1.5@<rev8> and ORT <ver> written to public/models", and `web/public/models/manifest.json` exists.

Then run `npm run build -w web` and confirm `web/dist/models/manifest.json` exists.

Run `git status`. `web/public/models` must not be listed.

- [ ] **Step 7: Commit**

```bash
git add scripts web/package.json package-lock.json .gitignore Dockerfile compose.yaml docs/deploy.md
git commit -m "build: pinned bge-small model and ORT wasm fetched at build time behind INKED_SEMANTIC

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: web embedding engine (manifest, worker, client, cache, prefs, API)

**Files:**
- Create:
  - `web/src/semantic/manifest.ts`
  - `web/src/semantic/protocol.ts`
  - `web/src/semantic/embedder.worker.ts`
  - `web/src/semantic/embedderClient.ts`
  - `web/src/semantic/modelCache.ts`
- Modify: `web/src/lib/prefs.ts`, `web/src/api/client.ts`
- Test: `web/src/semantic/manifest.test.ts`, `web/src/semantic/embedderClient.test.ts`, `web/src/semantic/modelCache.test.ts`, `web/src/lib/prefs.test.ts` (extend)

**Interfaces:**
- Consumes: the manifest JSON from Task 5.
- Produces:
  - `interface Manifest { model: string; id: string; revision: string; modelPath: string; ortPath: string; files: { path: string; sha256: string; bytes: number }[] }`
  - `fetchManifest(fetcher?: typeof fetch): Promise<Manifest | null>`. Returns null on 404, on non-JSON (the SPA fallback), on a wrong shape, or on a network error.
  - `type EmbedKind = 'query' | 'passage'`
  - `class Embedder`:
    - `constructor(opts?: { makeWorker?: () => Worker; onPaused?: () => void })`
    - `load(manifest: Manifest, onProgress: (loaded: number, total: number) => void): Promise<void>`
    - `embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>`
    - `terminate(): void`
    - `readonly paused: boolean`
  - `verifyModelCache(manifest: Manifest, cacheStorage?: CacheStorage): Promise<number>`: removes mismatched or stale entries and returns the count removed.
  - `clearModelCache(cacheStorage?: CacheStorage): Promise<void>`
  - `requestPersist(): Promise<boolean>`
  - `MODEL_CACHE = 'transformers-cache'`
  - `prefs.semantic(): boolean`, `prefs.setSemantic(on: boolean): void` (key `inked.semantic`, default off)
  - `api.listVectors(vaultId)` returns `{ vectors: { noteId; model; encVec; sourceUpdatedAt }[] }`
  - `api.putVector(noteId, body: { model; encVec; sourceUpdatedAt })` returns `{ ok: true }`

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/semantic/manifest.test.ts
import { describe, expect, it } from 'vitest';
import { fetchManifest } from './manifest';

const res = (status: number, body: string, type = 'application/json') =>
  Promise.resolve(new Response(body, { status, headers: { 'content-type': type } }));
const good = { model: 'bge-small-en-v1.5', id: 'bge-small-en-v1.5@abcd1234', revision: 'abcd1234ff', modelPath: 'abcd1234/', ortPath: 'ort-1/', files: [] };

describe('fetchManifest', () => {
  it('returns the manifest', async () => {
    expect(await fetchManifest(() => res(200, JSON.stringify(good)))).toEqual(good);
  });
  it('treats 404, HTML (SPA fallback), bad shapes and network errors as unavailable', async () => {
    expect(await fetchManifest(() => res(404, '{"error":"not_found"}'))).toBeNull();
    expect(await fetchManifest(() => res(200, '<!doctype html>', 'text/html'))).toBeNull();
    expect(await fetchManifest(() => res(200, '{"model":1}'))).toBeNull();
    expect(await fetchManifest(() => Promise.reject(new TypeError('offline')))).toBeNull();
  });
});
```

```ts
// web/src/semantic/embedderClient.test.ts
import { describe, expect, it, vi } from 'vitest';
import { Embedder } from './embedderClient';
import type { FromWorker, ToWorker } from './protocol';

/** A fake worker that echoes deterministic vectors, can report progress, and can crash. */
class FakeWorker {
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  sent: ToWorker[] = [];
  postMessage(m: ToWorker) {
    this.sent.push(m);
    queueMicrotask(() => {
      if (m.type === 'load') {
        this.emit({ type: 'progress', loaded: 5, total: 10 });
        this.emit({ type: 'ready' });
      } else if (m.type === 'embed') {
        this.emit({ type: 'result', id: m.id, vectors: m.texts.map((t) => Float32Array.of(t.length, 1)) });
      }
    });
  }
  emit(d: FromWorker) {
    this.onmessage?.({ data: d } as MessageEvent<FromWorker>);
  }
  crash() {
    this.onerror?.({ message: 'boom' } as ErrorEvent);
  }
  terminate() {
    this.terminated = true;
  }
}
const manifest = { model: 'm', id: 'm@1', revision: '1', modelPath: '1/', ortPath: 'o/', files: [] };

describe('Embedder', () => {
  it('loads with progress and embeds', async () => {
    const w = new FakeWorker();
    const e = new Embedder({ makeWorker: () => w as unknown as Worker });
    const progress = vi.fn();
    await e.load(manifest, progress);
    expect(progress).toHaveBeenCalledWith(5, 10);
    const out = await e.embed(['ab', 'abc'], 'passage');
    expect(out.map((v) => v[0])).toEqual([2, 3]);
    expect(w.sent.at(-1)).toMatchObject({ type: 'embed', kind: 'passage' });
  });
  it('restarts once after a crash, then pauses on the second', async () => {
    const workers: FakeWorker[] = [];
    const onPaused = vi.fn();
    const e = new Embedder({ makeWorker: () => (workers.push(new FakeWorker()), workers.at(-1) as unknown as Worker), onPaused });
    await e.load(manifest, () => {});
    const pending = e.embed(['x'], 'query');
    workers[0].crash();
    await expect(pending).rejects.toThrow();
    expect(workers).toHaveLength(2);
    await expect(e.embed(['xy'], 'query')).resolves.toHaveLength(1);
    workers[1].crash();
    expect(e.paused).toBe(true);
    expect(onPaused).toHaveBeenCalled();
    await expect(e.embed(['x'], 'query')).rejects.toThrow(/paused/);
  });
  it('terminate stops the worker and rejects pending work', async () => {
    const w = new FakeWorker();
    const e = new Embedder({ makeWorker: () => w as unknown as Worker });
    await e.load(manifest, () => {});
    const p = e.embed(['x'], 'query');
    e.terminate();
    expect(w.terminated).toBe(true);
    await expect(p).rejects.toThrow();
  });
});
```

```ts
// web/src/semantic/modelCache.test.ts
import { describe, expect, it } from 'vitest';
import { clearModelCache, MODEL_CACHE, verifyModelCache } from './modelCache';

function fakeCaches(entries: Record<string, string>) {
  const store = new Map(Object.entries(entries).map(([k, v]) => [k, new Response(v)]));
  const cache = {
    keys: async () => [...store.keys()].map((u) => new Request(u)),
    match: async (r: Request) => store.get(r.url)?.clone(),
    delete: async (r: Request) => store.delete(r.url),
  };
  const deleted: string[] = [];
  return {
    store,
    deleted,
    api: { open: async () => cache, delete: async (n: string) => (deleted.push(n), true) } as unknown as CacheStorage,
  };
}
const hex = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

describe('model cache', () => {
  it('keeps matching files and removes mismatched or unknown ones', async () => {
    const base = 'http://localhost/models/';
    const c = fakeCaches({ [base + 'r/a.json']: 'good', [base + 'r/b.json']: 'tampered', [base + 'old/x.json']: 'stale' });
    const manifest = {
      model: 'm', id: 'm@r', revision: 'r', modelPath: 'r/', ortPath: 'o/',
      files: [{ path: 'r/a.json', sha256: await hex('good'), bytes: 4 }, { path: 'r/b.json', sha256: await hex('good'), bytes: 4 }],
    };
    expect(await verifyModelCache(manifest, c.api, base)).toBe(2);
    expect([...c.store.keys()]).toEqual([base + 'r/a.json']);
  });
  it('clears the whole cache', async () => {
    const c = fakeCaches({});
    await clearModelCache(c.api);
    expect(c.deleted).toEqual([MODEL_CACHE]);
  });
});
```

Extend `web/src/lib/prefs.test.ts`:

```ts
it('semantic search is off by default and persists', () => {
  localStorage.clear();
  expect(prefs.semantic()).toBe(false);
  prefs.setSemantic(true);
  expect(prefs.semantic()).toBe(true);
});
```

(Match the existing test file's environment setup. If it stubs `localStorage`, reuse that.)

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w web -- semantic prefs`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

```ts
// web/src/semantic/manifest.ts
export interface Manifest {
  model: string;
  id: string;
  revision: string;
  modelPath: string;
  ortPath: string;
  files: { path: string; sha256: string; bytes: number }[];
}
export const MODELS_BASE = '/models/';

const isManifest = (v: unknown): v is Manifest => {
  const m = v as Manifest;
  return (
    !!m && typeof m.model === 'string' && typeof m.id === 'string' && typeof m.revision === 'string' &&
    typeof m.modelPath === 'string' && typeof m.ortPath === 'string' && Array.isArray(m.files)
  );
};

/** The deployment's model manifest, or null when this deployment ships without the model. */
export async function fetchManifest(fetcher: typeof fetch = fetch): Promise<Manifest | null> {
  try {
    const res = await fetcher(`${MODELS_BASE}manifest.json`, { cache: 'no-cache' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    const v: unknown = await res.json();
    return isManifest(v) ? v : null;
  } catch {
    return null;
  }
}

export const modelBytes = (m: Manifest) => m.files.reduce((n, f) => n + f.bytes, 0);
```

```ts
// web/src/semantic/protocol.ts
import type { Manifest } from './manifest';
export type EmbedKind = 'query' | 'passage';
export type ToWorker =
  | { type: 'load'; manifest: Manifest; base: string }
  | { type: 'embed'; id: number; texts: string[]; kind: EmbedKind };
export type FromWorker =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready' }
  | { type: 'result'; id: number; vectors: Float32Array[] }
  | { type: 'error'; id?: number; message: string };
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
```

```ts
// web/src/semantic/embedder.worker.ts
/// <reference lib="webworker" />
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { QUERY_PREFIX, type FromWorker, type ToWorker } from './protocol';

let extractor: FeatureExtractionPipeline | null = null;
const post = (m: FromWorker) => (self as DedicatedWorkerGlobalScope).postMessage(m);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.useBrowserCache = true;
      env.localModelPath = m.base + m.manifest.modelPath;
      if (env.backends.onnx.wasm) {
        env.backends.onnx.wasm.wasmPaths = m.base + m.manifest.ortPath;
        env.backends.onnx.wasm.numThreads = 1;
      }
      const sizes = new Map<string, { loaded: number; total: number }>();
      const device = 'gpu' in navigator ? 'webgpu' : 'wasm';
      const make = (d: 'webgpu' | 'wasm') =>
        pipeline('feature-extraction', m.manifest.model, {
          dtype: 'q8',
          device: d,
          progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
            if (p.status !== 'progress' || !p.file) return;
            sizes.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
            let loaded = 0;
            let total = 0;
            for (const s of sizes.values()) {
              loaded += s.loaded;
              total += s.total;
            }
            post({ type: 'progress', loaded, total });
          },
        });
      extractor = (await make(device).catch(() => make('wasm'))) as FeatureExtractionPipeline;
      post({ type: 'ready' });
    } else if (m.type === 'embed') {
      if (!extractor) throw new Error('model not loaded');
      const texts = m.kind === 'query' ? m.texts.map((t) => QUERY_PREFIX + t) : m.texts;
      const out = await extractor(texts, { pooling: 'cls', normalize: true });
      const dim = out.dims[out.dims.length - 1];
      const data = out.data as Float32Array;
      const vectors = texts.map((_, i) => data.slice(i * dim, (i + 1) * dim));
      post({ type: 'result', id: m.id, vectors });
    }
  } catch (err) {
    post({ type: 'error', id: m.type === 'embed' ? m.id : undefined, message: (err as Error).message });
  }
};
```

```ts
// web/src/semantic/embedderClient.ts
import { MODELS_BASE, type Manifest } from './manifest';
import type { EmbedKind, FromWorker, ToWorker } from './protocol';

type Pending = { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void };

const defaultWorker = () => new Worker(new URL('./embedder.worker.ts', import.meta.url), { type: 'module' });

/** One embedding worker. A crash restarts it once; a second crash pauses semantic search for the session. */
export class Embedder {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private crashes = 0;
  private manifest: Manifest | null = null;
  private ready: Promise<void> | null = null;
  paused = false;

  constructor(private opts: { makeWorker?: () => Worker; onPaused?: () => void } = {}) {}

  load(manifest: Manifest, onProgress: (loaded: number, total: number) => void): Promise<void> {
    this.manifest = manifest;
    this.ready = this.start(onProgress);
    return this.ready;
  }

  private start(onProgress: (loaded: number, total: number) => void): Promise<void> {
    const w = (this.opts.makeWorker ?? defaultWorker)();
    this.worker = w;
    return new Promise<void>((resolve, reject) => {
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data;
        if (m.type === 'progress') onProgress(m.loaded, m.total);
        else if (m.type === 'ready') resolve();
        else if (m.type === 'result') {
          this.pending.get(m.id)?.resolve(m.vectors);
          this.pending.delete(m.id);
        } else if (m.type === 'error') {
          if (m.id === undefined) reject(new Error(m.message));
          else {
            this.pending.get(m.id)?.reject(new Error(m.message));
            this.pending.delete(m.id);
          }
        }
      };
      w.onerror = () => {
        reject(new Error('worker crashed'));
        this.onCrash();
      };
      w.postMessage({ type: 'load', manifest: this.manifest!, base: MODELS_BASE } satisfies ToWorker);
    });
  }

  private onCrash() {
    for (const p of this.pending.values()) p.reject(new Error('worker crashed'));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.crashes++;
    if (this.crashes >= 2) {
      this.paused = true;
      this.opts.onPaused?.();
      return;
    }
    if (this.manifest) this.ready = this.start(() => {});
  }

  async embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]> {
    if (this.paused) throw new Error('semantic search paused');
    await this.ready;
    const w = this.worker;
    if (!w) throw new Error('embedder stopped');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      w.postMessage({ type: 'embed', id, texts, kind } satisfies ToWorker);
    });
  }

  terminate() {
    for (const p of this.pending.values()) p.reject(new Error('embedder stopped'));
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
  }
}
```

```ts
// web/src/semantic/modelCache.ts
import { MODELS_BASE, type Manifest } from './manifest';

/** transformers.js keeps downloaded model files in this Cache Storage bucket. */
export const MODEL_CACHE = 'transformers-cache';

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Deletes cached model files whose bytes don't match the manifest, or that the manifest no longer lists. */
export async function verifyModelCache(
  manifest: Manifest,
  cacheStorage: CacheStorage = caches,
  base = new URL(MODELS_BASE, location.origin).href,
): Promise<number> {
  const cache = await cacheStorage.open(MODEL_CACHE);
  const want = new Map(manifest.files.map((f) => [base + f.path, f.sha256]));
  let removed = 0;
  for (const req of await cache.keys()) {
    const expected = want.get(req.url);
    const res = expected ? await cache.match(req) : undefined;
    const ok = !!res && hex(await crypto.subtle.digest('SHA-256', await res.arrayBuffer())) === expected;
    if (!ok) {
      await cache.delete(req);
      removed++;
    }
  }
  return removed;
}

export async function clearModelCache(cacheStorage: CacheStorage = caches): Promise<void> {
  await cacheStorage.delete(MODEL_CACHE);
}

/** Asks the browser not to evict this site's storage; false when refused or unsupported. */
export async function requestPersist(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
```

`web/src/lib/prefs.ts`: add a `SEMANTIC_KEY = 'inked.semantic'` and `semantic()` / `setSemantic(on)` with the same try/catch shape as spellcheck.

`web/src/api/client.ts`, inside `api`:

```ts
  listVectors: (vaultId: string) =>
    data<{ vectors: { noteId: string; model: string; encVec: string; sourceUpdatedAt: string }[] }>('GET', `/api/vaults/${enc(vaultId)}/vectors`),
  putVector: (noteId: string, body: { model: string; encVec: string; sourceUpdatedAt: string }) =>
    data<{ ok: true }>('PUT', `/api/notes/${enc(noteId)}/vector`, body),
```

- [ ] **Step 4: Run to verify they pass, and that the build still works**

Run: `npm test -w web -- semantic prefs` then `npm run build -w web`
Expected:
- the tests pass;
- the build succeeds;
- `dist/assets` contains a separate worker chunk (`embedder.worker-*.js`);
- the main entry chunk does not import `@huggingface/transformers` (check with `grep -l "huggingface" web/dist/assets/index-*.js`, which should find nothing).

- [ ] **Step 5: Commit**

```bash
git add web/src/semantic web/src/lib/prefs.ts web/src/lib/prefs.test.ts web/src/api/client.ts
git commit -m "feat(web): embedding worker, client with one restart, model cache checks, semantic pref and vector API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: SemanticStore and the AppStore "notes saved" event

**Files:**
- Modify: `web/src/state/store.ts`
- Create: `web/src/semantic/semanticStore.ts`, `web/src/semantic/SemanticContext.tsx`
- Modify: `web/src/main.tsx` (or wherever `AppStore` and `StoreProvider` are created): create the `SemanticStore` and wrap the app in `SemanticProvider`.
- Test: `web/src/state/notesSaved.test.ts`, `web/src/semantic/semanticStore.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3 and 6.
- Produces on `AppStore`:
  - `onNotesSaved(fn: (ids: string[]) => void): () => void`. Fires when a newer `updatedAt` lands for existing notes:
    - from `putHead` when stored and the note existed before with an older `updatedAt`, or did not exist (a new note);
    - from `loadTree` for notes whose `updatedAt` is newer than the previous tree's.

    It does not fire on a vault's first tree load.
  - `consumeUnseenSaves(): string[]`: ids saved since the last call. Cleared on `dropKeys` and `enterUnlocked`.
  - `encryptVector(vaultId, noteId, model, chunks: Int8Array[]): Promise<string>`
  - `decryptVector(vaultId, noteId, model, ct): Promise<Int8Array[]>`
  - `noteHead(noteId): NoteView | undefined`, which searches all trees.
- Produces `SemanticStore`:
  - `type ModelPhase = 'unavailable' | 'off' | 'downloading' | 'loading' | 'ready' | 'paused' | 'error'`
  - `interface SemanticState { available: boolean | null; enabled: boolean; phase: ModelPhase; download: { loaded: number; total: number } | null; coverage: Record<string, { done: number; total: number }>; error: string | null; version: number; persistDenied: boolean }`
  - `class SemanticStore`:
    - `constructor(app: AppStore, deps?: Partial<SemanticDeps>)`
    - `subscribe(fn): () => void`, `getState(): SemanticState`
    - `setEnabled(on: boolean): Promise<void>`, `retry(): void`
    - `search(query: string, signal?: AbortSignal): Promise<SemanticInput[]>`
    - `neighbours(noteId: string, k: number, among?: ReadonlySet<string>): { id: string; similarity: number }[]`
    - `chunkText(noteId: string, chunk: number): string | null` (for snippets)
    - `dispose(): void`
  - `SemanticDeps = { api: Pick<typeof api, 'listVectors' | 'putVector'>; fetchManifest: () => Promise<Manifest | null>; makeEmbedder: (onPaused: () => void) => Pick<Embedder, 'load' | 'embed' | 'terminate' | 'paused'>; prefs: { semantic(): boolean; setSemantic(on: boolean): void }; cache: { verify(m: Manifest): Promise<number>; clear(): Promise<void>; persist(): Promise<boolean> }; delay: (ms: number) => Promise<void> }`
  - `SemanticProvider`, `useSemantic(): SemanticState`, `useSemanticStore(): SemanticStore`
  - Constants: `RESAVE_DEBOUNCE_MS = 2000`, `UPLOAD_BACKOFF_MS = [1000, 4000, 16000]`

**Behaviour** (implement exactly):

1. **Startup.** On construction, subscribe to `app`. When `phase` becomes `'unlocked'`:
   - call `fetchManifest()`. `null` means `available = false` and nothing else happens;
   - otherwise `available = true`, `enabled = prefs.semantic()`;
   - if enabled, load the model:
     - `cache.verify`;
     - `phase = 'downloading'`, with `download` updated from the progress callback;
     - when the first progress arrives with `loaded === total`, or when `load` resolves, `phase = 'ready'`;
     - on a load error, `phase = 'error'` with `error = 'Couldn't download the search model.'`.
2. **Fetching vectors.** For each vault whose `bodiesReady` turns true (and `available`):
   - `api.listVectors`, then `app.decryptVector` for each;
   - keep `{ vaultId, model, sourceUpdatedAt, chunks: Float32Array[], mean }`;
   - a decrypt failure means missing;
   - bump `version` and recompute `coverage`.

   This runs even when the toggle is off, so Related works.
3. **Coverage.** Per vault, `total` = non-broken notes in the tree and `done` = notes with `isFresh(vec, head, manifest.id)`.
4. **The embed queue** (only while `phase === 'ready'`):
   - **Contents:** notes with a body in `app.getState().bodies` that aren't fresh, sorted by `updatedAt` descending, each id held at most once.
   - **Per item:**
     - snapshot `head.updatedAt` and the body;
     - `chunkNote(title, body)`; skip if it returns nothing;
     - `embed(chunks, 'passage')`, then `quantize`, then `app.encryptVector`;
     - `api.putVector` with `sourceUpdatedAt` = the snapshot.
   - **Outcomes:**
     - success: store the vector in memory (dequantized) and bump `version`;
     - 422: drop it and re-queue the note;
     - other errors: retry after the `UPLOAD_BACKOFF_MS` steps. After the last step, leave the note un-embedded until the next save or unlock.
   - **Pacing:** yield with `await delay(0)` between items.
5. **Re-saves.** `app.onNotesSaved(ids)` re-queues each id after a `RESAVE_DEBOUNCE_MS` debounce per id. Coverage recomputes immediately, so the edited note counts as not embedded.
6. **Lock or sign-out** (`phase` leaves `'unlocked'`):
   - terminate the embedder;
   - clear vectors, queues and timers;
   - `coverage = {}`;
   - bump an internal epoch, so in-flight work checks it and never uploads.
7. **`setEnabled(true)`:**
   - `prefs.setSemantic(true)`;
   - `persistDenied = !(await cache.persist())`;
   - load the model as in step 1.

   **`setEnabled(false)`:**
   - `prefs.setSemantic(false)`;
   - terminate the embedder;
   - `cache.clear()`;
   - `phase = 'off'`;
   - keep the stored vectors.
8. **`search`:**
   - returns `[]` unless `phase === 'ready'`;
   - embeds the query with `'query'`;
   - for each fresh vector, `noteScore`;
   - returns `{ noteId, similarity, chunk }` with `similarity >= SEM_FLOOR`;
   - honours `signal.aborted` and returns `[]`.
9. **`neighbours`:** `topK` over the mean vectors of fresh notes, excluding `noteId` and filtered to `among` when given, with floor `SEM_FLOOR`. It returns `[]` when the note itself has no fresh vector.

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/state/notesSaved.test.ts
// Uses the store test harness from web/src/state/store.test.ts (fake api via vi.mock('../api/client')).
// Copy that file's setup helpers (unlock a user, a vault with a tree) and add:
import { describe, expect, it, vi } from 'vitest';

describe('AppStore notes saved event', () => {
  it('fires for a saved note body and collects it as unseen', async () => {
    // arrange: unlocked store with vault v, note n at updatedAt T0; api.updateNote resolves updatedAt T1
    const seen = vi.fn();
    store.onNotesSaved(seen);
    await store.saveNoteBody('v', 'n', 'new text');
    expect(seen).toHaveBeenCalledWith(['n']);
    expect(store.consumeUnseenSaves()).toEqual(['n']);
    expect(store.consumeUnseenSaves()).toEqual([]);
  });
  it('fires from a tree reload only for notes with a newer updatedAt, not on first load', async () => {
    // first loadTree: no event. second loadTree with note n bumped: event ['n'] only.
  });
  it('forgets unseen saves on lock', async () => {
    await store.saveNoteBody('v', 'n', 'x');
    await store.lock();
    expect(store.consumeUnseenSaves()).toEqual([]);
  });
});
```

(Fill in the arrange steps with the existing harness from `store.test.ts`. Note the comments above: the implementer must write real arrange code, not leave comments.)

```ts
// web/src/semantic/semanticStore.test.ts
import { describe, expect, it, vi } from 'vitest';
import { SemanticStore } from './semanticStore';

// Fake AppStore: minimal surface used by SemanticStore.
function fakeApp() {
  let state: any = { phase: 'locked', trees: {}, bodies: {}, bodiesReady: {} };
  const ls = new Set<() => void>();
  const saved = new Set<(ids: string[]) => void>();
  return {
    getState: () => state,
    subscribe: (f: () => void) => (ls.add(f), () => ls.delete(f)),
    set(p: any) {
      state = { ...state, ...p };
      ls.forEach((f) => f());
    },
    onNotesSaved: (f: (ids: string[]) => void) => (saved.add(f), () => saved.delete(f)),
    save(ids: string[]) {
      saved.forEach((f) => f(ids));
    },
    encryptVector: vi.fn(async (_v: string, n: string, _m: string, chunks: Int8Array[]) => `v1.${n}.${chunks.length}`),
    decryptVector: vi.fn(async () => [new Int8Array(384).fill(1)]),
    noteHead: (id: string) => Object.values(state.trees).flatMap((t: any) => Object.values(t.notes)).find((n: any) => n.id === id),
  };
}
const manifest = { model: 'bge', id: 'bge@1', revision: '1', modelPath: '1/', ortPath: 'o/', files: [] };
/** Deterministic unit vector from text: one-hot on a hash bucket. */
const fakeVec = (t: string) => {
  const v = new Float32Array(384);
  let h = 0;
  for (const c of t) h = (h * 31 + c.charCodeAt(0)) % 384;
  v[h] = 1;
  return v;
};
function deps(over: Record<string, unknown> = {}) {
  const embedder = { paused: false, load: vi.fn(async (_m, p) => p(10, 10)), embed: vi.fn(async (ts: string[]) => ts.map(fakeVec)), terminate: vi.fn() };
  return {
    embedder,
    d: {
      api: { listVectors: vi.fn(async () => ({ vectors: [] })), putVector: vi.fn(async () => ({ ok: true as const })) },
      fetchManifest: vi.fn(async () => manifest),
      makeEmbedder: () => embedder,
      prefs: { semantic: () => true, setSemantic: vi.fn() },
      cache: { verify: vi.fn(async () => 0), clear: vi.fn(async () => {}), persist: vi.fn(async () => true) },
      delay: () => Promise.resolve(),
      ...over,
    },
  };
}
const tree = (notes: { id: string; updatedAt: string; title?: string }[]) => ({
  v: { status: 'ready', folders: {}, notes: Object.fromEntries(notes.map((n) => [n.id, { vaultId: 'v', folderId: null, title: n.title ?? n.id, size: 1, createdAt: n.updatedAt, ...n }])) },
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('SemanticStore', () => {
  it('is unavailable without a manifest and never loads a model', async () => {
    const app = fakeApp();
    const { d, embedder } = deps({ fetchManifest: async () => null });
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked' });
    await flush();
    expect(s.getState().available).toBe(false);
    expect(embedder.load).not.toHaveBeenCalled();
  });
  it('embeds stale notes newest first, uploads, and reports coverage', async () => {
    const app = fakeApp();
    const { d } = deps();
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked', trees: tree([{ id: 'a', updatedAt: '2026-10-01T00:00:00.000Z' }, { id: 'b', updatedAt: '2026-10-02T00:00:00.000Z' }]) });
    await flush();
    app.set({ bodies: { a: 'alpha', b: 'beta' }, bodiesReady: { v: true } });
    for (let i = 0; i < 10; i++) await flush();
    expect(d.api.putVector.mock.calls.map((c: any) => c[0])).toEqual(['b', 'a']);
    expect(s.getState().coverage.v).toEqual({ done: 2, total: 2 });
  });
  it('re-queues on 422 instead of storing a stale vector', async () => {
    const app = fakeApp();
    const err = Object.assign(new Error('stale'), { status: 422 });
    const put = vi.fn().mockRejectedValueOnce(err).mockResolvedValue({ ok: true });
    const { d } = deps({ api: { listVectors: async () => ({ vectors: [] }), putVector: put } });
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked', trees: tree([{ id: 'a', updatedAt: '2026-10-01T00:00:00.000Z' }]), bodies: { a: 'x' }, bodiesReady: { v: true } });
    for (let i = 0; i < 10; i++) await flush();
    expect(put).toHaveBeenCalledTimes(2);
    expect(s.getState().coverage.v.done).toBe(1);
  });
  it('a burst of saves of one note queues it once after the debounce', async () => {
    vi.useFakeTimers();
    try {
      const app = fakeApp();
      const { d } = deps();
      new SemanticStore(app as any, d as any);
      app.set({ phase: 'unlocked', trees: tree([{ id: 'a', updatedAt: '2026-10-01T00:00:00.000Z' }]), bodies: { a: 'x' }, bodiesReady: { v: true } });
      await vi.runAllTimersAsync();
      d.api.putVector.mockClear();
      app.set({ trees: tree([{ id: 'a', updatedAt: '2026-10-03T00:00:00.000Z' }]) });
      for (let i = 0; i < 50; i++) app.save(['a']);
      await vi.advanceTimersByTimeAsync(2000);
      await vi.runAllTimersAsync();
      expect(d.api.putVector).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('lock mid-embed terminates the worker and never uploads', async () => {
    const app = fakeApp();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { d, embedder } = deps();
    embedder.embed.mockImplementation(async (ts: string[]) => (await gate, ts.map(fakeVec)));
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked', trees: tree([{ id: 'a', updatedAt: '2026-10-01T00:00:00.000Z' }]), bodies: { a: 'x' }, bodiesReady: { v: true } });
    await flush();
    app.set({ phase: 'locked', trees: {}, bodies: {} });
    release();
    for (let i = 0; i < 5; i++) await flush();
    expect(embedder.terminate).toHaveBeenCalled();
    expect(d.api.putVector).not.toHaveBeenCalled();
    expect(s.getState().coverage).toEqual({});
  });
  it('keeps vectors for Related when the toggle is off, without loading a model', async () => {
    const app = fakeApp();
    const { d, embedder } = deps({ prefs: { semantic: () => false, setSemantic: vi.fn() } });
    d.api.listVectors = vi.fn(async () => ({ vectors: [{ noteId: 'a', model: 'bge@1', encVec: 'x', sourceUpdatedAt: '2026-10-01T00:00:00.000Z' }, { noteId: 'b', model: 'bge@1', encVec: 'y', sourceUpdatedAt: '2026-10-01T00:00:00.000Z' }] }));
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked', trees: tree([{ id: 'a', updatedAt: '2026-10-01T00:00:00.000Z' }, { id: 'b', updatedAt: '2026-10-01T00:00:00.000Z' }]), bodiesReady: { v: true } });
    for (let i = 0; i < 5; i++) await flush();
    expect(embedder.load).not.toHaveBeenCalled();
    expect(s.neighbours('a', 5).map((n) => n.id)).toEqual(['b']);
  });
  it('turning off clears the model cache and keeps vectors', async () => {
    const app = fakeApp();
    const { d, embedder } = deps();
    const s = new SemanticStore(app as any, d as any);
    app.set({ phase: 'unlocked' });
    await flush();
    await s.setEnabled(false);
    expect(d.cache.clear).toHaveBeenCalled();
    expect(embedder.terminate).toHaveBeenCalled();
    expect(s.getState().phase).toBe('off');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w web -- notesSaved semanticStore`
Expected: FAIL.

- [ ] **Step 3: Implement the AppStore additions**

In `web/src/state/store.ts`:

```ts
  private savedListeners = new Set<(ids: string[]) => void>();
  private unseenSaves = new Set<string>();

  onNotesSaved(fn: (ids: string[]) => void): () => void {
    this.savedListeners.add(fn);
    return () => this.savedListeners.delete(fn);
  }
  consumeUnseenSaves(): string[] {
    const ids = [...this.unseenSaves];
    this.unseenSaves.clear();
    return ids;
  }
  private emitSaved(ids: string[]) {
    if (!ids.length) return;
    for (const id of ids) this.unseenSaves.add(id);
    for (const fn of this.savedListeners) {
      try {
        fn(ids);
      } catch (e) {
        console.error(e);
      }
    }
  }
  noteHead(noteId: string): NoteView | undefined {
    for (const t of Object.values(this.state.trees)) if (t.notes[noteId]) return t.notes[noteId];
    return undefined;
  }
  encryptVector(vaultId: string, noteId: string, model: string, chunks: Int8Array[]): Promise<string> {
    return encryptNoteVector(this.vaultKey(vaultId), vaultId, noteId, model, chunks);
  }
  decryptVector(vaultId: string, noteId: string, model: string, ct: string): Promise<Int8Array[]> {
    return decryptNoteVector(this.vaultKey(vaultId), vaultId, noteId, model, ct);
  }
```

- In `putHead`, after a successful patch: `if (!prev || prev.updatedAt < head.updatedAt) this.emitSaved([head.id]);`.
- In `loadTree`, capture `const before = this.state.trees[vaultId]` before the request. After building `tree`, if `before?.status === 'ready'`, emit the ids whose `tree.notes[id].updatedAt > before.notes[id]?.updatedAt`, or that are new.
- In `dropKeys` and `enterUnlocked`: `this.unseenSaves.clear();`.
- Import `encryptNoteVector` and `decryptNoteVector` from `inked-core`.

- [ ] **Step 4: Implement `SemanticStore` and the context**

Write `web/src/semantic/semanticStore.ts` to the Behaviour list above. Follow the AppStore pattern: private `state`, a `set(partial)` that notifies listeners, an `epoch` counter checked after every `await`. Keep it under ~350 lines. Key internals:
- `vectors: Map<string, { vaultId: string; model: string; sourceUpdatedAt: string; chunks: Float32Array[]; mean: Float32Array }>`
- `queue: string[]` plus `queued: Set<string>`
- `resaveTimers: Map<string, ReturnType<typeof setTimeout>>`
- `fetchedVaults: Set<string>`
- `running: boolean`
- `manifest: Manifest | null`
- `embedder: ReturnType<SemanticDeps['makeEmbedder']> | null`

The default `deps`:
- `api` from `../api/client`;
- `fetchManifest` from `./manifest`;
- `makeEmbedder: (onPaused) => new Embedder({ onPaused })`. Import `Embedder` with a dynamic `import('./embedderClient')` inside `loadModel` to keep transformers out of the main chunk. The default factory is async-wrapped: `makeEmbedder` may return a Promise, so `await` it.
- `prefs` from `../lib/prefs`;
- `cache` from `./modelCache`;
- `delay: (ms) => new Promise((r) => setTimeout(r, ms))`.

`chunkText(noteId, chunk)` returns `chunkNote(head.title, bodies[noteId])[chunk]` (first line only, max 140 characters), or null.

```tsx
// web/src/semantic/SemanticContext.tsx
import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { SemanticState, SemanticStore } from './semanticStore';

const Ctx = createContext<SemanticStore | null>(null);
export function SemanticProvider({ store, children }: { store: SemanticStore; children: ReactNode }) {
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}
export function useSemanticStore(): SemanticStore {
  const s = useContext(Ctx);
  if (!s) throw new Error('SemanticProvider missing');
  return s;
}
export function useSemantic(): SemanticState {
  const s = useSemanticStore();
  return useSyncExternalStore(s.subscribe, s.getState);
}
```

Wire it up where `new AppStore()` is created: `const semantic = new SemanticStore(store);`, then `<SemanticProvider store={semantic}>` inside `StoreProvider`. Existing component tests that render pages under `StoreProvider` only will now need the provider. Add a test helper `renderWithStores` (or extend the existing one) that also provides a `SemanticStore` built with `deps({ fetchManifest: async () => null })`, so existing tests stay green.

- [ ] **Step 5: Run to verify they pass**

Run: `npm test -w web`
Expected: PASS (all web tests).

Run: `npm run build -w web`
Expected: success, with transformers still absent from the entry chunk (same grep as Task 6).

- [ ] **Step 6: Commit**

```bash
git add web/src/state web/src/semantic web/src/main.tsx web/src/test
git commit -m "feat(web): SemanticStore (vectors, embed queue, coverage, model phases) and notes-saved events

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Settings "Search by meaning" card and the shared progress bar

**Files:**
- Create: `web/src/components/ProgressBar.tsx`
- Modify: `web/src/pages/SettingsPage.tsx`, `web/src/styles/base.css` (bar styles)
- Test: `web/src/pages/SettingsSemantic.test.tsx`, `web/src/components/ProgressBar.test.tsx`

**Interfaces:**
- Consumes: `useSemantic`, `useSemanticStore` (Task 7) and `modelBytes` (Task 6).
- Produces: `ProgressBar({ value, max, label, id? }: { value: number; max: number; label: string; id?: string })`. It renders `role="progressbar"` with `aria-valuenow`, `aria-valuemin=0`, `aria-valuemax` and `aria-label={label}`, plus a visible text label beside the bar.

**UI** (exact copy):
- The card is titled "Search by meaning". It is hidden entirely when `available === false`, and shows nothing while `available === null`.
- Checkbox label: "Search by meaning". Hint: "Finds notes by what they're about, not just their words. Downloads about {MB} MB once to this device; your notes never leave it." `{MB}` = `Math.round(modelBytes(manifest) / 1e6)`. Expose `modelBytes` through state as `downloadBytes`; add this field to `SemanticState` in this task.
- While `phase === 'downloading'`: a bar labelled "Model {loaded MB} / {total MB} MB".
- One bar per vault: "{vault name} · {done} / {total} notes". These are shown whenever `available`, including when the toggle is off.
- `phase === 'error'`: `<p className="form-error">` with the error, plus a "Retry" button that calls `retry()`.
- `phase === 'paused'`: `<p className="field-hint">` "Search by meaning stopped after a problem. It will try again next time you unlock."
- `persistDenied` while enabled: field hint "This browser may clear the model when you close a private window or free up space."

**Styles** (`base.css`):
- `.bar { height: 2px; background: var(--line-2, #2e2c38); border-radius: 1px; overflow: hidden }`
- `.bar > span { display: block; height: 100%; background: var(--ink-fresh); transition: width var(--dur-3) var(--ease-out) }`
- Under reduced motion, the global rule already shortens the transition.

- [ ] **Step 1: Write the failing tests**

```tsx
// web/src/components/ProgressBar.test.tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProgressBar } from './ProgressBar';

describe('ProgressBar', () => {
  it('exposes value and max and shows its label', () => {
    render(<ProgressBar value={142} max={210} label="Work · 142 / 210 notes" />);
    const bar = screen.getByRole('progressbar', { name: 'Work · 142 / 210 notes' });
    expect(bar.getAttribute('aria-valuenow')).toBe('142');
    expect(bar.getAttribute('aria-valuemax')).toBe('210');
    expect(screen.getByText('Work · 142 / 210 notes')).toBeTruthy();
  });
});
```

`web/src/pages/SettingsSemantic.test.tsx` renders `SettingsPage` with a stubbed `SemanticStore`: a plain object with `subscribe`, `getState`, `setEnabled: vi.fn()` and `retry: vi.fn()`, provided via `SemanticProvider` and cast. Cases:
1. `available: false`: no "Search by meaning" heading.
2. Available and off: the checkbox is unchecked; clicking it calls `setEnabled(true)`; the per-vault bar "Work · 3 / 5 notes" is visible.
3. `phase: 'downloading', download: { loaded: 18e6, total: 34e6 }`: "Model 18 / 34 MB" is visible.
4. `phase: 'error'`: Retry calls `retry`.
5. `persistDenied: true` and enabled: the warning text is shown.

(Use the same render helpers as the other page tests. `@testing-library/react` is already used in the web tests; check `HomePage.test.tsx` imports.)

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w web -- ProgressBar SettingsSemantic`
Expected: FAIL.

- [ ] **Step 3: Implement**

```tsx
// web/src/components/ProgressBar.tsx
export function ProgressBar({ value, max, label, id }: { value: number; max: number; label: string; id?: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="progress" id={id}>
      <div className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="progress-label">{label}</span>
    </div>
  );
}
```

Add a `SemanticSearch()` card component in `SettingsPage.tsx`, placed after `Editing()`, following the `Editing()` card's markup (`section.card`, `h2.card-title`, `label.check`, `p.field-hint`). Vault names come from `useAppState().vaults`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w web` and `npm run build -w web`
Expected: PASS and build OK.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ProgressBar.tsx web/src/components/ProgressBar.test.tsx web/src/pages/SettingsPage.tsx web/src/pages/SettingsSemantic.test.tsx web/src/styles/base.css web/src/semantic/semanticStore.ts
git commit -m "feat(web): Search by meaning settings card with download and per-vault progress

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: Home merged search, why tags, indexing bar

**Files:**
- Create: `web/src/pages/searchRows.ts`
- Modify: `web/src/pages/HomePage.tsx`, `web/src/styles/home.css`, `DESIGN.md`
- Test: `web/src/pages/searchRows.test.ts`, `web/src/pages/HomePage.test.tsx` (extend)

**Interfaces:**
- Consumes: `mergeRank`, `Ranked` (Task 2); `useSemantic`, `useSemanticStore` (Task 7); `ProgressBar` (Task 8).
- Produces:
  - `buildRows(titleHits: TitleHit[], bodyHits: BodyHit[], semantic: SemanticInput[], entries: SearchEntry[], query: string): SearchRow[]`
  - `interface SearchRow { entry: SearchEntry; why: Why; titleMatch: FuzzyMatch | null; snippet: Snippet | null; chunk: number | null }`
  - It computes `exactTitles` as the entries whose title (the text after `titleStart`), normalised with `normalizeQuery`, equals the normalised query, then calls `mergeRank`.

**HomePage behaviour:**
- `titleHits` and `bodyHits` stay as they are (instant on every keystroke).
- Semantic results:
  - `semantic` state starts as `SemanticInput[]` `[]`;
  - when `q.length >= 3 && phase === 'ready'`, debounce 250 ms, then `semanticStore.search(q, abort.signal)`;
  - a newer query aborts the previous one;
  - when `q` changes below 3 characters, set `[]`.
- Rows: `rows = buildRows(...)`. Render one list (replacing the two lists and the "In note text" sub-heading).
- Each row has the existing `Link.res` markup:
  - the title uses `Highlighted` when `titleMatch` is set, otherwise plain text;
  - a `.res-snippet` shows the body snippet (text rows) or the chunk's first line (`semanticStore.chunkText`) for meaning rows;
  - a muted tag `<span className="res-why" data-why={why}>`: `title`, `text`, or `◇ meaning`;
  - then `ResultMeta`.
- **Hold while browsing.** While `document.activeElement` is inside the results list, keep showing the previous `rows` and store the new ones as pending. Apply them when focus leaves the list (`onBlur` of the aside, when the next focus target is outside it) or when the query changes. Use a ref plus a state tick.
- **Header.** Keep `{n} matches`. When `phase === 'ready'` and coverage is incomplete, append ` · meaning covers {done} of {total} notes` (summed over vaults).
- **Indexing bar.** Under the search form, show `<ProgressBar>` labelled "Indexing by meaning · {done} / {total}" when enabled, ready and incomplete. During `phase === 'downloading'`, label it "Downloading model · {loaded MB} / {total MB} MB". Use `usePresence` (from `web/src/motion`) for a fade-out exit when complete.
- `search-help` sr-only text: append " With search by meaning on, results also include notes about the same topic."
- Enter still opens the top row and the arrow keys still move. The row ids come from `rows`.

**`DESIGN.md`:** add a "Search by meaning" paragraph under Search: why tags, the coverage note, the indexing bar, and the fact that it is opt-in.

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/pages/searchRows.test.ts
import { buildEntry, searchTitles } from 'inked-core';
import { describe, expect, it } from 'vitest';
import { buildRows } from './searchRows';

const e = (id: string, title: string) => buildEntry(id, 'v', 'Work', [], title, '2026-10-01T00:00:00.000Z');
const entries = [e('a', 'deploy'), e('b', 'deployment notes'), e('c', 'vehicles')];

describe('buildRows', () => {
  it('pins the exact title, tags rows and appends meaning-only rows', () => {
    const rows = buildRows(searchTitles('deploy', entries), [], [{ noteId: 'c', similarity: 0.8, chunk: 0 }], entries, 'deploy');
    expect(rows[0].entry.noteId).toBe('a');
    expect(rows.map((r) => [r.entry.noteId, r.why])).toEqual([
      ['a', 'title'],
      ['b', 'title'],
      ['c', 'meaning'],
    ]);
    expect(rows[2].titleMatch).toBeNull();
  });
  it('carries body snippets for text hits', () => {
    const snippet = { before: '', hit: 'car', after: ' parts' };
    const rows = buildRows([], [{ entry: entries[2], snippet }], [], entries, 'car');
    expect(rows[0]).toMatchObject({ why: 'text', snippet });
  });
});
```

Extend `HomePage.test.tsx` (with a stub `SemanticStore` whose `search` resolves a fixed list and whose state is `{ phase: 'ready', enabled: true, coverage: { v: { done: 1, total: 2 } }, ... }`):
1. Typing "car" (3+ characters) shows a meaning row tagged "◇ meaning" after timers advance 250 ms.
2. The results header includes "meaning covers 1 of 2 notes".
3. The indexing bar "Indexing by meaning · 1 / 2" is visible.
4. With focus on the first result row, a later semantic result does not reorder the rows. Blurring out of the list applies the new order.
5. With `phase: 'off'`, `search` is never called.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w web -- searchRows HomePage`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// web/src/pages/searchRows.ts
import { mergeRank, normalizeQuery, type BodyHit, type FuzzyMatch, type SearchEntry, type SemanticInput, type Snippet, type TitleHit, type Why } from 'inked-core';

export interface SearchRow {
  entry: SearchEntry;
  why: Why;
  titleMatch: FuzzyMatch | null;
  snippet: Snippet | null;
  chunk: number | null;
}

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
```

(Check that `normalizeQuery`, `FuzzyMatch`, `Snippet`, `TitleHit` and `BodyHit` are exported from `inked-core`. If one isn't, export it from `core/src/index.ts`.)

Then update `HomePage.tsx` per the behaviour list, and add `.res-why` styles to `home.css`: font size 11px, colour `var(--fg-3)` or the existing muted token, `margin-left: auto`. The `[data-why="meaning"]` variant uses `color: var(--ink-light)`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w web` and `npm run build -w web`
Expected: PASS and build OK.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages web/src/styles/home.css DESIGN.md core/src/index.ts
git commit -m "feat(web): one merged search list with why tags, semantic results and an indexing bar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: Related notes in the preview panel

**Files:**
- Modify: `web/src/pages/NodePreview.tsx`, `web/src/pages/HomePage.tsx` (pass `onSelect`), `web/src/styles/home.css`
- Test: `web/src/pages/NodePreview.test.tsx` (extend)

**Interfaces:**
- Consumes: `useSemantic` (for `version`, so the list re-renders) and `useSemanticStore().neighbours`. `indexNoteOf` from `inked-core` for folder and hub previews.
- Produces:
  - The `NodePreview` props gain `onSelect: (s: MapSelection) => void`.
  - `HomePage` passes `setSelected`.

**Behaviour:**
- **Which note.** Note preview: the selected note. Folder preview: its Index note (`indexNoteOf(tree, folderId)`). Hub preview: the root Index (`indexNoteOf(tree, null)`).
- **Contents.** `related = neighbours(noteId, 5)`, mapped to the heads from all trees, skipping missing or broken ones.
- **Section.** If `related.length > 0`, render after Backlinks, or after the folder's note list:

```tsx
<section className="preview-related" aria-label="Related notes">
  <h3 className="results-sub">Related</h3>
  <ul className="res-list">
    {related.map((r) => (
      <li key={r.id}>
        <button type="button" className="res res-btn" onClick={() => onSelect({ kind: 'note', vaultId: r.vaultId, id: r.id })}>
          <span className="res-title">{r.title}</span>
          <span className="res-meta">{r.path}</span>
          <span className="res-why" data-why="meaning" aria-label={`similarity ${r.sim}`}>◇ {r.sim}</span>
        </button>
      </li>
    ))}
  </ul>
</section>
```

  Here `r.sim` is `similarity.toFixed(2).replace(/^0/, '')` and `r.path` is the vault and folder crumbs.
- **Hidden** when the list is empty (no vectors, all stale, or nothing above the floor). No placeholder.
- **Styles.** `.res-btn` resets button styles to match `a.res`: full width, left aligned, inherit font, no border or background, the same hover.

- [ ] **Step 1: Write the failing tests** (extend `NodePreview.test.tsx`)

Provide a stub `SemanticStore` whose `neighbours` returns `[{ id: 'n2', similarity: 0.82 }]` and whose state has `version: 1`.
1. A note preview shows "Related" with "n2's title" and "◇ .82". Clicking it calls `onSelect({ kind: 'note', vaultId, id: 'n2' })`.
2. A folder preview calls `neighbours` with the folder's Index note id.
3. When `neighbours` returns `[]`, there is no "Related" heading.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w web -- NodePreview`
Expected: FAIL.

- [ ] **Step 3: Implement** per the behaviour above.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w web` and `npm run build -w web`
Expected: PASS and build OK.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages web/src/styles/home.css
git commit -m "feat(web): Related notes by meaning in the preview panel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: map link density (scene degree, rings, aria)

**Files:**
- Modify: `web/src/map/scene.ts`, `web/src/map/ConceptMap.tsx`, `web/src/styles/map.css`
- Test: `web/src/map/scene.test.ts`, `web/src/map/ConceptMap.test.tsx` (extend)

**Interfaces:**
- Produces:
  - `SceneDot.degree: number`: the count of `[[links]]` in plus out, from `scene.links`.
  - `interface LinkSeg extends Seg { a: string; b: string }`, with `Scene.links: LinkSeg[]`. `a` and `b` are the two note ids.
  - `selRingRadius(degree: number): number` returns 7 (0–1 links), 9 (2) or 11.5 (3+).
  - `densityClass(degree: number): 'hollow' | '' | 'r1' | 'r2'`

**Rendering in `ConceptMap`** (inside each `g.cmap-node`):
- **0 links:** add the class `is-orphan`. The dot is drawn hollow: `.cmap-node.is-orphan .cmap-dot { fill: var(--panel-bg, #1a1920); stroke: currentColor; stroke-width: 1.4 }`, radius 3.4. Set `color` from the tier, via a `tier-*` class rule `color: var(--ink-<tier>)`.
- **2 links:** add `<circle className="cmap-dens" r={6.5} />`.
- **3 or more:** add a second one at `r={9.25}`.
- `.cmap-dens { fill: none; stroke: currentColor; stroke-width: 1.25 }`
- The selection ring (`cmap-sel`) uses `selRingRadius(dot.degree)` instead of `r + 3`.
- **aria-label:** append `, ${plural(dot.degree, 'link')}` when the degree is above 0 ("1 link", "3 links").
- While `scene.linksPending`, the degree is incomplete. That is acceptable: the rings appear once the links decrypt.

- [ ] **Step 1: Write the failing tests**

In `scene.test.ts`, build a scene from a graph with links a→b, a→c and d→a:
- the degree of `a` is 3, `b` is 1, `e` (unlinked) is 0;
- `links[i].a` and `links[i].b` hold the note ids;
- `selRingRadius(0) === 7`, `selRingRadius(2) === 9`, `selRingRadius(3) === 11.5`.

In `ConceptMap.test.tsx`:
- the node for `a` has two `.cmap-dens` circles and the label ends with "3 links";
- `e` has the `is-orphan` class and no `.cmap-dens`;
- `b` has the label ending "1 link" and no `.cmap-dens`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w web -- scene ConceptMap`
Expected: FAIL.

- [ ] **Step 3: Implement.** In `buildScene`, when emitting link segments, include `a` and `b`, then count `degree` per dot. Export `selRingRadius` and `densityClass` from `scene.ts`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/map web/src/styles/map.css
git commit -m "feat(map): link-density rings and hollow orphans, link count in the dot label

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: the lit state, flowing links and the click ring

**Files:**
- Create: `web/src/map/lit.ts`
- Modify: `web/src/map/ConceptMap.tsx`, `web/src/styles/map.css`
- Test: `web/src/map/lit.test.ts`, `web/src/map/ConceptMap.test.tsx` (extend)

**Interfaces:**
- Consumes: `Scene`, `LinkSeg` (Task 11).
- Produces:
  - `mapFocus(o: { hover: string | null; keyboard: string | null; hot: string | null; selectedNote: string | null; searching: boolean }): string | null`. It returns `selectedNote` when `searching`; otherwise `hover ?? keyboard ?? hot ?? selectedNote`. Only note ids are passed in; a folder or hub id becomes `null` before the call.
  - `litSet(focus: string | null, scene: Scene, meaning: readonly string[]): { notes: Set<string>; folders: Set<string>; links: LinkSeg[] }`. The notes are focus, plus link neighbours (`links` where `a` or `b === focus`), plus the meaning ids. The folders are the union of `scene.chainFolders[id]` for every lit note. `links` are the segments touching the focus. When `focus` is null, everything is empty.
  - `ConceptMap` gains `neighbours?: (noteId: string) => { id: string; similarity: number }[]`, used by Task 13. In this task, call it only to fill `meaning` in `litSet`; it defaults to `() => []`.

**Behaviour in `ConceptMap`:**
- `focus = mapFocus({ hover, keyboard: focusId when it's a dot id, hot when it's a dot id, selectedNote: selNote, searching })`.
- With `lit = litSet(focus, scene, neighbours(focus).map((n) => n.id))`, when `focus` is non-null:
  - dots not in `lit.notes` get the class `is-dim` (opacity .3);
  - folders not in `lit.folders` get `is-dim-soft` (.45);
  - pencil edges whose `data-edge` id (the child id) is not lit get `is-dim-soft`;
  - the `cmap-links` group gets `is-dim-links` (opacity .35);
  - labels show for every lit note (`showLabel` also true when `lit.notes.has(dot.id)`).
- All the dim classes transition opacity over `var(--dur-3)`.
- **Flowing links.** A new `<g className="cmap-alinks">` after `cmap-links` renders one `<path className="cmap-alink" d={linkPath(other, focus)} />` per `lit.links`, oriented from the other note toward the focus. Use `key={a+b}`.
- **Click ring.** Keep `ringSeq` in a ref that bumps whenever `selNote` changes to a non-null id. Render `<circle key={ringSeq} className="cmap-ring" r={5} />` inside that dot's `g` while `ringSeq` is set. On `animationend`, clear it (set a state to null). With reduced motion (`prefersReducedMotion()`), don't render it.
- **Hover throttle.** `onPointerEnter` hover updates go through `requestAnimationFrame` (keep the latest id; one update per frame).
- **`map.css`:**

```css
.cmap-node, .cmap-folder, .cmap-pencil path, .cmap-links { transition: opacity var(--dur-3) var(--ease-std); }
.cmap-node.is-dim { opacity: .3; }
.cmap-folder.is-dim-soft, .cmap-pencil path.is-dim-soft { opacity: .45; }
.cmap-links.is-dim-links { opacity: .35; }
.cmap-alink { fill: none; stroke: #8d7bc4; stroke-width: 1.3; stroke-linecap: round; stroke-dasharray: 2 4; animation: cmap-flow-in 1.4s linear infinite; }
@keyframes cmap-flow-in { to { stroke-dashoffset: -12; } }
.cmap-ring { fill: none; stroke: var(--ink-wet); stroke-width: 1.5; transform-box: fill-box; transform-origin: center; animation: cmap-ring 700ms var(--ease-out) both; pointer-events: none; }
@keyframes cmap-ring { from { opacity: .7; transform: scale(1); } to { opacity: 0; transform: scale(4.5); } }
@media (prefers-reduced-motion: reduce) { .cmap-alink { animation: none; } .cmap-ring { display: none; } }
```

  (Add `#8d7bc4` to `tokens.css` as `--ink-link` and use the token.)

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/map/lit.test.ts
import { describe, expect, it } from 'vitest';
import { litSet, mapFocus } from './lit';

describe('mapFocus', () => {
  const base = { hover: null, keyboard: null, hot: null, selectedNote: null, searching: false };
  it('prefers hover, then keyboard, then hot, then the selection', () => {
    expect(mapFocus({ ...base, hover: 'h', keyboard: 'k', hot: 't', selectedNote: 's' })).toBe('h');
    expect(mapFocus({ ...base, keyboard: 'k', hot: 't', selectedNote: 's' })).toBe('k');
    expect(mapFocus({ ...base, hot: 't', selectedNote: 's' })).toBe('t');
    expect(mapFocus({ ...base, selectedNote: 's' })).toBe('s');
  });
  it('ignores hover and keyboard focus while searching', () => {
    expect(mapFocus({ ...base, hover: 'h', keyboard: 'k', hot: 't', selectedNote: 's', searching: true })).toBe('s');
  });
});

describe('litSet', () => {
  // Build a minimal Scene by hand: notes a,b,c,d; links a-b, c-a; chainFolders a:[f1], b:[f2], c:[], d:[f3].
  it('lights the focus, its link neighbours, meaning neighbours and their folders', () => {
    // expect notes {a,b,c,d} with meaning ['d'], folders {f1,f2,f3}, links 2
  });
  it('is empty with no focus', () => {
    // expect sizes 0
  });
});
```

(Write the minimal hand-built `Scene` object literally, filling every `Scene` field with empty values where unused. Replace the comments with real assertions.)

Extend `ConceptMap.test.tsx`:
1. Hovering dot `a` gives `is-dim` to unrelated dots, not to `a` or its link neighbour, and renders one `.cmap-alink` per link of `a`.
2. With a non-empty `hits` set (searching), hovering does not dim.
3. Selecting a dot (click) renders `.cmap-ring` in that dot. Firing `animationend` removes it.
4. With `matchMedia('(prefers-reduced-motion: reduce)')` stubbed true, no `.cmap-ring` is rendered.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w web -- lit ConceptMap`
Expected: FAIL.

- [ ] **Step 3: Implement** per the behaviour above.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/map web/src/styles
git commit -m "feat(map): lit state on hover, focus and selection with flowing links and a click ring

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Ruling: spec 4b §2 lists search results, Related rows and sidebar links as triggers. Only map dots and Related rows set `selected` on Home today; search results and tree links navigate to the note page. The sequence runs whenever `selected` becomes a note, whatever caused it, so every Home-side source is covered without new wiring.

---

## Task 13: meaning threads and neighbour pulses

**Files:**
- Modify: `web/src/map/ConceptMap.tsx`, `web/src/pages/HomePage.tsx`, `web/src/styles/map.css`
- Test: `web/src/map/ConceptMap.test.tsx` (extend)

**Interfaces:**
- Consumes:
  - the `neighbours` prop (Task 12);
  - `useSemanticStore().neighbours(id, 3, onMapIds)` and `useSemantic().version` (Task 7);
  - `HIERARCHY_BEND`, `curvePath` from `scene.ts`.
- Produces:
  - `HomePage` passes `neighbours={(id) => semanticStore.neighbours(id, 3, dotIds)}`, memoised on `(version, dotIds)`. `dotIds` is the set of map dot ids (from `useVaultGraphs` entries' non-Index notes).
  - `THREAD_BEND = 0.35`, exported from `scene.ts`.

**Behaviour:**
- **Threads.** For the current `focus`, `near = neighbours(focus)` (at most 3). Render `<g className="cmap-threads" key={threadSeq}>`, where `threadSeq` bumps whenever `focus` changes, so the draw-in restarts. Each neighbour `i` gets:

```tsx
<mask id={`${uid}-t${i}`} maskUnits="userSpaceOnUse">
  <path className="cmap-tmask" d={d} pathLength={1} style={{ animationDelay: ms(base + i * 90) }} />
</mask>
<path className="cmap-thread" d={d} mask={`url(#${uid}-t${i})`} />
```

  - `d = curvePath(screen(focus), screen(neighbour), THREAD_BEND)`.
  - `base` = 560 ms when this focus came from a new selection (after the ink path), otherwise 0.
  - The mask needs a full-viewport extent: set `x={0} y={0} width={size.w} height={size.h}`.
- **Pulse.** Each neighbour dot gets the class `is-pulse` and `style={{ animationDelay: ms(base + 520 + i * 90) }}` on its `.cmap-dot`, keyed by `threadSeq`, so it remounts and replays.
- **Labels.** A meaning neighbour shows its label with ` · ◇ .82` appended, in `<tspan className="cmap-sim">`.
- **`map.css`:**

```css
.cmap-thread { fill: none; stroke: var(--ink-wet); stroke-opacity: .75; stroke-width: 1.6; stroke-linecap: round; stroke-dasharray: .1 5; animation: cmap-flow-out 2.2s linear infinite; }
@keyframes cmap-flow-out { to { stroke-dashoffset: -10.2; } }
.cmap-tmask { fill: none; stroke: #fff; stroke-width: 10; stroke-dasharray: 1; animation: cmap-draw 640ms var(--ease-out) both; }
.cmap-dot.is-pulse { transform-box: fill-box; transform-origin: center; animation: cmap-pulse-n 420ms var(--ease-out) both; }
@keyframes cmap-pulse-n { 45% { transform: scale(1.7); } }
.cmap-sim { fill: var(--ink-light); font-weight: 600; }
@media (prefers-reduced-motion: reduce) { .cmap-thread { animation: none; } .cmap-tmask { animation: none; stroke-dashoffset: 0; } .cmap-dot.is-pulse { animation: none; } }
```

  (`cmap-draw` already exists from round 3. Reuse it if its keyframes go from dashoffset 1 to 0; otherwise define it.)
- **No neighbours** (no vectors): render no `cmap-threads` group, no pulses and no similarity labels.

- [ ] **Step 1: Write the failing tests** (extend `ConceptMap.test.tsx`)

1. With `neighbours={() => [{ id: 'b', similarity: 0.82 }, { id: 'c', similarity: 0.7 }]}`, hovering `a` renders 2 `.cmap-thread` paths, 2 masks, `.is-pulse` on `b` and `c`, and the label for `b` contains "◇ .82".
2. Moving the hover from `a` to `d` remounts `.cmap-threads`: the element identity changes (compare node references).
3. With `neighbours={() => []}`, there is no `.cmap-threads` element.
4. On selection by click, the first thread mask's `animationDelay` is "560ms". On hover, it is "0ms".

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w web -- ConceptMap`
Expected: FAIL.

- [ ] **Step 3: Implement** per the behaviour above.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w web` and `npm run build -w web`
Expected: PASS and build OK.

- [ ] **Step 5: Commit**

```bash
git add web/src/map web/src/pages/HomePage.tsx web/src/styles/map.css
git commit -m "feat(map): meaning threads to the nearest notes, with pulses and similarity labels

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 14: live ripples on save

**Files:**
- Create: `web/src/map/ripples.ts`
- Modify: `web/src/map/ConceptMap.tsx`, `web/src/pages/HomePage.tsx`, `web/src/styles/map.css`, `DESIGN.md`
- Test: `web/src/map/ripples.test.ts`, `web/src/map/ConceptMap.test.tsx` (extend), `web/src/pages/HomePage.test.tsx` (extend)

**Interfaces:**
- Consumes: `AppStore.onNotesSaved`, `consumeUnseenSaves` (Task 7).
- Produces:
  - `RIPPLE_MAX = 6`, `RIPPLE_STAGGER_MS = 120`
  - `planRipples(ids: readonly string[], onMap: ReadonlySet<string>): { ripple: { id: string; delay: number }[]; flash: string[] }`. It de-duplicates, drops off-map ids, gives the first 6 a ripple at `delay = i × 120`, and makes the rest flash-only.
  - `ConceptMap` prop `saves?: { seq: number; ids: string[] } | null`. Each new `seq` plays a plan for `ids`.
  - `HomePage`:
    - on mount, `const first = store.consumeUnseenSaves()`, played after the write-on;
    - subscribes to `store.onNotesSaved((ids) => { store.consumeUnseenSaves(); push(ids); })`;
    - passes `saves`.

**Behaviour in `ConceptMap`:**
- On a new `saves.seq`, compute the plan. If the map is in its write-on (`writing`), delay the whole plan by the write-on length, `(maxDepth + 1) * WRITE_STEP_MS + NODE_LAG_MS + 520`.
- **Ripple ids:** render two rings in the dot's group, `<circle className="cmap-save-ring" r={5} style={{ animationDelay: ms(delay + k*200) }} />` for k = 0 and 1, keyed by `seq`.
- **Every id (ripple or flash):**
  - add the class `is-flash` to its `.cmap-dot` for one frame, then remove it (two `requestAnimationFrame`s), so the fill transition eases back over 1800 ms;
  - restart the tick on each folder in `scene.chainFolders[id]`: remove and re-add `is-tick` on `.cmap-folder` via a keyed state.
- **Replace the round-3 drying pulse.** Remove the `firstSeen` / `cmap-pulse` code. The live ripple covers saves now. Update the tests that asserted `cmap-pulse`.
- Clean up rings on `animationend`.
- **`map.css`:**

```css
.cmap-dot { transition: fill 1800ms cubic-bezier(.3,0,.2,1); }
.cmap-dot.is-flash { fill: var(--ink-lighter) !important; transition: none; }
.cmap-save-ring { fill: none; stroke: var(--ink-wet); stroke-width: 1.5; transform-box: fill-box; transform-origin: center; animation: cmap-save 1100ms var(--ease-out) both; pointer-events: none; }
@keyframes cmap-save { from { opacity: .75; transform: scale(1); } to { opacity: 0; transform: scale(5.5); } }
.cmap-folder.is-tick .cmap-sq { animation: cmap-tick 700ms ease-out; }
@keyframes cmap-tick { 25% { stroke: var(--ink-wet); stroke-width: 3; } }
@media (prefers-reduced-motion: reduce) {
  .cmap-save-ring { display: none; }
  .cmap-dot { transition-duration: 120ms; }
  .cmap-folder.is-tick .cmap-sq { animation: none; }
}
```

**`DESIGN.md`:** under the map section, describe:
- the lit state (hover, focus and selection);
- the click sequence;
- density rings and hollow orphans;
- meaning threads;
- live ripples (with the cap and stagger);
- the reduced-motion behaviour.

Remove the description of the drying pulse.

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/map/ripples.test.ts
import { describe, expect, it } from 'vitest';
import { planRipples, RIPPLE_MAX, RIPPLE_STAGGER_MS } from './ripples';

describe('planRipples', () => {
  const onMap = new Set(Array.from({ length: 60 }, (_, i) => `n${i}`));
  it('ripples up to the cap with a stagger, flashes the rest', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `n${i}`);
    const p = planRipples(ids, onMap);
    expect(p.ripple).toHaveLength(RIPPLE_MAX);
    expect(p.ripple.map((r) => r.delay)).toEqual([0, 1, 2, 3, 4, 5].map((i) => i * RIPPLE_STAGGER_MS));
    expect(p.flash).toHaveLength(44);
  });
  it('drops off-map ids and duplicates', () => {
    const p = planRipples(['n1', 'n1', 'ghost'], onMap);
    expect(p.ripple.map((r) => r.id)).toEqual(['n1']);
    expect(p.flash).toEqual([]);
  });
});
```

Extend `ConceptMap.test.tsx`:
1. `saves={{ seq: 1, ids: ['a'] }}` renders two `.cmap-save-ring` in `a`, and `a`'s folders get `is-tick`.
2. 8 ids render rings in only 6 dots.
3. With reduced motion, there are no rings, but `is-tick` is still applied (its animation is disabled by CSS).

Extend `HomePage.test.tsx`:
1. A save emitted while mounted (call `store.saveNoteBody` on the harness store) results in `.cmap-save-ring` on that dot.
2. A save before mounting Home ripples once after mount. Use fake timers past the write-on delay. A remount does not ripple it again.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w web -- ripples ConceptMap HomePage`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// web/src/map/ripples.ts
export const RIPPLE_MAX = 6;
export const RIPPLE_STAGGER_MS = 120;

export function planRipples(ids: readonly string[], onMap: ReadonlySet<string>): { ripple: { id: string; delay: number }[]; flash: string[] } {
  const unique = [...new Set(ids)].filter((id) => onMap.has(id));
  return {
    ripple: unique.slice(0, RIPPLE_MAX).map((id, i) => ({ id, delay: i * RIPPLE_STAGGER_MS })),
    flash: unique.slice(RIPPLE_MAX),
  };
}
```

Then implement the `ConceptMap` and `HomePage` wiring per the behaviour above.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w core`, `npm test -w server`, `npm test -w web`, `npm run build -w web`
Expected: all PASS and the build OK.

- [ ] **Step 5: Commit**

```bash
git add web/src/map web/src/pages/HomePage.tsx web/src/pages/HomePage.test.tsx web/src/styles/map.css DESIGN.md
git commit -m "feat(map): live ripples on save (capped and staggered), replay on return to Home

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Final manual check (controller, after the final review)

On the isolated stack only:
`docker compose -p inked-test -f compose.yaml -f compose.local.yaml up -d --build`. Keep the test credentials in the scratchpad, never in chat.

1. Settings → Search by meaning: the toggle downloads the model with progress, the per-vault bars fill, and Home shows the indexing bar until it completes.
2. Search "car" with a note about vehicles: it appears tagged "◇ meaning".
3. Reload and unlock: the network panel shows no model file fetches (cache hit).
4. Preview: the Related list appears, and clicking a row selects that note, with the ring, ink, threads and pulse.
5. Hover dots: the map dims and links flow. Tab moves focus the same way.
6. Save a note from a second tab: it ripples on Home.
7. `INKED_SEMANTIC=0` build: `/models/manifest.json` returns 404 and Settings has no card.

Afterwards: `docker compose -p inked-test -f compose.yaml -f compose.local.yaml down -v`.
