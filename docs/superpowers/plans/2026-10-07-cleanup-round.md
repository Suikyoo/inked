# Cleanup Round Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the open follow-ups, the concept-map leftovers, the compose header hazard and the DESIGN.md design debt.

**Architecture:** Small, independent fixes in existing modules. Each task is a coherent unit with its own tests. The triage table in the spec is the authority for each item's concrete change and pinning test.

**Tech Stack:** TypeScript; Fastify 5 + node:sqlite (server, vitest); React 18 + Vite (web, vitest + jsdom, no testing-library); bash smoke test; Docker Compose.

**Spec:** `docs/superpowers/specs/2026-10-07-cleanup-round-design.md`. Its "Triage" section has one row per item id (P2, D2a, M1, …), giving the FIX approach and the test that pins it. Read the rows your task names before coding.

## Global Constraints

- No change to the crypto format, AAD strings, KDF bounds or API request/response shapes.
- No new dependencies.
- localStorage keys stay exactly `inked.lastUsername` and `inked.spellcheck`.
- CSP `style-src 'self'`: never inject `<style>` or set `style` attribute strings. React `style` props are fine.
- Local Docker test stacks only with `-p inked-test -f compose.yaml -f compose.local.yaml` and a temp `INKED_DATA_DIR`. They must never join `cloudflared-net`. Always tear down with `docker compose -p inked-test -f compose.yaml -f compose.local.yaml down -v`.
- Commands from the repo root `C:\Users\User\Desktop\stuff\notes`: `npm test -w server`, `npm test -w web`, `npm run build -w web`, `npm run build -w server`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Item ids in commit bodies: list the triage ids each commit closes.

## Review Focus

1. **Session race (D3a/D3b).** A tab whose sign-in completes after a peer signed out must end up signed out on the server too, never holding a live cookie the user believes is gone. Pinned in Task 3.
2. **Duplicate-copy guard (D4a).** A 409 counts as "saved" only when the server's stored ciphertext is byte-identical to the queued one. Any other 409 still makes a copy. Pinned in Task 4.
3. **Redaction (D2a).** Percent-encoded and mixed-case `/join` paths must be redacted, and ordinary paths must stay readable. Pinned in Task 2.
4. **Modifier passthrough (M2).** Ctrl/Meta/Alt + Arrow on a focused map dot must not be `preventDefault`ed, while plain arrows still navigate. Pinned in Task 6.
5. **Folder labels (M1).** At overview zoom, labels must stay visible for folders on an inked path (search hit or selection), so the user is never left with an unlabeled highlighted route. Pinned in Task 6.

---

### Task 1: Compose header, deploy smoke test and docs

**Items:** owner item 1 (compose header), P2, P3.

**Files:**
- Modify: `compose.yaml` (header comment, lines 1–2)
- Modify: `deploy/smoke-test.sh`
- Modify: `docs/deploy.md`
- Modify: any spec under `docs/superpowers/specs/` that shows `docker compose -f compose.yaml -f compose.local.yaml up` without `-p inked-test` (check with `grep -rn "compose.local.yaml up" docs`)

- [ ] **Step 1:** Replace the `compose.yaml` header line 2 with two comment lines.
  - First: `# Deploy guide: docs/deploy.md.`
  - Second: `# Local testing ONLY (never on the production host): d=$(mktemp -d); sudo chown 1000:1000 "$d"; INKED_DATA_DIR=$d docker compose -p inked-test -f compose.yaml -f compose.local.yaml up -d --build`.
  - Fix any spec occurrences the same way.
- [ ] **Step 2:** Apply P2 and P3 from the spec triage:
  - the smoke test prints a `FAIL:` line and exits non-zero on curl transport errors (ERR trap, `curl -sS`);
  - a new check fails if the test nginx container is attached to `cloudflared-net`;
  - `docs/deploy.md` states that Compose v2.24.4 or later is required for `!override`, with the `docker compose version` check.
- [ ] **Step 3:** Run `bash -n deploy/smoke-test.sh`. Expected: no output.
- [ ] **Step 4:** Run `bash deploy/smoke-test.sh` with no stack up. Expected: a `FAIL:` line and a non-zero exit.
- [ ] **Step 5 (only if Docker is available):**
  - `d=$(mktemp -d); INKED_DATA_DIR=$d docker compose -p inked-test -f compose.yaml -f compose.local.yaml up -d --build`. On Windows, skip the `chown`; Docker Desktop maps ownership.
  - Then `bash deploy/smoke-test.sh`. Expected: `smoke OK`.
  - Then `docker compose -p inked-test -f compose.yaml -f compose.local.yaml down -v`.
  - If Docker is unavailable or the stack cannot start, say so in the report (DONE_WITH_CONCERNS). Do not skip silently.
- [ ] **Step 6:** Commit with message `fix(deploy): safe local command in compose header; smoke test fails loudly and checks tunnel isolation`.

---

### Task 2: Server log redaction and cookie test hygiene

**Items:** D2a, D2b, D2c.

**Files:**
- Modify: `server/src/logging.ts`
- Test: `server/test/logging.test.ts`, `server/test/auth.test.ts`, `server/test/helpers.ts`

- [ ] **Step 1:** Write failing tests for D2a: `/%6Aoin/tok`, `/%6a%6F%69%6E/tok`, `//JOIN/tok` and `/%2Fjoin/tok` (whatever the spec row lists) are redacted to `/join/[redacted]`. `/api/notes/x?y=1` stays `/api/notes/x`.
- [ ] **Step 2:** Implement D2a in `redactUrl`: decode percent-escapes safely (a malformed escape must not throw), then apply the existing collapse and redaction.
- [ ] **Step 3:** D2b: in the setup and register cookie tests, assert `Max-Age` on `inked_device`. Add a test that builds an app with `cookieSecure: true` and asserts `Secure` on both cookies.
- [ ] **Step 4:** D2c: move the duplicated `authSaltOf` / `saltOf` helper into `server/test/helpers.ts` and import it from both tests.
- [ ] **Step 5:** Run `npm test -w server` and `npm run build -w server`. Expected: all pass.
- [ ] **Step 6:** Commit `fix(server): redact percent-encoded /join paths; cookie attribute tests; shared salt helper`.

---

### Task 3: Web session and tabs

**Items:** D3a, D3b, D3c, D3d, D3f, D5f.

**Files:**
- Modify: `web/src/state/store.ts`
- Test: `web/src/state/store.test.ts`, `web/src/api/client.test.ts`
- Modify: `docs/architecture.md` (one line on raced sign-in)

- [ ] **Step 1:** Write the failing tests the triage rows name:
  - D3a: a sign-in that completes after a peer `signout` broadcast logs the fresh session out (logout request sent, phase `signedOut`).
  - D3b: a peer sign-out that arrives during `boot()` is not overwritten by boot's result.
  - Pins for D3c/D3d/D3f/D5f: sign-out during the KDF phase, a peer sign-out on an already signed-out tab, the `requestUser` after a peer sign-out, and the `client.test` abort timing made deterministic.
- [ ] **Step 2:** Implement the fixes exactly as the triage rows describe, including removal of the dead `remember: true` branch.
- [ ] **Step 3:** Run `npm test -w web` and `npm run build -w web`. Expected: all pass.
- [ ] **Step 4:** Commit `fix(web): raced sign-in after peer sign-out ends its session; boot respects peer sign-out; session tests`.

---

### Task 4: Web queue and note load

**Items:** D4a, D4f, D5d. Run after Task 3, since both touch `store.ts`.

**Files:**
- Modify: `web/src/state/pending.ts`, `web/src/state/store.ts`, `web/src/api/client.ts` (optional `opts` on `getNote` if the triage row says so)
- Test: `web/src/state/pending.test.ts`, `web/src/state/store.test.ts`
- Modify: `docs/architecture.md` (queue line)

- [ ] **Step 1:** Write failing tests:
  - D4a: a 409 whose server body equals the queued ciphertext reports `saved` and creates no copy; a 409 with a different body still copies.
  - D5d: `loadNote` whose read is older than the stored head re-reads once and returns the current head and body.
  - D4f: deferred notices are kept per owner and never shown to another account.
- [ ] **Step 2:** Implement as in the triage rows.
- [ ] **Step 3:** Run `npm test -w web` and `npm run build -w web`. Expected: all pass.
- [ ] **Step 4:** Commit `fix(web): identical-ciphertext 409 counts as saved; loadNote re-reads a stale head; per-owner notice test`.

---

### Task 5: Markdown link-hook hardening

**Items:** D5e.

**Files:**
- Modify: `web/src/markdown/render.ts`
- Test: `web/src/markdown/render.test.ts`

- [ ] **Step 1:** Write failing render tests:
  - an href with TAB, LF or CR inside (for example `/\t/evil.example`, `/\n/evil`) is not routed in-app;
  - `data-internal` is absent;
  - `data-wikilink` is stripped from a non-internal `<a>`.
- [ ] **Step 2:** Implement in the DOMPurify hook. Classify the href with `[\t\n\r]` removed, and remove `data-wikilink` whenever the link is not internal.
- [ ] **Step 3:** Run `npm test -w web -- src/markdown/render.test.ts`, then the web suite. Expected: all pass.
- [ ] **Step 4:** Commit `fix(web): link classification ignores TAB/LF/CR; strip data-wikilink off non-internal links`.

---

### Task 6: Concept map and Home status

**Items:** M1, M2, M3.

**Files:**
- Modify: `web/src/map/ConceptMap.tsx`, `web/src/map/LocalMap.tsx`, `web/src/map/scene.ts` (if the triage row puts the folder-on-path helper there)
- Modify: `web/src/pages/HomePage.tsx`; create `web/src/pages/homeStatus.ts` (pure status helper) if the triage row does
- Test: `web/src/map/ConceptMap.test.tsx`, `web/src/map/LocalMap.test.tsx`, `web/src/map/scene.test.ts`, `web/src/pages/homeStatus.test.ts`

- [ ] **Step 1:** Write failing tests:
  - M1: at scale < `FOLDER_LABEL_SCALE` (the triage row's value; 0.9 if none is given), folder labels are hidden, except for folders on the chain of an inked note (hit, selected or hot). At or above the threshold, all are shown.
  - M2: Ctrl, Meta and Alt + ArrowRight on a focused dot are not `defaultPrevented` and do not move the roving tabindex, in both ConceptMap and LocalMap. A plain ArrowRight still moves it.
  - M3: with `vaultsStatus: 'error'`, the results column never says "Searching…" and shows the error or empty state the triage row specifies.
- [ ] **Step 2:** Implement as in the triage rows.
- [ ] **Step 3:** Run `npm test -w web` and `npm run build -w web`. Expected: all pass.
- [ ] **Step 4:** Commit `fix(map): folder labels by zoom or ink path; modifier+Arrow passes through; no "Searching…" after a load error`.

---

### Task 7: Design debt from DESIGN.md, PRODUCT.md refresh, follow-ups closed

**Items:** owner item 4 design debt (spec "Scope" 4); close `docs/superpowers/followups-2026-10-07.md`.

**Files:**
- Modify: `web/src/styles/tokens.css` and every stylesheet that has the off-token hex literals listed in the HTML comment at the end of `DESIGN.md`: the sync bar `#2b2029`, danger `#8f3348`/`#a33c54`, auth lead `#a8a3b8`, menu hover `#2e2b39`, scrollbar `#34323f`/`#2e2c38`/`#403d4d`, missing-link dashed border `#4a4659`, and code text `#cfcbda`. Find them with `grep -rn "#[0-9a-fA-F]\{6\}" web/src/styles --include=*.css`, excluding `tokens.css`.
- Modify: `web/src/styles/map.css` (`.lmap-caption`), `web/src/map/LocalMap.tsx` (caption text casing, if the text is uppercased there)
- Modify: `DESIGN.md` (replace the defects comment: the hex literals are now tokens, plus the local-map 10px label exception and its reason), `PRODUCT.md` (Stack and Users sections, per spec Scope 4)
- Modify: `docs/superpowers/followups-2026-10-07.md` (mark resolved; point to the cleanup-round spec, which lists FIX/ACCEPT per item)

- [ ] **Step 1:** Add tokens with semantic names. Reuse an existing token where its value is identical: `#34323f` is `--border-2`, `#2e2c38` is `--border`, `#4a4659` is `--map-pencil`. Otherwise add new ones, e.g. `--sync-bg`, `--danger`, `--danger-hover`, `--text-lead`, `--menu-hover`, `--scroll-thumb-hover`, `--code-text`. Replace every literal with its `var(...)`. Rendered colors must not change: each token holds the literal's exact value.
- [ ] **Step 2:** Make `.lmap-caption` 10px with no `text-transform` and no `letter-spacing`, color `--muted-3`. Its text stays sentence case ("links in", "same folder", "links out").
- [ ] **Step 3:** Update DESIGN.md, PRODUCT.md and the follow-ups file as listed.
- [ ] **Step 4:** Run `grep -rn "#[0-9a-fA-F]\{6\}" web/src/styles --include=*.css | grep -v tokens.css`. Expected: no output, unless a hex sits inside an SVG data URI or a comment; justify any remaining hex in the report. Then run `npm test -w web` and `npm run build -w web`. Expected: all pass.
- [ ] **Step 5:** Commit `chore(design): promote off-token colours to tokens; local-map caption to the type floor; PRODUCT.md stack; close follow-ups`.
