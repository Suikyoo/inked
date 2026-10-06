# Round-1 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every Important finding (I1–I5) and the accepted Minor findings (M1–M11) from the round-1 security review of Inked, without weakening the zero-knowledge design.

**Architecture:** Server fixes live in `server/src` (limiter, config, auth routes, app error handler, logger). Client fixes live in `web/src` (crypto params, store session/lock logic, a new ciphertext-only "pending saves" queue that guarantees no silent loss of edits, editor flush rework, settings UI, markdown link routing, boot gate). Docs and compose get matching updates.

**Tech Stack:** Node 22 (`node:sqlite`), Fastify 5, TypeScript, Vitest 5; React 18, Vite 8, react-router-dom 7, WebCrypto, hash-wasm.

**Spec:** `docs/architecture.md` (round-1 spec). Review findings are the source of each task; IDs (I1…, M1…) are quoted in task titles.

## Global Constraints

- Server never receives plaintext or any key able to decrypt. Anything new stored or sent must be ciphertext (`v1.` format) or a hash.
- Ciphertext format `"v1." + base64url(iv[12] || ct||tag)`, AES-256-GCM, AAD strings exactly as in `docs/architecture.md`.
- KDF params bounds (both sides after Task 3/5): `alg = "argon2id"`, `65536 ≤ m ≤ 1048576`, `3 ≤ t ≤ 16`, `1 ≤ p ≤ 8`. Defaults stay `{m: 65536, t: 3, p: 1}`.
- Every non-GET request carries `X-Inked: 1`; cookie `inked_session` HttpOnly SameSite=Strict.
- Keys and decrypted data live only in memory. Only the username may go to `localStorage` (key `inked.lastUsername`).
- Do not commit unless the user has approved committing; when approved, commit per task on branch `fix/review-round1`.
- Run commands from the repo root `C:\Users\User\Desktop\stuff\notes`. Server tests: `npm test -w server`. Web tests: `npm test -w web`. Builds: `npm run build`.

## Review Focus

- Parallel bursts of wrong passwords (from one IP, or spread across spoofed `X-Forwarded-For` values) must hit the lockout; a reasonable user expects ≤ 5 guesses/minute per account+client. Pinned in Task 1 and Task 2 tests.
- Going offline, then locking or idle-locking with unsaved edits: the edits must survive and sync after unlock. Pinned in Task 7 tests.
- Leaving a note while it shows a save conflict: the user's text must be kept (as a copy note), never dropped. Pinned in Task 7 tests.
- A tab crash on the recovery-key screen, or using the recovery key once: the user must be able to issue a fresh key. Pinned in Task 4 and Task 6 tests.
- Opening Inked over plain `http://<LAN-IP>`: the user must see why it can't work (HTTPS needed), not "Something went wrong". Pinned in Task 5 test.

---

### Task 1: Lockout survives parallel bursts; per-account cap (I1)

**Files:**
- Modify: `server/src/limiter.ts`
- Modify: `server/src/routes/auth.ts` (`checkSecret`, `/api/auth/password`)
- Modify: `server/src/context.ts` (add `accountLimiter` to `AppContext`)
- Modify: `server/src/app.ts` (construct `accountLimiter`, prune it hourly)
- Test: `server/test/limiter.test.ts` (create), `server/test/auth.test.ts`

**Interfaces:**
- Produces: `FailureLimiter.attempt(key: string, now?: number): number` — returns seconds to wait (> 0 means locked, attempt NOT recorded); otherwise records the attempt as a provisional failure and returns 0. `reset(key)` unchanged (call on success). `AppContext.accountLimiter: FailureLimiter` (per-username, IP-independent: 30 attempts / 15 min → 15 min lock).

- [ ] **Step 1: Write the failing unit test** (`server/test/limiter.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { FailureLimiter } from '../src/limiter.js';

describe('FailureLimiter.attempt', () => {
  it('counts attempts before verification so bursts lock after maxFails', () => {
    const l = new FailureLimiter(5, 60_000, 15 * 60_000);
    const now = 1_000_000;
    const results = Array.from({ length: 40 }, () => l.attempt('k', now));
    expect(results.filter((w) => w === 0)).toHaveLength(5);
    expect(results[5]).toBe(60);
  });

  it('reset clears provisional attempts after a success', () => {
    const l = new FailureLimiter(5, 60_000, 15 * 60_000);
    for (let i = 0; i < 4; i++) l.attempt('k', 0);
    l.reset('k');
    for (let i = 0; i < 4; i++) expect(l.attempt('k', 0)).toBe(0);
  });
});
```

- [ ] **Step 2: Write the failing integration test** (append to `server/test/auth.test.ts`, reuse its existing setup helpers and `inject` helper)

```ts
it('locks out a parallel burst of wrong logins (I1)', async () => {
  const { app } = t; // the suite's TestApp
  const acct = await setupAdmin(t); // existing helper in this file that creates the first user
  const wrong = key32();
  const responses = await Promise.all(
    Array.from({ length: 40 }, () =>
      app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-inked': '1' }, payload: { username: acct.username, authKey: wrong } }),
    ),
  );
  const codes = responses.map((r) => r.statusCode);
  expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(5);
  expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(35);
});
```

If the file's helper names differ (`setupAdmin`, `t`), use the existing ones; do not add new helpers for this.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -w server -- limiter auth`
Expected: FAIL — `l.attempt is not a function`, and the burst test sees 40 × 401.

- [ ] **Step 4: Implement `attempt` in `server/src/limiter.ts`**

```ts
  /**
   * Records an attempt up front (as a provisional failure) unless the key is locked.
   * Returns seconds to wait when locked (nothing recorded), else 0. Call reset() on success.
   * Counting before the async verification is what stops parallel bursts.
   */
  attempt(key: string, now = Date.now()): number {
    const wait = this.retryAfter(key, now);
    if (wait > 0) return wait;
    this.fail(key, now);
    return 0;
  }
```

- [ ] **Step 5: Use it in `checkSecret` (`server/src/routes/auth.ts`)**

```ts
  const key = `${scope}|${request.ip}|${name}`;
  const accountKey = `${scope}|${name}`;
  const wait = Math.max(ctx.limiter.attempt(key), ctx.accountLimiter.attempt(accountKey));
  if (wait > 0) throw lockedError(wait);

  const user = findUser(ctx.db, name);
  const ok = user ? await verifySecret(secret, stored(user)) : (await burnScrypt(secret), false);
  if (!user || !ok) throw invalidCredentials();
  ctx.limiter.reset(key);
  ctx.accountLimiter.reset(accountKey);
  return user;
```

Apply the same pattern to `/api/auth/password` (`key = password|ip|userId`): `attempt` before `verifySecret`, `reset` on success, no extra `fail` call.

- [ ] **Step 6: Add `accountLimiter`** — in `server/src/context.ts` add `accountLimiter: FailureLimiter` to `AppContext`; in `server/src/app.ts` construct `new FailureLimiter(30, 15 * 60_000, 15 * 60_000)` next to `limiter` and call `ctx.accountLimiter.prune()` in the hourly sweeper.

- [ ] **Step 7: Run all server tests**

Run: `npm test -w server`
Expected: PASS (existing lockout tests still pass: 5 wrong sequential logins then 429).

- [ ] **Step 8: Commit (only if approved)**

```bash
git add server/src/limiter.ts server/src/routes/auth.ts server/src/context.ts server/src/app.ts server/test/limiter.test.ts server/test/auth.test.ts
git commit -m "fix(server): count auth attempts before verify; add per-account cap"
```

---

### Task 2: Proxy-aware client IPs (I2)

**Files:**
- Modify: `server/src/config.ts`, `server/src/app.ts` (`AppOptions.trustProxy` type), `server/src/index.ts`
- Modify: `compose.yaml` (document `TRUST_PROXY`)
- Test: `server/test/config.test.ts` (create), `server/test/http.test.ts`

**Interfaces:**
- Produces: `parseTrustProxy(value: string | undefined): false | number | string` exported from `config.ts`. `Config.trustProxy` and `AppOptions.trustProxy` become `false | number | string` (Fastify's `trustProxy` accepts a hop count or a comma-separated list of IPs/CIDRs).

- [ ] **Step 1: Write the failing tests** (`server/test/config.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from '../src/config.js';

describe('parseTrustProxy', () => {
  it('defaults to false', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
  });
  it('accepts a hop count', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });
  it('maps "true" to exactly one hop instead of trusting every hop', () => {
    expect(parseTrustProxy('true')).toBe(1);
  });
  it('accepts IP / CIDR lists', () => {
    expect(parseTrustProxy('172.16.0.0/12, 10.0.0.5')).toBe('172.16.0.0/12,10.0.0.5');
  });
  it('rejects garbage', () => {
    expect(() => parseTrustProxy('yes please')).toThrow(/TRUST_PROXY/);
  });
});
```

Append to `server/test/http.test.ts`:

```ts
it('with one trusted hop, a client-forged X-Forwarded-For cannot dodge the lockout (I2)', async () => {
  const t1 = await makeApp({ trustProxy: 1 });
  try {
    const acct = await setupAdminOn(t1); // use this file's existing setup helper
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      // The proxy appends the real client (here always 203.0.113.9) after the forged value.
      const r = await t1.app.inject({
        method: 'POST', url: '/api/auth/login',
        headers: { 'x-inked': '1', 'x-forwarded-for': `198.51.100.${i}, 203.0.113.9` },
        payload: { username: acct.username, authKey: key32() },
      });
      codes.push(r.statusCode);
    }
    expect(codes.slice(5)).toEqual([429, 429, 429]);
  } finally {
    await t1.close();
  }
});
```

Extend `makeApp` in `server/test/helpers.ts` to accept `trustProxy?: false | number | string` and pass it to `buildApp`.

- [ ] **Step 2: Run to verify failure**

Run: `npm test -w server -- config http`
Expected: FAIL — `parseTrustProxy` not exported; `trustProxy` option type mismatch.

- [ ] **Step 3: Implement in `server/src/config.ts`**

```ts
export function parseTrustProxy(value: string | undefined): false | number | string {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  // "true" would make Fastify trust every hop, so a client could forge its IP. One hop is what a single reverse proxy needs.
  if (v === 'true' || v === 'yes' || v === 'on') return 1;
  if (/^\d+$/.test(v)) return Number(v);
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  const ipish = /^[0-9a-f:.]+(\/\d{1,3})?$/;
  if (parts.length && parts.every((p) => ipish.test(p))) return parts.join(',');
  throw new Error(`Invalid TRUST_PROXY: ${value} (use a hop count like 1, or proxy IPs/CIDRs)`);
}
```

Set `trustProxy: parseTrustProxy(env.TRUST_PROXY)` in `loadConfig`, change the `Config` and `AppOptions` types, and log at startup in `index.ts`: `app.log.info({ trustProxy: config.trustProxy }, 'proxy trust')`.

- [ ] **Step 4: Document in `compose.yaml`** under `environment:`

```yaml
      # Behind a reverse proxy (Traefik, Caddy, nginx) set this to the number of proxy hops (usually 1)
      # or the proxy's IP/CIDR, so login lockouts apply per real client IP. Leave unset when exposed directly.
      # TRUST_PROXY: "1"
```

- [ ] **Step 5: Run all server tests** — `npm test -w server` → PASS.

- [ ] **Step 6: Commit (only if approved)** — `git commit -m "fix(server): TRUST_PROXY takes hop count or proxy CIDRs"`

---

### Task 3: Setup token, invite-first registration, log redaction, KDF bounds, size errors (M8, M4, M3, M5-server, M10-server)

**Files:**
- Modify: `server/src/routes/auth.ts` (setup + register), `server/src/schemas.ts` (kdfParams bounds, setup schema), `server/src/context.ts` (`setupToken` on ctx), `server/src/app.ts` (create + log token; map encBody maxLength validation to 413), `server/src/index.ts` (logger serializer)
- Test: `server/test/auth.test.ts`, `server/test/http.test.ts`, `server/test/data.test.ts`, `server/test/helpers.ts`

**Interfaces:**
- Produces: `POST /api/setup` body gains required `setupToken: string`. Wrong/missing token → 403 `{error:"invalid_setup_token"}`. `buildApp` options gain `setupToken?: string` (tests pass a fixed one; production generates 16 random bytes base64url when there are zero users and logs it at `warn`: `Inked first-run setup token: <token>`). `GET /api/status` unchanged.
- Produces: kdfParams schema bounds `m 65536..1048576, t 3..16, p 1..8`.
- Produces: an `encBody` longer than the limit returns 413 `{error:"too_large"}` (not 400).
- Produces: `redactUrl(url: string): string` exported from `server/src/logging.ts` (create) — strips query, replaces `/join/<anything>` with `/join/[redacted]`.

- [ ] **Step 1: Failing tests**

`server/test/auth.test.ts`:

```ts
it('setup requires the one-time setup token (M8)', async () => {
  const body = registerBody('admin');
  const bad = await post(t.app, '/api/setup', { ...body, setupToken: 'nope' });
  expect(bad.statusCode).toBe(403);
  expect(bad.json().error).toBe('invalid_setup_token');
  const ok = await post(t.app, '/api/setup', { ...body, setupToken: TEST_SETUP_TOKEN });
  expect(ok.statusCode).toBe(200);
});

it('register with a bad invite fails fast without hashing (M4)', async () => {
  await setupAdmin(t);
  const started = performance.now();
  for (let i = 0; i < 10; i++) {
    const r = await post(t.app, '/api/auth/register', { ...registerBody(`u${i}xx`), inviteToken: 'x'.repeat(32) });
    expect(r.statusCode).toBe(403);
  }
  expect(performance.now() - started).toBeLessThan(150); // 10 × 2 scrypts would take ~300 ms+
});

it('rejects weak kdf params (M5)', async () => {
  const r = await post(t.app, '/api/setup', { ...registerBody('admin'), kdfParams: { alg: 'argon2id', m: 19456, t: 2, p: 1 }, setupToken: TEST_SETUP_TOKEN });
  expect(r.statusCode).toBe(400);
});
```

`server/test/data.test.ts`:

```ts
it('oversized note body returns 413 too_large (M10)', async () => {
  // ~2.1 MB of valid ciphertext characters, under the 4 MB request limit
  const huge = `v1.${'A'.repeat(2_100_000)}`;
  const r = await put(t.app, `/api/notes/${noteId}`, { encBody: huge }, acct.cookie);
  expect(r.statusCode).toBe(413);
  expect(r.json().error).toBe('too_large');
});
```

`server/test/logging.test.ts` (create):

```ts
import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/logging.js';

describe('redactUrl', () => {
  it('drops queries and invite tokens', () => {
    expect(redactUrl('/api/auth/params?username=bob')).toBe('/api/auth/params');
    expect(redactUrl('/join/abcDEF123_-')).toBe('/join/[redacted]');
    expect(redactUrl('/join/abc?x=1')).toBe('/join/[redacted]');
    expect(redactUrl('/v/123')).toBe('/v/123');
  });
});
```

In `helpers.ts`: export `TEST_SETUP_TOKEN = 'test-setup-token-0123456789abcdef'`, pass `setupToken: TEST_SETUP_TOKEN` to `buildApp` in `makeApp`, and include it in the existing setup helper's body so all existing tests keep working.

- [ ] **Step 2: Run to verify failures** — `npm test -w server` → new tests FAIL.

- [ ] **Step 3: Implement**

`server/src/logging.ts`:

```ts
/** Path for logs: no query string, and invite tokens (which live in /join/<token>) removed. */
export function redactUrl(url: string): string {
  const path = url.split('?')[0];
  return path.replace(/^\/join\/[^/]+/, '/join/[redacted]');
}
```

`server/src/index.ts` serializer: `req: (req) => ({ method: req.method, url: redactUrl(req.url), remoteAddress: req.ip })`.

`server/src/app.ts`: in `buildApp`, `const setupToken = opts.setupToken ?? (countUsers(db) === 0 ? randomBytes(16).toString('base64url') : null);` store on `ctx.setupToken`; after building, if `ctx.setupToken && !opts.setupToken` then `app.log.warn(`Inked first-run setup token: ${ctx.setupToken}`)` (use `app.ready` hook or log right after construction). In the error handler, before the generic validation branch:

```ts
    if (err.validation?.some((v) => v.keyword === 'maxLength' && /encBody/.test(v.instancePath))) {
      return reply.code(413).send({ error: 'too_large', message: 'Note is too large' });
    }
```

`server/src/routes/auth.ts` setup handler, first lines:

```ts
    const token = request.body.setupToken;
    if (!ctx.setupToken || !safeEqualStrings(token, ctx.setupToken)) throw new ApiError(403, 'invalid_setup_token');
```

with `safeEqualStrings` (in `server/src/crypto.ts`): compare SHA-256 digests of both strings via `timingSafeEqual`. After a successful setup set `ctx.setupToken = null`. Add `setupToken: { type: 'string', minLength: 8, maxLength: 128 }` to `setupSchema` (required).

Register handler: move the invite lookup before `hashRegistration`:

```ts
    const tokenHash = sha256Hex(request.body.inviteToken!);
    const live = () =>
      db.prepare('SELECT id FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(tokenHash, nowIso()) as
        | { id: string }
        | undefined;
    if (!live()) throw new ApiError(403, 'invalid_invite');
    const hashes = await hashRegistration(request.body);
    const user = transaction(db, () => {
      const invite = live(); // re-check: it may have been used while we hashed
      if (!invite) throw new ApiError(403, 'invalid_invite');
      ...unchanged...
    });
```

`server/src/schemas.ts` kdfParams: `m: { minimum: 65536, maximum: 1048576 }`, `t: { minimum: 3, maximum: 16 }`, `p: { minimum: 1, maximum: 8 }`.

- [ ] **Step 4: Run all server tests** — `npm test -w server` → PASS.

- [ ] **Step 5: Commit (only if approved)** — `git commit -m "fix(server): setup token, invite-first register, redact join tokens, kdf bounds, 413 for big notes"`

---

### Task 4: Recovery-key rotation endpoint (I5, server)

**Files:**
- Modify: `server/src/routes/auth.ts`
- Test: `server/test/auth.test.ts`

**Interfaces:**
- Produces: `POST /api/auth/recovery-key` (session required) body `{ currentAuthKey, recoveryAuth, wrappedUserKeyRecovery }`. Wrong `currentAuthKey` → 403 `invalid_credentials` (rate-limited with `attempt`, key `recoverykey|ip|userId`). Success → replaces `recovery_salt`, `recovery_hash` (scrypt of new `recoveryAuth`) and `wrapped_user_key_recovery`; returns `{ ok: true }`.

- [ ] **Step 1: Failing test**

```ts
it('rotates the recovery key; the old one stops working (I5)', async () => {
  const acct = await setupAdmin(t);
  const newAuth = key32();
  const bad = await post(t.app, '/api/auth/recovery-key', { currentAuthKey: key32(), recoveryAuth: newAuth, wrappedUserKeyRecovery: fakeCipher() }, acct.cookie);
  expect(bad.statusCode).toBe(403);
  const ok = await post(t.app, '/api/auth/recovery-key', { currentAuthKey: acct.authKey, recoveryAuth: newAuth, wrappedUserKeyRecovery: fakeCipher() }, acct.cookie);
  expect(ok.statusCode).toBe(200);
  const old = await post(t.app, '/api/auth/recover/start', { username: acct.username, recoveryAuth: acct.recoveryAuth });
  expect(old.statusCode).toBe(401);
  const fresh = await post(t.app, '/api/auth/recover/start', { username: acct.username, recoveryAuth: newAuth });
  expect(fresh.statusCode).toBe(200);
});
```

- [ ] **Step 2: Run** → FAIL (404 route).

- [ ] **Step 3: Implement** the route next to `/api/auth/password`, schema: `currentAuthKey`, `recoveryAuth` (43-char base64url as elsewhere), `wrappedUserKeyRecovery` (wrapped-key ciphertext schema already used by register). Body:

```ts
      const user = currentUser(request);
      const key = `recoverykey|${request.ip}|${user.id}`;
      const wait = ctx.limiter.attempt(key);
      if (wait > 0) throw lockedError(wait);
      if (!(await verifySecret(request.body.currentAuthKey, authOf(user)))) throw new ApiError(403, 'invalid_credentials');
      ctx.limiter.reset(key);
      const rec = await hashSecret(request.body.recoveryAuth);
      db.prepare('UPDATE users SET recovery_salt = ?, recovery_hash = ?, wrapped_user_key_recovery = ? WHERE id = ?')
        .run(rec.salt, rec.hash, request.body.wrappedUserKeyRecovery, user.id);
      return { ok: true };
```

- [ ] **Step 4: Run all server tests** → PASS.

- [ ] **Step 5: Commit (only if approved)** — `git commit -m "feat(server): rotate recovery key"`

---

### Task 5: Client guards — KDF floor, secure context, spellcheck, in-app links (M5-client, M6, M7, M9)

**Files:**
- Modify: `web/src/crypto/kdf.ts` (+ its test file under `web/src/crypto/`), `web/src/main.tsx` or `web/src/App.tsx` (boot gate), `web/src/pages/NotePane.tsx`, `web/src/markdown/render.ts`
- Create: `web/src/pages/InsecureContextPage.tsx`, `web/src/lib/prefs.ts`
- Test: `web/src/crypto/*.test.ts` (existing crypto test file), `web/src/markdown/render.test.ts`, `web/src/lib/prefs.test.ts` (create)

**Interfaces:**
- Produces: `MIN_KDF_PARAMS: KdfParams = { alg: 'argon2id', m: 65536, t: 3, p: 1 }` exported from `kdf.ts`; `assertKdfParams(p, floor = MIN_KDF_PARAMS)`; upper bounds `m ≤ 1048576, t ≤ 16, p ≤ 8` (unchanged).
- Produces: `prefs.spellcheck(): boolean` (default `false`) and `prefs.setSpellcheck(on: boolean)` in `web/src/lib/prefs.ts`, backed by `localStorage` key `inked.spellcheck`, wrapped in try/catch.
- Produces: rendered same-origin links (`href` starting with `/` and not `//`) get attribute `data-internal="1"` and no `target`.

- [ ] **Step 1: Failing tests**

Crypto test (append):

```ts
it('assertKdfParams floor is MIN_KDF_PARAMS, independent of defaults (M5)', () => {
  expect(MIN_KDF_PARAMS).toEqual({ alg: 'argon2id', m: 65536, t: 3, p: 1 });
  expect(() => assertKdfParams({ alg: 'argon2id', m: 65536, t: 3, p: 1 })).not.toThrow();
  expect(() => assertKdfParams({ alg: 'argon2id', m: 32768, t: 3, p: 1 })).toThrow();
  expect(() => assertKdfParams({ alg: 'argon2id', m: 131072, t: 4, p: 2 })).not.toThrow();
});
```

`render.test.ts` (append):

```ts
it('marks same-origin links internal so the router handles them (M9)', () => {
  const html = renderMarkdown('[a](/v/123) [b](https://example.com) [c](//evil.example)');
  expect(html).toContain('href="/v/123" data-internal="1"');
  expect(html).toContain('target="_blank"');
  expect(html).not.toMatch(/href="\/\/evil\.example"[^>]*data-internal/);
});
```

`prefs.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { prefs } from './prefs';

describe('prefs.spellcheck', () => {
  beforeEach(() => localStorage.clear());
  it('defaults to off (M7)', () => expect(prefs.spellcheck()).toBe(false));
  it('persists', () => {
    prefs.setSpellcheck(true);
    expect(prefs.spellcheck()).toBe(true);
  });
});
```

(Use the jsdom environment, as `render.test.ts` does — add the same `// @vitest-environment jsdom` header.)

- [ ] **Step 2: Run** `npm test -w web` → FAIL.

- [ ] **Step 3: Implement**

`kdf.ts`: add `export const MIN_KDF_PARAMS: KdfParams = { alg: 'argon2id', m: 65536, t: 3, p: 1 };` and change the default floor parameter of `assertKdfParams` to `MIN_KDF_PARAMS`. Re-export it from `web/src/crypto/index.ts`.

`render.ts` hook, replace the `A` branch:

```ts
      const href = node.getAttribute('href') ?? '';
      if (/^(https?:|mailto:)/i.test(href) || href.startsWith('//')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      } else if (href.startsWith('/')) {
        node.setAttribute('data-internal', '1');
        node.removeAttribute('target');
      } else {
        node.removeAttribute('target');
      }
```

Add `'data-internal'` to `ADD_ATTR`. In `NotePane.tsx`, in the existing click handler on the rendered article (the one that handles wiki links), add: if the clicked anchor has `data-internal="1"`, `e.preventDefault()` and `navigate(anchor.getAttribute('href')!)`.

`prefs.ts`:

```ts
const KEY = 'inked.spellcheck';
export const prefs = {
  spellcheck(): boolean {
    try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
  },
  setSpellcheck(on: boolean): void {
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* storage blocked: keep default */ }
  },
};
```

`NotePane.tsx`: `spellCheck={prefs.spellcheck()}`. Settings page gets a checkbox "Spell-check while editing" with helper text: "Off by default. Some browsers send text to an online service for enhanced spell-check, which would expose note content."

Boot gate: in `App.tsx` (top of the component), before routes:

```tsx
  if (!window.isSecureContext || !globalThis.crypto?.subtle) return <InsecureContextPage />;
```

`InsecureContextPage.tsx` uses `AuthLayout` and says: heading "Inked needs a secure connection", body "Encryption runs in your browser, and browsers only allow it over HTTPS or on localhost. Open Inked through an HTTPS address (for example behind a reverse proxy with a certificate), or on this machine at http://localhost." No buttons.

- [ ] **Step 4: Run** `npm test -w web` and `npm run build -w web` → PASS.

- [ ] **Step 5: Commit (only if approved)** — `git commit -m "fix(web): kdf floor, secure-context gate, spellcheck off, in-app links"`

---

### Task 6: Store — lock signs out, late results dropped, own timestamps, size check, recovery-key rotation, setup token (I3, M1, M2, M10-client, I5-client, M8-client)

**Files:**
- Modify: `web/src/state/store.ts`, `web/src/api/client.ts`, `web/src/api/types.ts`, `web/src/pages/useNoteEditor.ts` (adoptHead), `web/src/pages/SettingsPage.tsx`, `web/src/pages/RecoverPage.tsx`, `web/src/pages/SetupPage.tsx`, `web/src/pages/RegisterFlow.tsx`, `web/src/lib/util.ts` (error copy)
- Test: `web/src/state/store.test.ts` (create; mock `../api/client` with `vi.mock`, run argon2 with test params by mocking `../lib/argon2Worker` to call hash-wasm directly with `{m: 1024, t: 1, p: 1}` — and mock `assertKdfParams` floor accordingly via passing params through; simplest: `vi.mock('../crypto/kdf', async (orig) => ({ ...(await orig()), DEFAULT_KDF_PARAMS: { alg: 'argon2id', m: 1024, t: 1, p: 1 }, MIN_KDF_PARAMS: { alg: 'argon2id', m: 1024, t: 1, p: 1 } }))`)

**Interfaces:**
- Consumes: `POST /api/auth/recovery-key` (Task 4), `setupToken` on `/api/setup` (Task 3), `MIN_KDF_PARAMS` (Task 5).
- Produces:
  - `store.lock(notice?)`: flushes (Task 7 makes this lossless), drops keys, calls `api.logout()` (errors ignored), sets `phase: 'signedOut'` with `lastUsername` kept, persists username to `localStorage['inked.lastUsername']`. The login page shows "Unlocking as <name>" when `lastUsername` is set (existing UI). `boot()` reads `inked.lastUsername` into `lastUsername` when `/api/me` returns 401.
  - `store.rotateRecoveryKey(password: string): Promise<string>` — derives current authKey from the password, generates a new recovery key, wraps the in-memory `userKey`… (needs an extractable copy: unwrap `wrappedUserKey` from `api.me()` with the password KEK as extractable, wrap it under the new recoveryKEK with AAD `inked/userkey-recovery/{userId}`, then wipe), calls `api.rotateRecoveryKey({ currentAuthKey, recoveryAuth, wrappedUserKeyRecovery })`, returns the formatted key.
  - `store.register({ ..., setupToken? })` passes `setupToken` to `api.setup`.
  - `store.isOwnStamp(noteId: string, updatedAt: string): boolean` — true only for `updatedAt` values returned by this tab's own create/save/rename/move calls.
  - `NOTE_BODY_LIMIT = 2_000_000` (characters of `encBody`) exported from `store.ts`; `saveNoteBody` throws `new NoteTooLargeError()` before calling the API when exceeded.

- [ ] **Step 1: Failing tests** (`web/src/state/store.test.ts`)

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  status: vi.fn(), me: vi.fn(), params: vi.fn(), login: vi.fn(), logout: vi.fn(), setup: vi.fn(),
  listVaults: vi.fn(), createVault: vi.fn(), getNote: vi.fn(), updateNote: vi.fn(), rotateRecoveryKey: vi.fn(),
  tree: vi.fn(), bodies: vi.fn(),
}));
vi.mock('../api/client', async (orig) => ({ ...(await orig<typeof import('../api/client')>()), api }));
vi.mock('../crypto/kdf', async (orig) => {
  const m = await orig<typeof import('../crypto/kdf')>();
  const fast = { alg: 'argon2id' as const, m: 1024, t: 1, p: 1 };
  return { ...m, DEFAULT_KDF_PARAMS: fast, MIN_KDF_PARAMS: fast, assertKdfParams: (p: unknown) => p };
});
vi.mock('../lib/argon2Worker', async () => {
  const { argon2id } = await import('hash-wasm');
  return { argon2InWorker: (pw: Uint8Array, salt: Uint8Array, p: { m: number; t: number; p: number }) =>
    argon2id({ password: pw, salt, memorySize: p.m, iterations: p.t, parallelism: p.p, hashLength: 32, outputType: 'binary' }) };
});

import { AppStore } from './store';

async function registeredStore() {
  api.setup.mockImplementation(async (body: { userId: string; username: string }) => ({ user: { id: body.userId, username: body.username, isAdmin: true } }));
  api.createVault.mockImplementation(async (b: { id: string; encMeta: string; wrappedKey: string }) => ({ vault: { ...b, createdAt: 'x', updatedAt: 'x', noteCount: 0, activeNoteCount7d: 0 } }));
  const s = new AppStore();
  await s.register({ username: 'ann', password: 'pw-ann-123456', setupToken: 'tok-12345678' });
  return s;
}

describe('AppStore', () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });

  it('lock ends the server session and remembers only the username (I3)', async () => {
    const s = await registeredStore();
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(s.getState().phase).toBe('signedOut');
    expect(s.getState().lastUsername).toBe('ann');
    expect(localStorage.getItem('inked.lastUsername')).toBe('ann');
    expect(Object.keys(localStorage)).toEqual(['inked.lastUsername']);
  });

  it('passes the setup token through (M8)', async () => {
    await registeredStore();
    expect(api.setup.mock.calls[0][0].setupToken).toBe('tok-12345678');
  });

  it('drops a note load that finishes after lock (M1)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    let release!: (v: unknown) => void;
    api.getNote.mockReturnValue(new Promise((r) => (release = r)));
    const p = s.loadNote(vaultId, crypto.randomUUID()).catch((e) => e);
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    release({ note: { encMeta: 'v1.x', encBody: 'v1.y', folderId: null, size: 1, createdAt: 'a', updatedAt: 'b' } });
    await p;
    expect(s.getState().bodies).toEqual({});
  });

  it('refuses oversized bodies before calling the API (M10)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    await expect(s.saveNoteBody(vaultId, crypto.randomUUID(), 'x'.repeat(1_600_000))).rejects.toThrow(/too large/i);
    expect(api.updateNote).not.toHaveBeenCalled();
  });

  it('rotateRecoveryKey sends a new recovery proof and wrapped key (I5)', async () => {
    const s = await registeredStore();
    const setupBody = api.setup.mock.calls[0][0];
    api.params.mockResolvedValue({ kdfSalt: setupBody.kdfSalt, kdfParams: setupBody.kdfParams });
    api.me.mockResolvedValue({ user: { id: setupBody.userId, username: 'ann', isAdmin: true }, wrappedUserKey: setupBody.wrappedUserKey });
    api.rotateRecoveryKey.mockResolvedValue({ ok: true });
    const key = await s.rotateRecoveryKey('pw-ann-123456');
    expect(key).toMatch(/^inked-rk1-/);
    const sent = api.rotateRecoveryKey.mock.calls[0][0];
    expect(sent.currentAuthKey).toBe(setupBody.authKey);
    expect(sent.recoveryAuth).not.toBe(setupBody.recoveryAuth);
    expect(sent.wrappedUserKeyRecovery).toMatch(/^v1\./);
  });
});
```

Adapt mock method names to the real `api` object keys in `web/src/api/client.ts` (e.g. if listing vaults is `api.vaults`, use that); keep the assertions.

- [ ] **Step 2: Run** `npm test -w web -- store` → FAIL.

- [ ] **Step 3: Implement in `store.ts`**

Lock:

```ts
  /** Drops keys + decrypted data and ends the server session; only the username is remembered. */
  async lock(notice: string | null = null): Promise<void> {
    if (this.state.phase !== 'unlocked') return;
    await this.flushAll();
    const lastUsername = this.state.user?.username ?? this.state.lastUsername;
    this.dropKeys();
    rememberUsername(lastUsername);
    this.set({ phase: 'signedOut', user: null, lastUsername, notice, ...EMPTY_DATA });
    try { await api.logout(); } catch { /* keys are gone either way */ }
  }
```

with module helpers:

```ts
const LAST_USER_KEY = 'inked.lastUsername';
function rememberUsername(name: string) { try { localStorage.setItem(LAST_USER_KEY, name); } catch { /* ignore */ } }
function recallUsername(): string { try { return localStorage.getItem(LAST_USER_KEY) ?? ''; } catch { return ''; } }
```

In `boot()` 401 branch: `this.set({ phase: 'signedOut', user: null, lastUsername: recallUsername() })`. In `enterUnlocked` call `rememberUsername(user.username)`. `signOut()` keeps its behaviour (explicit sign-out also clears the remembered name: `try { localStorage.removeItem(LAST_USER_KEY) } catch {}`).

Epoch guards — `loadNote`:

```ts
    const ep = this.epoch;
    const key = this.vaultKey(vaultId);
    const { note } = await api.getNote(noteId);
    if (ep !== this.epoch) throw new LockedError();
    const meta = await decryptNoteMeta(key, vaultId, noteId, note.encMeta);
    const body = await decryptNoteBody(key, vaultId, noteId, note.encBody);
    if (ep !== this.epoch) throw new LockedError();
```

Same in `saveNoteBody` (capture `ep` before the API call; after it, if `ep !== this.epoch` return the head without touching state).

Own stamps + monotonic heads:

```ts
  private ownStamps = new Map<string, Set<string>>();
  private markOwn(noteId: string, updatedAt: string) {
    let set = this.ownStamps.get(noteId);
    if (!set) this.ownStamps.set(noteId, (set = new Set()));
    set.add(updatedAt);
  }
  isOwnStamp(noteId: string, updatedAt: string): boolean {
    return this.ownStamps.get(noteId)?.has(updatedAt) ?? false;
  }
```

Call `markOwn` in `createNote`, `saveNoteBody`, `renameNote`, `moveNote` with the returned `updatedAt`. Clear `ownStamps` in `dropKeys`. In `putHead`, keep the newer timestamp: `const prev = tree.notes[head.id]; if (prev && prev.updatedAt > head.updatedAt) head = { ...head, updatedAt: prev.updatedAt };`.

`useNoteEditor.adoptHead`:

```ts
    if (head.id === s.noteId && !s.inFlight && store.isOwnStamp(head.id, head.updatedAt) && (!s.base || head.updatedAt > s.base)) s.base = head.updatedAt;
```

Size check in `saveNoteBody` after encrypting: `if (encBody.length > NOTE_BODY_LIMIT) throw new NoteTooLargeError();` with `export class NoteTooLargeError extends Error { constructor() { super('This note is too large to save (about 1.5 MB of text is the limit).'); } }`. Also map server `too_large` in `lib/util.ts` `describeError` to the same sentence.

Recovery-key rotation:

```ts
  async rotateRecoveryKey(password: string): Promise<string> {
    const user = this.state.user;
    if (!user || !this.userKey) throw new LockedError();
    const { kdfSalt, kdfParams } = await api.params(user.username);
    const pw = await derive(password, kdfSalt, assertKdfParams(kdfParams));
    const { wrappedUserKey } = await api.me();
    const rkBytes = generateRecoveryKey();
    const text = formatRecoveryKey(rkBytes);
    const rk = await deriveRecoveryKeys(rkBytes);
    wipe(rkBytes);
    // Re-wrap the same userKey under the new recovery KEK (throws CryptoError('unwrap') on a wrong password).
    const wrappedUserKeyRecovery = await rewrapUserKey(
      wrappedUserKey,
      { kek: pw.passwordKEK, aad: aad.userKey(user.id) },
      { kek: rk.recoveryKEK, aad: aad.userKeyRecovery(user.id) },
    );
    await api.rotateRecoveryKey({ currentAuthKey: pw.authKey, recoveryAuth: rk.recoveryAuth, wrappedUserKeyRecovery });
    return text;
  }
```

`api.rotateRecoveryKey = (body) => request<{ ok: true }>('POST', '/api/auth/recovery-key', body)`; add `setupToken` to the setup body type.

- [ ] **Step 4: UI**
  - `SetupPage.tsx`: add a "Setup token" field above username with help text "Printed in the server log on first start (`docker compose logs inked`)." Map 403 `invalid_setup_token` to "That setup token doesn’t match. Copy it again from the server log."
  - Extract the existing one-time recovery-key panel from `RegisterFlow.tsx` into `web/src/components/RecoveryKeyPanel.tsx` (props `{ recoveryKey: string; onDone: () => void; doneLabel: string }`) and reuse it.
  - `SettingsPage.tsx`: section "Recovery key" with copy "Lost it, or used it to reset your password? Make a new one. The old key stops working immediately.", a password field and button "Make a new recovery key"; on success show `RecoveryKeyPanel`. Wrong password (CryptoError unwrap or 403) → "That password isn’t right."
  - `RecoverPage.tsx`: after a successful reset, immediately call `rotateRecoveryKey(newPassword)` and show `RecoveryKeyPanel` with heading "Your old recovery key has been replaced"; replace the notice "Your recovery key still works" with this flow.

- [ ] **Step 5: Run** `npm test -w web` and `npm run build -w web` → PASS.

- [ ] **Step 6: Commit (only if approved)** — `git commit -m "fix(web): lock signs out, epoch guards, own-stamp conflicts, size check, recovery key rotation, setup token"`

---

### Task 7: No silent loss of edits — ciphertext pending-save queue (I4)

**Files:**
- Create: `web/src/state/pending.ts`
- Modify: `web/src/state/store.ts` (own the queue, retry on unlock / `online` / every 30 s, banner state), `web/src/pages/useNoteEditor.ts` (flush rework), `web/src/components/AppShell.tsx` (banner)
- Test: `web/src/state/pending.test.ts` (create), `web/src/state/store.test.ts` (extend)

**Interfaces:**
- Produces (`pending.ts`):

```ts
export interface PendingSave {
  noteId: string;
  vaultId: string;
  encBody: string;            // ciphertext for this note's own slot
  baseUpdatedAt?: string;
  copy: { id: string; folderId: string | null; encMeta: string; encBody: string }; // pre-encrypted "(unsaved copy)" note
  attempts: number;
}
export type PendingOutcome = 'saved' | 'copied' | 'retry';
export async function sendPending(p: PendingSave, io: {
  updateNote: (id: string, b: { encBody: string; baseUpdatedAt?: string }) => Promise<unknown>;
  createNote: (vaultId: string, b: { id: string; folderId: string | null; encMeta: string; encBody: string }) => Promise<unknown>;
}): Promise<PendingOutcome>;
```

  `sendPending`: try `updateNote`; success → `'saved'`. `ApiError` 409 → `createNote(copy)` → `'copied'` (if that also fails with a non-409 → `'retry'`; with 409 `exists` → `'copied'`, already created). 404 (note deleted elsewhere) → `createNote(copy)` → `'copied'`. Network / 5xx / 401 → `'retry'`.
- Produces (store): `store.stashUnsaved(vaultId: string, noteId: string, body: string, baseUpdatedAt?: string): Promise<void>` — encrypts `body` for the note slot AND for a fresh copy id (title `"<original title> (unsaved copy)"`, same folder) while keys are present, enqueues, then calls `retryPending()`. `store.retryPending(): Promise<void>` sends each item with `sendPending` (no keys needed — all ciphertext), removes `'saved'`/`'copied'` items, sets `notice` "Saved your changes as “X (unsaved copy)” because the note changed elsewhere." for copies, keeps `'retry'` items. State gains `pendingCount: number`. Retries run after `enterUnlocked`, on `window` `online`, and every 30 s while `pendingCount > 0`. The queue survives lock (it is ciphertext) but not a page reload (memory only; the `beforeunload` prompt covers that).
- Flusher contract changes: `registerFlusher(fn: (final: boolean) => Promise<void>)`. `lock()` calls flushers with `final = true`.

- [ ] **Step 1: Failing tests**

`pending.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { sendPending, type PendingSave } from './pending';

const item = (): PendingSave => ({
  noteId: 'n1', vaultId: 'v1', encBody: 'v1.body', baseUpdatedAt: 't1',
  copy: { id: 'c1', folderId: null, encMeta: 'v1.meta', encBody: 'v1.copybody' }, attempts: 0,
});

describe('sendPending', () => {
  it('saves normally', async () => {
    const io = { updateNote: vi.fn().mockResolvedValue({}), createNote: vi.fn() };
    expect(await sendPending(item(), io)).toBe('saved');
    expect(io.createNote).not.toHaveBeenCalled();
  });
  it('turns a conflict into a copy note instead of losing text', async () => {
    const io = { updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')), createNote: vi.fn().mockResolvedValue({}) };
    expect(await sendPending(item(), io)).toBe('copied');
    expect(io.createNote).toHaveBeenCalledWith('v1', item().copy);
  });
  it('copies when the note was deleted elsewhere', async () => {
    const io = { updateNote: vi.fn().mockRejectedValue(new ApiError(404, 'not_found')), createNote: vi.fn().mockResolvedValue({}) };
    expect(await sendPending(item(), io)).toBe('copied');
  });
  it('keeps the item on network errors', async () => {
    const io = { updateNote: vi.fn().mockRejectedValue(new ApiError(0, 'network')), createNote: vi.fn() };
    expect(await sendPending(item(), io)).toBe('retry');
  });
  it('treats an already-created copy as done', async () => {
    const io = { updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')), createNote: vi.fn().mockRejectedValue(new ApiError(409, 'exists')) };
    expect(await sendPending(item(), io)).toBe('copied');
  });
});
```

`store.test.ts` (append):

```ts
  it('lock while offline keeps the edit as ciphertext and syncs after unlock (I4)', async () => {
    const s = await registeredStore();
    const vaultId = Object.keys(s.getState().vaults)[0];
    const noteId = crypto.randomUUID();
    api.updateNote.mockRejectedValueOnce(new ApiError(0, 'network'));
    await s.stashUnsaved(vaultId, noteId, 'my offline text', 't0');
    expect(s.getState().pendingCount).toBe(1);
    api.logout.mockResolvedValue({ ok: true });
    await s.lock();
    expect(s.getState().pendingCount).toBe(1);
    api.updateNote.mockResolvedValue({ note: { updatedAt: 't1' } });
    await s.retryPending();
    expect(s.getState().pendingCount).toBe(0);
    const sent = api.updateNote.mock.calls.at(-1)!;
    expect(sent[0]).toBe(noteId);
    expect(sent[1].encBody).toMatch(/^v1\./);
    expect(sent[1].encBody).not.toContain('offline');
  });
```

(Import `ApiError` from `../api/client` in the test; the `vi.mock` above keeps the real `ApiError`.)

- [ ] **Step 2: Run** `npm test -w web -- pending store` → FAIL.

- [ ] **Step 3: Implement `pending.ts`**

```ts
import { ApiError } from '../api/client';

export interface PendingSave { /* as in Interfaces */ }
export type PendingOutcome = 'saved' | 'copied' | 'retry';

const transient = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status === 401 || e.status >= 500;

export async function sendPending(p: PendingSave, io: {
  updateNote: (id: string, b: { encBody: string; baseUpdatedAt?: string }) => Promise<unknown>;
  createNote: (vaultId: string, b: PendingSave['copy']) => Promise<unknown>;
}): Promise<PendingOutcome> {
  try {
    await io.updateNote(p.noteId, { encBody: p.encBody, baseUpdatedAt: p.baseUpdatedAt });
    return 'saved';
  } catch (e) {
    if (transient(e)) return 'retry';
    if (!(e instanceof ApiError) || (e.status !== 409 && e.status !== 404)) return 'retry';
  }
  try {
    await io.createNote(p.vaultId, p.copy);
    return 'copied';
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) return 'copied';
    return 'retry';
  }
}
```

- [ ] **Step 4: Implement store queue** (`store.ts`)

```ts
  private pending: PendingSave[] = [];
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  async stashUnsaved(vaultId: string, noteId: string, body: string, baseUpdatedAt?: string): Promise<void> {
    const key = this.vaultKey(vaultId);
    const head = this.state.trees[vaultId]?.notes[noteId];
    const copyId = uuid();
    const copyTitle = `${head?.title || 'Untitled'} (unsaved copy)`;
    this.pending = this.pending.filter((p) => p.noteId !== noteId); // newest text wins
    this.pending.push({
      noteId, vaultId, baseUpdatedAt, attempts: 0,
      encBody: await encryptNoteBody(key, vaultId, noteId, body),
      copy: {
        id: copyId,
        folderId: head?.folderId ?? null,
        encMeta: await encryptNoteMeta(key, vaultId, copyId, { title: copyTitle }),
        encBody: await encryptNoteBody(key, vaultId, copyId, body),
      },
    });
    this.set({ pendingCount: this.pending.length });
    this.ensureRetryLoop();
    await this.retryPending();
  }

  async retryPending(): Promise<void> {
    if (this.retrying) return;
    this.retrying = true;
    try {
      const keep: PendingSave[] = [];
      let copied = 0;
      for (const p of this.pending) {
        const out = await sendPending(p, { updateNote: api.updateNote, createNote: api.createNote });
        if (out === 'retry') keep.push({ ...p, attempts: p.attempts + 1 });
        if (out === 'copied') copied++;
      }
      this.pending = keep;
      this.set({ pendingCount: keep.length, ...(copied ? { notice: copied === 1
        ? 'A note changed elsewhere while you were editing, so your version was saved as an “(unsaved copy)” note next to it.'
        : `${copied} notes changed elsewhere; your versions were saved as “(unsaved copy)” notes.` } : {}) });
      if (copied && this.state.phase === 'unlocked') void this.loadAll();
    } finally {
      this.retrying = false;
    }
  }

  private ensureRetryLoop() {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      if (!this.pending.length) { clearInterval(this.retryTimer!); this.retryTimer = null; return; }
      void this.retryPending();
    }, 30_000);
  }
```

Add `private retrying = false;`, add `pendingCount: 0` to the initial state (not to `EMPTY_DATA`, so it survives lock), call `void this.retryPending()` at the end of `enterUnlocked`, and in the constructor `window.addEventListener('online', () => void this.retryPending())`.

`flushAll` becomes:

```ts
  private async flushAll(final = false): Promise<void> {
    if (!this.flushers.size) return;
    await Promise.allSettled([...this.flushers].map((f) => f(final)));
  }
```

and `lock()`/`signOut()` call `this.flushAll(true)`. (No 4 s race: each flusher bounds its own wait, below.)

- [ ] **Step 5: Rework the editor flush** (`useNoteEditor.ts`)

Replace the flusher registration and the cleanup's `doSaveFor` with one function that never drops text:

```ts
    /** Saves if possible; anything that can't be saved now goes to the ciphertext queue. */
    async function settle(state: typeof s, final: boolean): Promise<void> {
      window.clearTimeout(state.timer);
      if (state.inFlight) await Promise.race([state.inFlight, sleep(final ? 4000 : 0)]);
      if (state.body === state.savedBody) return;
      if (!state.conflict) {
        try {
          const save = store.saveNoteBody(state.vaultId, state.noteId, state.body, state.base);
          const head = await (final ? Promise.race([save, sleep(4000).then(() => { throw new Error('timeout'); })]) : save);
          state.base = (head as NoteView).updatedAt;
          state.savedBody = state.body;
          return;
        } catch (e) {
          if (e instanceof LockedError) return; // keys already gone: nothing we can encrypt with
        }
      }
      await store.stashUnsaved(state.vaultId, state.noteId, state.body, state.base);
      state.savedBody = state.body; // now owned by the queue
    }
    const unregister = store.registerFlusher((final) => settle(s, final));
    return () => {
      cancelled = true;
      unregister();
      s.alive = false;
      void settle(s, false);
    };
```

with `const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));` at module level. Because `lock()` runs flushers before `dropKeys()`, `stashUnsaved` still has the vault key. On note switch the cleanup runs while unlocked, so conflicts and failed saves are stashed (conflicts become copies via the queue).

- [ ] **Step 6: Banner** — in `AppShell.tsx`, when `pendingCount > 0` show a slim bar above the main content: "{n} change(s) waiting to sync. Inked will keep trying." with a "Try now" button calling `store.retryPending()`. Style: background `#2B2029`, text `#E9C9CF`, 12.5px, 32px tall.

- [ ] **Step 7: Run** `npm test -w web`, `npm run build -w web` → PASS.

- [ ] **Step 8: Commit (only if approved)** — `git commit -m "fix(web): never drop edits — ciphertext pending-save queue with conflict copies"`

---

### Task 8: Drop `'unsafe-inline'` from `style-src` if the app runs clean (M11)

**Files:**
- Modify: `server/src/app.ts` (`SECURITY_HEADERS`), `server/test/http.test.ts`, `docs/architecture.md`

- [ ] **Step 1: Update the header test** in `http.test.ts` to expect `style-src 'self';` (no `'unsafe-inline'`). Run → FAIL.
- [ ] **Step 2: Change the CSP string** in `SECURITY_HEADERS` to `style-src 'self'`. Run server tests → PASS.
- [ ] **Step 3: Browser check** — `npm run build`, start the built server on a free port with a temp `DATA_DIR`, open it in the browser, exercise setup, note edit/view, settings, the vault icon (SVG masks), the tree menu and the mobile drawer. Read console messages filtered to `Content Security Policy` / `style-src`.
  - If there are zero violations: keep the change.
  - If there are violations from React `style` props set via `setAttribute` paths or from a library: revert to `'unsafe-inline'`, note the offending source in `docs/architecture.md` under "Security headers", and keep the test expecting `'unsafe-inline'`.
- [ ] **Step 4: Commit (only if approved)** — `git commit -m "fix(server): tighten CSP style-src"`

---

### Task 9: Docs — spec and threat model match reality

**Files:**
- Modify: `docs/architecture.md`, `compose.yaml` (comment block at top)

- [ ] **Step 1: Update `docs/architecture.md`**
  - Threat model: add explicit residual risks — (a) a malicious server can roll back or replay an older ciphertext in the same slot and can see/alter folder membership, `parentId`, timestamps and deletions (AAD binds slot, not version/structure); (b) changing the password re-wraps the userKey but does not re-key data, so an old backup plus the old password still decrypts; (c) enhanced browser spell-check can send text off-device, hence default off.
  - Auth: lockout counts attempts before verification; per-account cap 30 / 15 min → 15 min; `TRUST_PROXY` semantics; one-time setup token.
  - API: `/api/setup` requires `setupToken`; new `POST /api/auth/recovery-key`; 413 `too_large` for oversized `encBody`; KDF bounds `65536 ≤ m ≤ 1048576, 3 ≤ t ≤ 16, 1 ≤ p ≤ 8`.
  - Web: lock = server logout + remembered username; pending-save queue (ciphertext only, memory only, copies on conflict); secure-context requirement.
- [ ] **Step 2: `compose.yaml`** top comment: "First run: open http://localhost:${INKED_PORT:-8088}, then copy the setup token from `docker compose logs inked`. Browsers only allow encryption over HTTPS or localhost; to use Inked from other devices put it behind an HTTPS reverse proxy and set COOKIE_SECURE and TRUST_PROXY."
- [ ] **Step 3: Commit (only if approved)** — `git commit -m "docs: update spec and threat model after review"`

---

### Task 10: Full verification and Docker run

- [ ] **Step 1:** `npm test` → server and web all PASS (record counts).
- [ ] **Step 2:** `npm run build` → exit 0.
- [ ] **Step 3:** `docker compose down`, delete `./data` (throwaway test data only), `docker compose up -d --build`, wait for `healthy`.
- [ ] **Step 4:** `docker compose logs inked` shows the setup token line; setup in the browser with it; create a note with a canary string; lock (expect sign-in screen with username remembered); unlock; search; settings → make new recovery key.
- [ ] **Step 5:** Grep `data/inked.db*` for the canary strings → 0 matches. Check the logs don't contain the setup token after first setup except the boot line, and no `/join/<token>` paths.
- [ ] **Step 6:** Simulate offline: in the browser, stop the container (`docker compose stop`), type in a note, click Lock → expect the "waiting to sync" behaviour (pending count) without data loss; `docker compose start`, unlock → note text present after reload.
- [ ] **Step 7:** Request the final whole-branch review (superpowers:requesting-code-review) with this plan as requirements.
