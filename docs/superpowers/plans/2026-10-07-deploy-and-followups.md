# Deployment (cloudflared + nginx) and Round-1 Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve Inked through nginx on the external `cloudflared-net` Docker network, with no host ports published. Close every open round-1 follow-up.

**Architecture:**
- **Deployment:** new compose files, an nginx template, an env example and a deploy guide. No app code changes are needed for deployment, because Inked already supports `TRUST_PROXY` CIDR lists and `COOKIE_SECURE`.
- **Server follow-ups:** in `server/src` — a revocable device cookie, log redaction, startup log, and tests.
- **Client follow-ups:** in `web/src` — cross-tab sign-out, the fail-closed edges, queue notices and robustness, stale-response handling, link handling, and tests.

**Tech Stack:**
- Docker Compose, nginx 1.27-alpine (official image, `/etc/nginx/templates` envsubst).
- Node 22, Fastify 5, TypeScript, Vitest 5.
- React 18, Vite 8, WebCrypto.

**Spec:** `docs/superpowers/specs/2026-10-07-deploy-and-followups-design.md` (base spec: `docs/architecture.md`).

## Global Constraints

- The server never receives plaintext or any key able to decrypt. Ciphertext format and AAD strings are unchanged.
- Only `inked.lastUsername` may be written to localStorage. Keys and decrypted data live only in memory.
- Every non-GET request carries `X-Inked: 1`. The session cookie `inked_session` is HttpOnly and SameSite=Strict. The device cookie `inked_device` is HttpOnly, SameSite=Strict, Path=/api/auth, 180 days, and Secure when `COOKIE_SECURE`.
- KDF bounds `65536 ≤ m ≤ 1048576`, `3 ≤ t ≤ 16`, `1 ≤ p ≤ 8` are unchanged.
- The lock order invariant is: flush(true) → read username → dropKeys → rememberUsername → signedOut state → (wait for peers) → logout. Sign-out uses the same order but forgets the username instead of remembering it.
- The pending queue holds ciphertext only. The settle bounds stay at 10 s on leave and 4 s on lock.
- Deployment publishes no host ports in `compose.yaml`.
  - The internal network is `inked-internal` (`internal: true`, subnet `172.31.250.0/28`).
  - nginx joins `cloudflared-net` (`external: true`) with alias `inked-nginx`.
  - Inked uses `TRUST_PROXY=172.31.250.0/28` and `COOKIE_SECURE=true`.
- Commits go on branch `deploy-and-followups`. Each commit ends with a blank line, then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands run from the repo root `C:\Users\User\Desktop\stuff\notes`:
  - server tests: `npm test -w server`
  - web tests: `npm test -w web`
  - build: `npm run build`
  - server typecheck: `npx tsc -p server --noEmit`
- Never touch port 8080 (another service) or the user's real `./data`. For a local stack, use the `compose.local.yaml` override on `127.0.0.1:8088`, with the project name `inked-test` (`docker compose -p inked-test ...`) and a throwaway data folder (see Task 1).

## Review Focus

1. **A request that arrives at nginx without `CF-Connecting-IP`** (local testing, or a misrouted request) must fall back to the TCP peer. It must never trust a client-supplied `X-Forwarded-For`. Task 1's smoke test pins this.
2. **After a password change, a device cookie issued before the change** must stop exempting from the per-account cap. Expected: the change revokes old devices. Task 2 pins this.
3. **Signing out in one tab while another tab has unsaved text.** The other tab's text must be queued as ciphertext and must not lose its keys before flushing. Expected: no silent loss. Task 3 pins this.
4. **A peer lock that arrives while this tab is mid-unlock.** This tab must end up locked cleanly, with no stray "Your session ended" message and no half-unlocked state. Task 3 pins this.
5. **A note saved from the queue while you are viewing another note.** Search and the conflict base for that note must reflect the saved version. Expected: no false "changed elsewhere" afterwards. Task 4 pins this.

---

### Task 1: Deployment — nginx behind cloudflared-net (spec Section 1)

**Files:**
- Modify: `compose.yaml` (replace the content entirely)
- Create:
  - `compose.local.yaml`
  - `deploy/nginx/templates/inked.conf.template`
  - `.env.example`
  - `docs/deploy.md`
  - `deploy/smoke-test.sh`
- Modify:
  - `docs/architecture.md` (Deployment pointer)
  - `.dockerignore` (exclude `deploy/`, `.env`)

**Interfaces:**
- Produces: the service names `inked` and `nginx`, nginx's alias `inked-nginx` on `cloudflared-net`, and nginx's `/healthz` endpoint.
- Consumes: Inked's existing `TRUST_PROXY` CIDR support and `COOKIE_SECURE`.

- [ ] **Step 1: Write the smoke test first** (`deploy/smoke-test.sh`, bash, `set -euo pipefail`). It assumes the stack runs at `http://127.0.0.1:${INKED_PORT:-8088}` and checks:

```bash
BASE="http://127.0.0.1:${INKED_PORT:-8088}"
fail() { echo "FAIL: $*"; exit 1; }
# 1. Through nginx: app answers, Inked's CSP and nginx HSTS present
h=$(curl -s -D - -o /dev/null "$BASE/api/status")
echo "$h" | grep -qi '^content-security-policy: default-src' || fail "CSP missing"
echo "$h" | grep -qi '^strict-transport-security: max-age=31536000' || fail "HSTS missing"
# 2. nginx health
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/healthz")" = 200 ] || fail "healthz"
# 3. Lockout keys on CF-Connecting-IP, not on client X-Forwarded-For
login() { curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' -H 'x-inked: 1' "$@" \
  -d '{"username":"smoke-nobody","authKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}'; }
for i in 1 2 3 4 5; do login -H 'CF-Connecting-IP: 203.0.113.10' >/dev/null; done
[ "$(login -H 'CF-Connecting-IP: 203.0.113.10')" = 429 ] || fail "IP A not locked"
[ "$(login -H 'CF-Connecting-IP: 203.0.113.11')" = 401 ] || fail "IP B wrongly locked"
# 4. Client-forged X-Forwarded-For alone cannot pick the keyed IP
[ "$(login -H 'X-Forwarded-For: 203.0.113.10')" != 429 ] || fail "XFF trusted from client"
# 5. Body limit enforced by nginx
big=$(head -c 6000000 /dev/zero | tr '\0' 'a')
[ "$(printf '{"x":"%s"}' "$big" | curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/setup" \
  -H 'content-type: application/json' -H 'x-inked: 1' --data-binary @-)" = 413 ] || fail "no 413"
echo "smoke OK"
```

Note on check 4: with the local override, the host's request reaches nginx from a Docker gateway address. If `CLOUDFLARED_NET_CIDR` covers that address, the missing `CF-Connecting-IP` header means nginx keeps the gateway IP. It must never use the client's `X-Forwarded-For`. The expected result is anything except a 429 caused by IP A's counter.

- [ ] **Step 2: Run the smoke test against the old setup to see it fail.**
  - Run: `bash deploy/smoke-test.sh` while the current container on 8088 is running (the old `compose.yaml` stack).
  - Expected: FAIL at "HSTS missing" (no nginx).
  - Then stop the old stack: `docker compose down`.

- [ ] **Step 3: Write `compose.yaml`**

```yaml
# Inked behind nginx on the external cloudflared-net network. No host ports are published.
# Deploy guide: docs/deploy.md.
# Local testing ONLY (never on the production host): d=$(mktemp -d); sudo chown 1000:1000 "$d"; INKED_DATA_DIR=$d docker compose -p inked-test -f compose.yaml -f compose.local.yaml up -d --build
services:
  inked:
    build: .
    restart: unless-stopped
    volumes:
      # The container runs as uid 1000 ("node"); on Linux: mkdir -p data && sudo chown 1000:1000 data
      - ${INKED_DATA_DIR:-./data}:/data
    environment:
      COOKIE_SECURE: "true"
      # Only nginx on the private network may set the client IP (it forwards Cloudflare's CF-Connecting-IP).
      TRUST_PROXY: "172.31.250.0/28"
    networks:
      - inked-internal

  nginx:
    image: nginx:1.27-alpine
    restart: unless-stopped
    depends_on:
      inked:
        condition: service_healthy
    environment:
      # Subnet of cloudflared-net; see .env.example for how to look it up.
      CLOUDFLARED_NET_CIDR: ${CLOUDFLARED_NET_CIDR:-172.16.0.0/12}
    volumes:
      - ./deploy/nginx/templates:/etc/nginx/templates:ro
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
    networks:
      inked-internal: {}
      cloudflared-net:
        aliases:
          - inked-nginx

networks:
  inked-internal:
    internal: true
    ipam:
      config:
        - subnet: 172.31.250.0/28
  cloudflared-net:
    external: true
```

- [ ] **Step 4: Write `compose.local.yaml`**

```yaml
# Local testing override: publishes nginx on localhost and allows non-HTTPS cookies.
# Needs the network once: docker network create cloudflared-net
services:
  inked:
    environment:
      COOKIE_SECURE: "false"
  nginx:
    ports:
      - "127.0.0.1:${INKED_PORT:-8088}:80"
```

- [ ] **Step 5: Write `deploy/nginx/templates/inked.conf.template`.** Use exactly the block in the spec's Section 1 under `deploy/nginx/templates/inked.conf.template`. That file is the authority; copy it verbatim.

- [ ] **Step 6: Write `.env.example`.** Use the spec's block, plus `INKED_DATA_DIR=./data` with the comment `# Where the encrypted database lives`.

- [ ] **Step 7: Write `docs/deploy.md`.** Cover the spec's steps 1–7 in prose, with the commands in code blocks. Include the Cloudflare dashboard step: Public hostname → Service `HTTP` → URL `inked-nginx:80`. Include the accepted-risk paragraph about other containers on `cloudflared-net`. Also add "Local test":

```
docker network create cloudflared-net   # once
docker compose -p inked-test -f compose.yaml -f compose.local.yaml up -d --build
bash deploy/smoke-test.sh
```

- [ ] **Step 8: Point the architecture doc at the deploy guide.** In `docs/architecture.md`, replace the old "Layout" lines about `compose.yaml` and its single service with: "`compose.yaml` — `inked` (private network only) + `nginx` (joins external `cloudflared-net`); see `docs/deploy.md`". Add `deploy/` and `.env` to `.dockerignore`.

- [ ] **Step 9: Validate config.**
  - Run: `docker network inspect cloudflared-net >/dev/null 2>&1 || docker network create cloudflared-net`
  - Run: `docker compose -f compose.yaml config -q && docker compose -f compose.yaml -f compose.local.yaml config -q` → exit 0.
  - Run: `docker compose -p inked-test -f compose.yaml -f compose.local.yaml run --rm --no-deps nginx nginx -t` → "syntax is ok" and "test is successful".

- [ ] **Step 10: Run the stack and the smoke test, with throwaway data.**
  - Use the throwaway data folder: `INKED_DATA_DIR=$(mktemp -d)`. If the variable isn't expanded through compose, create `./.smoke-data` (git-ignored) and use `INKED_DATA_DIR=./.smoke-data`.
  - Run: `docker compose -p inked-test -f compose.yaml -f compose.local.yaml up -d --build`, then wait for nginx to report healthy.
  - Run: `bash deploy/smoke-test.sh` → "smoke OK".
  - Run: `docker compose -p inked-test -f compose.yaml -f compose.local.yaml ps --format '{{.Service}} {{.Publishers}}'` → only nginx shows a published port.
  - Tear down: `docker compose -p inked-test -f compose.yaml -f compose.local.yaml down`, then delete the throwaway data folder.
  - Add `.smoke-data/` to `.gitignore` if you used it.

- [ ] **Step 11: Commit**

```bash
git add compose.yaml compose.local.yaml deploy .env.example docs/deploy.md docs/architecture.md .dockerignore .gitignore
git commit -m "feat(deploy): serve Inked through nginx on cloudflared-net" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Server follow-ups — revocable device cookie, redaction, startup log, tests (A1, B5, B6-server, C1-server)

**Files:**
- Modify:
  - `server/src/crypto.ts` (`deviceTag`)
  - `server/src/context.ts` (`setDeviceCookie`, `isKnownDevice`)
  - `server/src/routes/auth.ts` (call sites; setup and register set the device cookie)
  - `server/src/logging.ts`
  - `server/src/index.ts` (hop warning only when numeric)
- Test:
  - `server/test/auth.test.ts`
  - `server/test/logging.test.ts`
  - `server/test/http.test.ts`
  - `server/test/config.test.ts` (or a new `server/test/trustproxy.test.ts`)

**Interfaces:**
- Produces:
  - `deviceTag(serverSecret: Buffer, userId: string, authSalt: string): Buffer` = HMAC-SHA256 of `"device:" + userId + ":" + authSalt`.
  - `setDeviceCookie(ctx, reply, user: { id: string; auth_salt: string })`.
  - `isKnownDevice(ctx, request, user: UserRow | undefined)` uses `user?.auth_salt ?? ''` for the expected tag (so the cost is constant for unknown users).
- Consumes: the existing `UserRow.auth_salt`. `replaceCredentials` already rotates it on password change and on recover/finish.

- [ ] **Step 1: Write failing tests** (in `server/test/auth.test.ts`, using the file's existing helpers):

```ts
it('a password change revokes earlier device cookies (A1)', async () => {
  // log in once to obtain inked_device, change password, then exhaust the account cap from many IPs
  // and show the OLD device cookie no longer exempts (429), while a fresh login sets a new cookie that does
});
it('recovery revokes earlier device cookies (A1)', async () => { /* same shape via recover/finish */ });
it('setup and register set inked_device (A1)', async () => {
  // assert set-cookie contains inked_device=...; Path=/api/auth; HttpOnly; SameSite=Strict
});
```

Fill in each body using the suite's existing patterns. Earlier device-cookie tests already exhaust the cap from many IPs; reuse that code. Every `it` must assert status codes.

`server/test/logging.test.ts`:

```ts
expect(redactUrl('//join/abc')).toBe('/join/[redacted]');
expect(redactUrl('/JOIN/abc')).toBe('/join/[redacted]');
expect(redactUrl('/join/')).toBe('/join/[redacted]');
expect(redactUrl('/join/abc/')).toBe('/join/[redacted]');
expect(redactUrl('/v//123')).toBe('/v/123');
```

C1 server tests:
- **Burst test:** extend the existing test so it also asserts that at least one 429 body has `typeof retryAfter === 'number'` and that 429 response has a `retry-after` header.
- **`/api/auth/password` lockout:** 5 wrong `currentAuthKey` → 6th returns 429; then success after the lock clears is not needed.
- **`/api/auth/recovery-key` lockout:** the same as `/password`.
- **CSRF:** POST `/api/auth/recovery-key` without `x-inked` returns 403 `{error:'csrf'}`. The suite's `call` helper always adds the header, so use `app.inject` directly here.
- **Proxy hops:** `toFastifyTrustProxy(2)` returns a function `f` with `f('x', 0) === true`, `f('x', 1) === true` and `f('x', 2) === false`. Add an http test with `trustProxy: 2` and `x-forwarded-for: 198.51.100.1, 203.0.113.50, 203.0.113.9`: the keyed IP is the second-to-last entry, `203.0.113.50`. Prove it by locking that IP and showing a different second-to-last entry still gets 401.

- [ ] **Step 2: Run to see them fail** — `npm test -w server` → the new A1 and redaction tests FAIL. The C1 tests may pass immediately; they pin existing behaviour, so note which ones passed.

- [ ] **Step 3: Implement**
  - `deviceTag`: add the `authSalt` parameter and update every caller. In `setDeviceCookie`, take the user row (`{ id, auth_salt }`). In `isKnownDevice`, compute `expected = deviceTag(secret, claimedId, user && user.id === claimedId ? user.auth_salt : '')`. Keep the length check and `timingSafeEqual`.
  - Setup and register handlers: call `setDeviceCookie(ctx, reply, createdUserRow)` next to `startSession`. If the handler holds only an id, re-read the row with `findUser`.
  - `redactUrl(url)`:

```ts
export function redactUrl(url: string): string {
  const path = url.split('?')[0].replace(/\/{2,}/g, '/');
  return path.replace(/^\/join(\/[^/]*)?\/?$|^\/join\/.*$/i, '/join/[redacted]');
}
```

    Simplify it if your version passes all the redaction tests: every path that starts with `/join` (any case) becomes `/join/[redacted]`. Other paths only have their repeated slashes collapsed.
  - `server/src/index.ts`: log the "hop count is only safe…" warning only when `typeof config.trustProxy === 'number'`.

- [ ] **Step 4: Run** `npm test -w server` and `npx tsc -p server --noEmit` → PASS.

- [ ] **Step 5: Commit** — `fix(server): revocable device cookies, stricter redaction, proxy tests`

---

### Task 3: Client auth follow-ups — sign-out broadcast, fail-closed edges, title lock (A2, A3, A4, B6-auth)

**Files:**
- Modify:
  - `web/src/state/tabs.ts`
  - `web/src/state/store.ts` (`signOut`, `lock`, `unlock`, `register`, `recover`, peer hooks, `updateVault`)
  - `web/src/api/client.ts` (`logout` takes an `AbortSignal`; generic `request` passes `signal`)
  - `web/src/pages/NotePane.tsx` (title `readOnly={state.locking}`)
  - `web/src/pages/RegisterFlow.tsx` (short-token message)
- Test: `web/src/state/store.test.ts` (and `web/src/state/tabs.test.ts` if it exists)

**Interfaces:**
- Produces:
  - `TabMessage` gains `{ type: 'signout'; tab: string; id: string }`.
  - `TabHooks` gains `onPeerSignOut(): Promise<void>`.
  - `TabLink.announceSignOut(): { peersDone: Promise<void> }`. Peers answer `lock-done` with the same id; reuse the waits map.
  - `api.logout(signal?: AbortSignal)`.
  - Constant `LOGOUT_TIMEOUT_MS = 5000` in `store.ts`.
- Consumes: the existing `announceLock`, `previousSessionGone`, `sessionEnd`, `flushAll(true)`, `dropKeys`, `forgetRememberedUsername` and `rememberUsername`.

- [ ] **Step 1: Write failing tests** (`store.test.ts`, using the existing BroadcastChannel stub and captured 401 handler):
  1. **A2:** tab A `signOut()` with tab B unlocked and B's editor dirty. B flushes while its keys are present: B's `pendingCount` becomes 1, or its save is sent. B then drops keys and goes to `signedOut`, and `localStorage['inked.lastUsername']` is absent afterwards. A calls logout only after B answers, or after 4 s.
  2. **A3a:** `api.logout` never resolves. Lock completes, and `unlock()` proceeds after at most `LOGOUT_TIMEOUT_MS`. Use fake timers. Assert that logout was called with an `AbortSignal` that becomes aborted.
  3. **A3b:** `recover()` and `register()` await a pending logout started by `lock()`. With an unresolved logout promise, `api.recoverFinish` / `api.setup` is not called until the logout settles or times out.
  4. **A3c:** tab B is mid-`unlock()` (its `api.login` is pending) when tab A broadcasts a lock. After B's login resolves, B ends in `signedOut`, its notice is A's notice (not "Your session ended"), and it dropped any keys it unwrapped.
  5. **B6:** `updateVault` after `lock()` rejects with `LockedError`.

- [ ] **Step 2: Run** `npm test -w web -- store` → FAIL.

- [ ] **Step 3: Implement**
  - **Sign-out:** `signOut()` follows lock's shape. Set `locking`, then `announceSignOut()`, then `flushAll(true)`, then `dropKeys()`, then `forgetRememberedUsername()`, then set the `signedOut` state. Then await `peersDone` and call `logout(signal)` with timeout.
  - **Peer sign-out:** the `onPeerSignOut` hook calls a private `endFromPeer({ remember: false })`. It skips if already `signedOut`/`setup` or `locking`. Otherwise it sets `locking`, then `flushAll(true)`, then `dropKeys()`, then `forgetRememberedUsername()`, then sets `signedOut` with notice `null`. It never calls logout.
  - **Logout timeout:** wrap every `api.logout()` call (lock and signOut) in a helper:

```ts
private async logoutBounded(): Promise<void> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), LOGOUT_TIMEOUT_MS);
  try { await api.logout(ac.signal); } catch { /* keys are gone either way */ } finally { clearTimeout(t); }
}
```

    `client.ts`: add an optional `signal` to `request` options and pass it to `fetch`. An abort produces the existing network-style error, which callers already swallow.
  - **Recover and register:** add `await this.previousSessionGone();` as the first awaited step of each, the same as `unlock()`.
  - **Lock during unlock:**
    - Track `private unlocking: Promise<void> | null`, set for the duration of `unlock()`.
    - In the peer-lock hook, if `this.unlocking` is set, `await this.unlocking.catch(() => undefined)` and then run `this.lock(notice, { fromPeer: true })`. The lock happens through the normal path after unlock completes. The hook's promise resolves after that, so the initiator's `lock-done` wait covers it.
    - If the unlock fails, there is nothing to lock.
  - **Title:** add `readOnly={state.locking}` to the title input in `NotePane.tsx`.
  - **Setup token:** before submitting in `RegisterFlow.tsx`, if `token.trim().length < 8`, show "That setup token is too short — copy the whole token from the server log." and don't submit.
  - **`updateVault`:** if the epoch changed after the await, `throw new LockedError()` instead of returning silently.

- [ ] **Step 4: Run** `npm test -w web` and `npm run build -w web` → PASS.

- [ ] **Step 5: Commit** — `fix(web): sign-out reaches every tab; bounded logout; lock during unlock locks cleanly`

---

### Task 4: Queue follow-ups — accurate notices, ownership counts, timeouts, refresh after save (B1, B2, B6-queue, C1-queue)

**Files:**
- Modify:
  - `web/src/state/pending.ts`
  - `web/src/state/store.ts` (`sendQueued`, `retryPending`, notices, `pendingCount`, refresh after save)
  - `web/src/api/client.ts` (optional per-request timeout)
  - `web/src/pages/useNoteEditor.ts` (catch in the unmount chain)
- Test:
  - `web/src/state/pending.test.ts`
  - `web/src/state/store.test.ts`
  - `web/src/pages/useNoteEditor.test.ts`

**Interfaces:**
- Produces:
  - `PendingOutcome` becomes `'saved' | 'copied' | 'copiedToRoot' | 'dropped' | 'retry'`.
  - `sendPending` returns `{ outcome: PendingOutcome; reason?: 'deleted' | 'rejected' | 'too_large' }`. Adapt the callers; a reason is set only for `'dropped'`.
  - `request` options accept `timeoutMs?: number` (it uses an AbortController). Queued `updateNote`/`createNote` calls use `timeoutMs: 30_000`.
  - `store.pendingCount` counts only items with `owner === state.user?.id`. While signed out, it counts items for `lastUsername`'s owner id if known, else 0. Use the simplest choice that satisfies the test; owner ids are stored on the items.
- Consumes: the existing `stashUnsaved`, held/racing logic, `owner` on entries, and the copy notice text.

- [ ] **Step 1: Write failing tests**
  1. **`sendPending`:**
     - 404 → `{outcome:'dropped', reason:'deleted'}` (at root).
     - 400 → `{outcome:'dropped', reason:'rejected'}`.
     - 413 → `{outcome:'dropped', reason:'too_large'}`.
     - Folder deleted → `copiedToRoot`.
     - A `createNote` 409 with `code !== 'exists'` → `'retry'`.
     - A `createNote` 409 with `code === 'exists'` → `'copied'`.
  2. **Store notices:**
     - A dropped item for each reason shows its notice:
       - deleted: "…couldn’t be kept because its note or vault was deleted elsewhere."
       - rejected: "An unsaved change was rejected by the server and couldn’t be saved."
       - too_large: "An unsaved change was too large to save."
       - plural forms for each.
     - `copiedToRoot` shows "…saved as an “(unsaved copy)” note at the top of the vault because its folder was deleted."
  3. **Copy notice during lock:** a copy notice produced during `lock()`'s flush is shown after the next `unlock()`. Keep it in a private `deferredNotice` that survives the lock.
  4. **`pendingCount` and ownership:** after user A locks with 1 queued item and user B signs in, B's `pendingCount === 0` and A's item is not sent. When A signs in again, the count is 1 and the item is sent.
  5. **Refresh after save:**
     - A queued item that comes back `'saved'` while unlocked updates that note's head `updatedAt` in the tree (and its body, if loaded).
     - An editor opened on that note afterwards uses the new base: a subsequent autosave does not 409. Mock `updateNote` to accept only the new base.
  6. **Hung request:** a queued send whose `updateNote` never resolves times out after 30 s (fake timers) and is retried. It doesn't hold the queue forever.
  7. **Retry triggers:**
     - the `online` event triggers `retryPending`;
     - the 30 s interval triggers it while items are pending, then stops when empty;
     - `beforeunload` sets `returnValue` when `hasUnsavedWork()`.
  8. **`useNoteEditor` unmount:** unmounting calls `store.trackSettle` with a settle, and unregisters the flusher after it settles. Use `@testing-library/react`'s `renderHook` if it's already a dev dependency. Otherwise test it through the exported `settle` plus a fake store, and note this in the report.

- [ ] **Step 2: Run** `npm test -w web` → the new tests FAIL.

- [ ] **Step 3: Implement** to satisfy the tests:
  - Keep the ciphertext-only invariant.
  - In the unmount chain, use `settle(s, false).catch(() => undefined).finally(unregister)`.
  - After a `'saved'` outcome, call a private `refreshNoteHead(vaultId, noteId)`. It does `GET /api/notes/:id` while unlocked, decrypts the meta, applies `putHead`, and updates the body only if the note is loaded. Mark the stamp as own via `markOwn`, so adopting it isn't treated as foreign.

- [ ] **Step 4: Run** `npm test -w web` and `npm run build -w web` → PASS.

- [ ] **Step 5: Commit** — `fix(web): queue notices name the cause; owner-scoped counts; timeouts; refresh after queued save`

---

### Task 5: Stale responses, links, cleanups and remaining web tests (B3, B4, B6-rest, C1-web)

**Files:**
- Modify:
  - `web/src/state/store.ts` (`putHead`, `loadNote`, `saveNoteBody`)
  - `web/src/markdown/render.ts`
  - `web/src/pages/NotePane.tsx` (click handler)
  - `web/src/lib/util.ts` (JSDoc placement)
  - `web/src/components/RecoveryKeyPanel.tsx` (remove the unused `error` prop)
- Test:
  - `web/src/state/store.test.ts`
  - `web/src/markdown/render.test.ts`
  - `web/src/pages/useNoteEditor.test.ts`
  - `web/src/App.test.tsx` (create; jsdom)

**Interfaces:**
- Produces: `putHead(vaultId, head)` returns `boolean` (`true` when stored, `false` when dropped as stale). `loadNote` and `saveNoteBody` skip the `bodies` write when it returns `false`.

- [ ] **Step 1: Write failing tests**
  1. **Stale head:**
     - Store a head with `updatedAt 't2'`, then `putHead` an older head `'t1'` with a different title. The stored title stays the `t2` title. Today it merges, so this fails.
     - A late `loadNote` whose head is older than the stored one leaves `bodies[id]` unchanged.
  2. **Links (render tests):**
     - `[x](/\evil.example)` renders with no `data-internal` that resolves off-origin. Assert that the href is percent-encoded and same-origin, and that any `data-internal` present is on an `href` starting with `/` and not `//`.
     - `[j](javascript:alert(1))` renders no `href` with `javascript:`.
     - A link rendered from markdown can never carry `data-internal` unless its href starts with a single `/`. Feed the hook a node with `data-internal` and an `https:` href, and assert it is stripped.
  3. **Link clicks (NotePane):** a click with `ctrlKey`, `metaKey` or `shiftKey`, or with `button === 1`, on an internal link does not call `preventDefault` or navigate. Test the extracted handler function, or render NotePane minimally if that's practical.
  4. **adoptHead:** an `adoptHead` with a foreign stamp (one not created by this tab) does not change the editor's base. Assert via the next save's `baseUpdatedAt`.
  5. **Insecure context:** `App.test.tsx` renders `<App store={…} />` with `window.isSecureContext` stubbed to `false`. It shows "Inked needs a secure connection" and does not call `store.boot`.

- [ ] **Step 2: Run** `npm test -w web` → the new tests FAIL (those already passing pin existing behaviour; note them).

- [ ] **Step 3: Implement**
  - In `putHead`: if a stored head has `updatedAt > head.updatedAt`, return `false` without writing.
  - In the render hook: `node.removeAttribute('data-internal')` in the external and other branches.
  - NotePane handler: `if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;` before internal or wiki navigation.
  - Move the `describeError` JSDoc back above its function.
  - Remove the unused `error` prop and its rendering from `RecoveryKeyPanel`, and from its type.

- [ ] **Step 4: Run** `npm test -w web` and `npm run build -w web` → PASS.

- [ ] **Step 5: Commit** — `fix(web): drop stale heads, safer link clicks, cleanups, more tests`

---

### Task 6: Docs (C2)

**Files:**
- Modify: `docs/architecture.md`
- Modify: `docs/superpowers/followups-2026-10-06.md`

- [ ] **Step 1: Update `docs/architecture.md`**
  - Links: "Root-relative Markdown links (`/…`) and `[[wiki-links]]` are routed in-app; other links open in a new tab."
  - API table: add 429 `locked` (with `retryAfter`) to the `/api/auth/password` and `/api/auth/recovery-key` rows.
  - TRUST_PROXY: list the aliases. `no`/`off`/`0`/`false`/unset all disable it, and `yes`/`on`/`true` all mean 1 hop.
  - Device cookie: the HMAC binds `auth_salt`, so a password change or recovery revokes earlier devices. Setup and register set the cookie.
  - Cross-tab: sign-out is broadcast like lock, and peers flush, drop keys and forget the username.
  - Logout: bounded at 5 s. Sign-in, recovery and registration wait for a pending logout. A peer lock during an unlock locks after the unlock completes.
  - Queue: drop reasons, root copies, owner-scoped counts, a 30 s request timeout, and the head refresh after a queued save.
- [ ] **Step 2:** Replace the body of `docs/superpowers/followups-2026-10-06.md` with "Resolved by `docs/superpowers/specs/2026-10-07-deploy-and-followups-design.md` (plan `docs/superpowers/plans/2026-10-07-deploy-and-followups.md`)", followed by the original list kept under a "History" heading.
- [ ] **Step 3: Commit** — `docs: architecture and follow-ups updated for deploy + follow-up fixes`

---

### Task 7: Full verification

- [ ] **Step 1:** Run `npm test`. Server and web tests should all pass; record the counts.
- [ ] **Step 2:** Run `npm run build` and `npx tsc -p server --noEmit`. Both should exit 0.
- [ ] **Step 3:** Bring up the local stack (Task 1 Step 10 procedure, with throwaway data) and run `bash deploy/smoke-test.sh`. It should print "smoke OK".
- [ ] **Step 4:** With the local stack running, check these in the browser:
  - Setup via the token printed in `docker compose -p inked-test logs inked`.
  - Create a note.
  - Open two tabs and sign out in one. The other tab goes to the sign-in screen, and its unsaved text syncs after sign-in.
  - Lock, then unlock.
- [ ] **Step 5:** Grep the throwaway database for the canary strings. Expect 0 matches. Then tear down and delete the throwaway data.
- [ ] **Step 6:** Request the final whole-branch review (superpowers:requesting-code-review), using this plan and the spec as the requirements.
