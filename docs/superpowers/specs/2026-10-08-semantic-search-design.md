# Semantic search (round 4a): design

Status: approved in conversation on 2026-10-08. Round 4b, the map's visual cues, gets its own spec and may reuse the vectors this round stores.

## Goal

Search finds notes by meaning as well as by letters. For example, "car" finds a note about vehicles. The preview panel on Home lists the notes nearest in meaning to the selected note. Everything stays zero-knowledge:
- the model runs only in the browser;
- stored vectors are encrypted with the vault key;
- the server never sees plaintext or plaintext vectors.

## Decisions

- **True semantic search.** The model is `bge-small-en-v1.5`, int8-quantized ONNX (about 34 MB, 384 dimensions, a 512-token window). It runs in a Web Worker through `@huggingface/transformers` (transformers.js, onnxruntime-web WASM, with WebGPU when available). Queries get the bge instruction prefix, `Represent this sentence for searching relevant passages: `.
- **Optional, at two levels:**
  - **Per device.** A Settings toggle, "Search by meaning", is off by default and stored per device in `prefs`.
  - **Per deployment.** The Docker build arg `INKED_SEMANTIC` controls it: `1` is the default and bundles the model, `0` leaves the model out. If `/models/manifest.json` returns 404, the client hides the toggle.
- **Lazy loading.** When the toggle is off (or the deployment has no model), no worker, transformers.js or model is loaded. All semantic code sits in a lazy chunk.
- **Storage.** Vectors are kept encrypted on the server in a new `note_vectors` table, separate from note saves.
- **Search results.** One merged ranking of fuzzy and semantic scores, where each row carries a tag saying why it matched.
- **Reuse.** Search, plus a "Related" list in the Home preview panel. The note page does not get one in this round.
- **Progress.** A progress bar on Home under the search field while embedding is incomplete, and per-vault bars in Settings.

## Section 1: architecture and data flow

### Units

- **`core/src/semantic/`** (pure, no DOM):
  - **`chunk.ts`:** `chunkNote(title, body)` splits text into windows of about 400 tokens with 64 tokens of overlap, capped at 16 chunks. The title is prepended to the first chunk. Token counts are approximated with a whitespace and punctuation word count × 1.3. The exact tokenizer only runs in the worker.
  - **`quantize.ts`:** `quantize(Float32Array) → Int8Array` (unit vector, ×127, rounded) and `dequantize`.
  - **`similarity.ts`:**
    - `cosine` on unit vectors;
    - `noteScore(query, chunks)` returns the max over chunks;
    - `meanVector(chunks)` is the renormalised mean;
    - `topK(target, candidates, k, floor)`.
  - **`rank.ts`:** `mergeRank(fuzzyHits, semanticHits, opts)` implements Section 2.
  - **`fresh.ts`:** `isFresh(vector, note, model)` is true when `vector.model === model && vector.sourceUpdatedAt >= note.updatedAt`.
- **`core/src/crypto`:** a vector field encrypted with the vault key. Its AAD is `vec|<noteId>|<model>`. The plaintext is the chunk count followed by the int8 rows.
- **`server`:** the `note_vectors` table and routes (below).
- **`web/src/semantic/`:**
  - **`embedder.worker.ts`:** loads transformers.js with `env.allowRemoteModels = false`, `env.localModelPath = '/models/'`, and wasm paths on the same origin. It answers `embed(texts, kind: 'query'|'passage') → Float32Array[]` and reports download progress.
  - **`embedderClient.ts`:** a promise wrapper around the worker. It restarts the worker once after a crash. After a second crash it marks semantic search as paused for the session.
  - **`semanticStore.ts`:** a slice of the store (or a companion store using the same `set()` and listener pattern). It holds:
    - the decrypted vectors in memory;
    - the embed queue and upload queue;
    - per-vault coverage counts;
    - the model phase: `off | unavailable | downloading | loading | ready | paused | error`.
  - **`modelCache.ts`:**
    - checks `/models/manifest.json` (`{ model, revision, files: [{ path, sha256, bytes }] }`);
    - verifies cached files by sha256 and deletes stale or mismatched ones;
    - deletes everything when the toggle is turned off;
    - calls `navigator.storage.persist()` when the toggle is turned on.

### Server

Table:

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

Routes, all behind the existing auth and vault-ownership checks:
- **`GET /api/vaults/:id/vectors`** returns `[{ noteId, model, encVec, sourceUpdatedAt }]` for the vault.
- **`PUT /api/notes/:id/vector`** with body `{ model, encVec, sourceUpdatedAt }` upserts the vector.
  - `encVec` uses the existing ciphertext pattern. Its max length fits 16 × 384 bytes of int8 plus overhead.
  - `model` matches `^[A-Za-z0-9._/-]{1,80}$`.
  - The route rejects a `sourceUpdatedAt` that is newer than the note's `updated_at`, with 422.
  - It never changes `notes.updated_at`.
  - It is rate-limited like note saves.
- Vectors are deleted along with their note (cascade) and with their vault.

### Model files

- The `scripts/fetch-model.mjs` script downloads a pinned Hugging Face revision of `Xenova/bge-small-en-v1.5`. It fetches the int8 ONNX, the tokenizer and the configs, checks each sha256 against values committed in the script, and writes the files plus `manifest.json` to an output folder.
- A Dockerfile stage `models` runs the script when `INKED_SEMANTIC=1`. The final image copies the output to `/app/models`. With `INKED_SEMANTIC=0`, the folder is empty.
- The server serves `/models/*` with `@fastify/static`:
  - files under the revision path get `cache-control: public, max-age=31536000, immutable`;
  - `manifest.json` gets `no-cache`;
  - a missing folder gives 404.
- The transformers.js wasm files are emitted by the Vite build with hashed names and served from the same origin.
- The CSP does not change: it already has `script-src 'self' 'wasm-unsafe-eval'` and `connect-src 'self'`.
- Local dev: `npm run models:fetch -w web` writes to `web/public/models/`, which is git-ignored.
- Model files are never committed.

### Flow

1. The vault is unlocked, the trees load, and the bodies decrypt in the background (as they do now).
2. If the toggle is on and the manifest exists:
   - start the worker;
   - load the model from Cache Storage, or download it with progress;
   - fetch `GET /vaults/:id/vectors` for each vault and decrypt.
3. Even with the toggle off, the client fetches and decrypts vectors after unlock so that Related works. It does this only when the manifest exists, which keeps zero-model deployments silent.
4. Each note without a fresh vector joins the embed queue, sorted by `updated_at` descending. The worker embeds one note's chunks at a time, at idle priority.
5. Each result is quantized, encrypted, uploaded, and updates the coverage counts.
6. When a note save lands, that note is re-queued after a 2 s debounce.
7. A note added through MCP is embedded the next time a browser with the toggle on unlocks.
8. On lock:
   - terminate the worker;
   - drop the vectors from memory;
   - drop the queues.
   Pending vector work is rebuildable, so nothing is persisted.

### Model lifetime

- Model files live in Cache Storage and survive tab close and browser restart.
- After a full reload or a new unlock, the model loads from the cache with no network (about 1–2 s).
- The files are lost only when:
  - a private window closes;
  - site data is cleared;
  - the browser evicts them under storage pressure (mitigated by `storage.persist()`);
  - the user turns the toggle off.
- If the toggle is on and the cache is empty, the files download again with the progress bar.

## Section 2: merged ranking and search UI

### Scores

- **Fuzzy.** `searchTitles` and `searchBodies` scores are rescaled to 0–1 within each query.
- **Semantic.** `s = clamp((noteScore − 0.55) / (0.85 − 0.55), 0, 1)`. Notes with `noteScore < 0.55` are dropped.
- **Merged.** `score = max(f, s) + 0.15 × min(f, s)`.
- **Exact title matches** (normalised equality) always come first.
- **Caps.**
  - At most 30 results in total.
  - Semantic-only results are capped at k = 8.

### Why tags

- Each row carries one muted tag: `title`, `text` or `◇ meaning`, choosing the strongest contributing signal.
- Fuzzy rows keep their letter highlighting.
- Meaning-only rows show the first line of the best-matching chunk as a snippet.

### Timing and stability

- Fuzzy results update on every keystroke, as now.
- Semantic results run only when the query has at least 3 characters, debounced at 250 ms. A newer query cancels an older one.
- New semantic rows fade in with the existing quiet fade.
- While focus is inside the results list, re-ranking is held, and it applies when focus leaves or the query changes. The list never moves under the cursor.
- If embedding is partial, the results header adds "meaning covers 142 of 210 notes".

### Progress

- **Home.** Under the search field, a 2px ink bar fills with the text "Indexing by meaning · 142 / 210".
  - It shows only while the toggle is on and coverage is incomplete, and fades out when complete.
  - During the download phase it reads "Downloading model · 18 / 34 MB".
- **Settings.** The "Search by meaning" section holds:
  - the toggle, with the note "downloads about 34 MB once to this device";
  - a model bar during download;
  - one bar per vault, "Work · 142 / 210 notes".
  - The per-vault bars show even when the toggle is off, because they describe how much Related covers.
  - A private-window warning appears when `storage.persist()` is refused and the storage estimate suggests an ephemeral session.
- **Counting.** A note counts as embedded when its vector is fresh. An edit lowers the count until that note is re-embedded.
- **Accessibility.** Each bar has `role="progressbar"`, `aria-valuenow`, `aria-valuemax` and a visible text label.
- **Reduced motion.** The width changes instantly.

### Keyboard

Unchanged. Enter opens the top result, and the arrow keys move through results.

## Section 3: preview Related, errors, security, testing

### Preview Related

- **Contents.** Under the content of the selected note or folder Index (and the hub, which is the root Index), show up to 5 nearest notes.
  - Each note is represented by its mean vector.
  - The floor is 0.55.
  - The previewed note itself is excluded, and stale vectors are excluded on both sides.
- **Rows.** Each row shows the title, the folder path in muted text, and a `◇` mark whose fill reflects similarity.
- **Click.** Clicking a row selects that note, the same as clicking its map dot (the preview changes, and the map shows the ink path).
- **Empty.** The section is hidden when there are no candidates.
- **Without the model.** Related works with the toggle off, as long as vectors exist.

### Errors

- **Download failure** (offline, 404, sha mismatch). Settings shows the error and a Retry button, and the phase becomes `error`. Search stays fuzzy-only. This never blocks.
- **Worker crash or OOM.** The worker restarts once. After a second failure the phase becomes `paused` for the session, with a notice in Settings.
- **Upload failure.** The vector stays queued in memory, and the upload is retried with backoff (1 s, 4 s, 16 s, then on the next save or unlock).
- **Vector won't decrypt.** It is treated as missing and re-embedded.
- **422 on `sourceUpdatedAt`** (the note changed while it was being embedded). The vector is dropped and the note re-queued.

### Security

- Vectors are encrypted with the vault key. The AAD binds the note id and the model, so one note's vector can't be swapped into another note's slot.
- The server stores only ciphertext, the model name and a timestamp the note already exposes.
- Ciphertext length reveals the chunk count, which roughly matches the body size the server already sees.
- Plaintext embeddings must never leave the browser, because inversion attacks can rebuild much of the source text from them.
- Model files are public data. They are served from our own origin, integrity-checked by sha256, and need no CSP changes.
- Server limits: the vector size cap, the model string pattern and rate limiting.

### Testing

- **`core` unit tests:**
  - chunking (title prefix, overlap, cap at 16);
  - quantize/dequantize round trip within tolerance;
  - cosine, `noteScore`, `meanVector`, `topK` with floor;
  - the `mergeRank` formula, exact-title pinning, the caps and the why tags;
  - `isFresh`;
  - vector encryption round trip, plus failure on a wrong AAD.
- **`server` tests:**
  - the vector routes' auth and ownership;
  - size and pattern limits;
  - 422 on a future `sourceUpdatedAt`;
  - a vector PUT leaves `notes.updated_at` unchanged;
  - cascade on note and vault delete.
- **`web` tests** use a fake embedder (deterministic hash-based unit vectors) and never the real model. They cover:
  - the toggle off loading no semantic chunk;
  - the toggle on starting the worker;
  - a manifest 404 hiding the toggle;
  - progress counts, including a drop after an edit;
  - the merged result list with why tags and the coverage note;
  - the held re-ranking while focus is in the results;
  - Related in the preview, including with the toggle off;
  - error phases (download error with Retry, worker paused);
  - the lock dropping vectors and terminating the worker.
- **Manual check** on the `inked-test` stack with the real model:
  - "car" finds a note about vehicles;
  - a reload and unlock loads the model with no network fetch of model files.
- **Build check.** `INKED_SEMANTIC=1` serves `/models/manifest.json`, and `INKED_SEMANTIC=0` returns 404 for it.

## Out of scope

- A Related list on the note page.
- Semantic cues on the map (round 4b).
- Multilingual models.
- Embedding inside the MCP server.
- An approximate-nearest-neighbour index, since brute force is enough below about 1,000 notes.
