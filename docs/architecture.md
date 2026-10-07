# Inked — architecture (round 1: core)

Inked is a self-hosted, multi-user Markdown notes app. Notes are encrypted in the browser, so the server stores only ciphertext. Round 1 covers: setup, invites, login, recovery, vaults, folders, notes, Markdown edit/view, fuzzy search, and Docker Compose. Round 2 adds the concept map (`docs/superpowers/specs/2026-10-07-concept-map-design.md`).

## Layout

```
/compose.yaml            `inked` (private network only) + `nginx` (joins external `cloudflared-net`); see `docs/deploy.md`
/Dockerfile              multi-stage: build web, build server, run on node:22-alpine
/package.json            npm workspaces: core, server, web, mcp
/core                    shared, platform-neutral TypeScript: crypto, search, Index rules, API DTO types (used by web and mcp)
/server                  Fastify API + static hosting of web/dist, node:sqlite storage
/web                     React + Vite + TypeScript SPA; all crypto runs here (from /core)
/mcp                     local MCP server `inked-mcp` (stdio) + Claude Code plugin; see docs/mcp.md
/docs                    this file
```

Runtime: Node 22 (uses the built-in `node:sqlite`; no native modules). The server listens on `PORT` (default 8080) and serves the SPA from `WEB_DIST` (default `../web/dist`, in the container `/app/web/dist`). Data lives in `DATA_DIR` (default `./data`, container `/data`): `inked.db` plus `server-secret` (32 random bytes, created on first boot, mode 0600).

## Threat model in one paragraph

A stolen database, disk or backup must reveal no note content, titles, folder names or vault names. The server never receives the password or any key that can decrypt. What the server can see: usernames, the number and size of vaults, folders and notes, the folder tree shape (parent ids), and timestamps. The residual risk is malicious JavaScript, served by a compromised live server or injected by whatever terminates TLS in front of it (Cloudflare in the documented deployment, see below); we reduce it with a strict CSP (`style-src 'self'`, no `'unsafe-inline'`), self-hosted assets and no third-party scripts.

Residual risks we accept and state plainly:

- **Rollback, replay and structure.** AAD binds a ciphertext to its slot, not to a version or to the structure. A malicious server can serve an older ciphertext for the same slot (rollback or replay), and can see or alter folder membership, `parentId`, timestamps and deletions. It cannot read or forge content for a slot.
- **Password change does not re-key data.** Changing the password re-wraps `userKey` but does not re-key vaults or notes. Anyone holding an old backup plus the old password can still decrypt data from that backup.
- **Cloudflare in the TLS and JavaScript path.** In the documented deployment (`docs/deploy.md`) Cloudflare terminates TLS. It sees request URLs (invite tokens, usernames), `authKey`, cookies and ciphertext, but never the password, any key that can decrypt, or plaintext. It also serves the JavaScript, so it could inject or rewrite it, which is the malicious-JavaScript risk above. Its HTML/JS rewriting features (Rocket Loader, Email Address Obfuscation, injected Web Analytics/Zaraz, Automatic HTTPS Rewrites) should be off; the CSP would block what they inject anyway, which can break pages.
- **Login blocking for new devices.** The per-account login cap (30 attempts per 15 min) still applies to devices that have never signed in to the account, so a determined attacker who knows a username can keep blocking logins and recovery from new devices. Known devices (those holding a valid `inked_device` cookie for the account) are exempt and can still sign in.
- **Enhanced browser spell-check.** Some browsers send text to a remote service for enhanced spell-check, which would take plaintext off-device. Spell-check is therefore off by default for every field that holds note content or names (note body and title, folder, vault and note names in dialogs, inline renames and Settings), with one toggle in Settings; fields that hold credentials or search queries never spell-check.
- **Local MCP credential.** If you use the optional local MCP server (`docs/mcp.md`), `~/.inked-mcp/credential.json` holds the `masterSecret`, which is account-equivalent for reading and writing data: any program running as you can use it. It cannot reveal the password, and it dies on a password change (the KDF salt changes and other sessions are deleted), so revocation is changing the password. The provisioned-actions policy guards the AI, not the host: malware could read the credential directly. The MCP holds `userKey`, so the vault allowlist is enforced only inside the MCP process. The server cannot tell the MCP from a browser, so the audit log is local only. Anything the MCP returns to the AI client goes to that client's model provider.

## Key hierarchy (browser)

```
password
  └─ Argon2id(password, kdfSalt, m=65536 KiB, t=3, p=1, 32 bytes) = masterSecret
       ├─ HKDF-SHA256(masterSecret, salt=empty, info="inked/auth/v1", 32 bytes)  = authKey   -> sent to server (base64url)
       └─ HKDF-SHA256(masterSecret, salt=empty, info="inked/wrap/v1")             = passwordKEK (AES-GCM-256, non-extractable, usages wrapKey/unwrapKey)

userKey      random AES-GCM-256, generated at signup. Wraps vault keys.
             stored server-side twice: wrappedUserKey (by passwordKEK) and wrappedUserKeyRecovery (by recoveryKEK)

recoveryKey  32 random bytes shown once at signup as a string "inked-rk1-" + base32 (no padding, grouped in 4s with "-")
  ├─ HKDF(recoveryKey, info="inked/recovery-auth/v1") = recoveryAuth -> server stores scrypt hash
  └─ HKDF(recoveryKey, info="inked/recovery-wrap/v1") = recoveryKEK

vaultKey     random AES-GCM-256 per vault, stored server-side as wrappedKey (by userKey)
             encrypts the vault's meta, every folder's meta, every note's meta and body
```

After unwrapping, keys are held as non-extractable `CryptoKey` objects in memory only (never localStorage/sessionStorage/IndexedDB). Locking (button, logout, 15 min idle) drops them.

Argon2id parameter bounds are `65536 <= m <= 1048576`, `3 <= t <= 16`, `1 <= p <= 8`, enforced by the server wherever `kdfParams` is accepted and by the client, which refuses to derive from parameters below its floor `MIN_KDF_PARAMS` (`{m: 65536, t: 3, p: 1}`).

Changing the password only re-wraps `userKey` (data is not re-keyed; see the threat model). Recovery: user enters the recovery key, proves `recoveryAuth`, gets `wrappedUserKeyRecovery`, unwraps `userKey`, sets a new password (new kdfSalt, authKey, wrappedUserKey). The recovery key can be rotated while signed in (Settings, "Make a new recovery key"): the client makes a new recovery key and re-wraps `userKey` under it without sending anything, shows the key, and only after the user confirms they saved it sends its `recoveryAuth` plus the re-wrapped `userKey`; then the old recovery key stops working. If that request is refused (4xx) the old key still works; after a network error or 5xx the outcome is unknown, so the user is told to keep both keys and try again. It is offered automatically right after a password reset.

## Ciphertext format

All encrypted fields are strings: `"v1." + base64url(iv[12] || ciphertext||tag)`, AES-256-GCM, fresh random 96-bit IV per encryption. Additional authenticated data (AAD) binds ciphertext to its slot, so rows cannot be swapped:

| field | key | AAD (UTF-8) | plaintext (JSON unless noted) |
|---|---|---|---|
| user.wrappedUserKey | passwordKEK | `inked/userkey/{userId}` | raw 32-byte key (WebCrypto wrapKey "raw") |
| user.wrappedUserKeyRecovery | recoveryKEK | `inked/userkey-recovery/{userId}` | raw key |
| vault.wrappedKey | userKey | `inked/vaultkey/{vaultId}` | raw key |
| vault.encMeta | vaultKey | `inked/vault/{vaultId}` | `{"name":string,"color":"#RRGGBB"}` |
| folder.encMeta | vaultKey | `inked/folder/{vaultId}/{folderId}` | `{"name":string}` |
| note.encMeta | vaultKey | `inked/note-meta/{vaultId}/{noteId}` | `{"title":string}` |
| note.encBody | vaultKey | `inked/note-body/{vaultId}/{noteId}` | UTF-8 Markdown (not JSON) |

IDs (users, vaults, folders, notes) are UUIDv4 strings. Vault/folder/note IDs are generated by the client so the AAD can be computed before upload.

## Server-side auth

- `authHash = scrypt(authKey, perUserServerSalt, N=16384, r=8, p=1, 32 bytes)`; compare with `timingSafeEqual`. Same for `recoveryAuthHash`.
- Sessions: 32 random bytes, sent as cookie `inked_session` (HttpOnly, SameSite=Strict, Path=/, Secure when `COOKIE_SECURE=true`). DB stores SHA-256 of the token. Lifetime 7 days sliding; logout deletes.
- CSRF: SameSite=Strict plus every non-GET request must carry header `X-Inked: 1` (else 403).
- Account binding: all tabs of a browser share the session cookie, so a tab can hold one account's keys and queued ciphertext while another tab has signed in as someone else. Every data request (vaults, folders, notes, invites) carries `X-Inked-User: <userId>`; queued saves carry the id of the item's owner. When the header is present and differs from the session's user, the server answers 409 `user_mismatch` before any lookup (`requireUser` in `server/src/context.ts`). A missing header is allowed (older clients), and the auth routes (`/api/me`, `/api/auth/password`, `/api/auth/recovery-key`) ignore it. The client (`web/src/api/client.ts`) treats `user_mismatch` as transient for queued items, which stay queued for a later pass. On any other request it ends this tab's session (flush, drop keys, no logout, since the cookie now belongs to the other account) with the notice "You signed in as someone else in another tab. Sign in again here."
- Lockout (in memory) counts an attempt before the secret is verified, so parallel bursts cannot outrun it; success resets the counters. Login and recovery (`/recover/start`, `/recover/finish`) use two limiters. Per (IP, username): 5 attempts in 15 min → 60 s lock. Per account, independent of IP: 30 attempts in 15 min → 15 min lock. `retryAfter` is checked on both before either records an attempt, so a request one limiter rejects spends none of the other's budget. A locked request (including on `/api/auth/password` and `/api/auth/recovery-key`) gets 429 `{error:"locked", retryAfter}` and a `Retry-After` header. Known devices skip the per-account limiter (they neither consult nor count against it) but keep the per-(IP, username) one; the cap therefore still applies to new devices, so a determined attacker can block logins from new devices (see the threat model). Password change and recovery-key rotation count attempts before verifying too, against a per-(IP, user) limiter with the 5 / 15 min → 60 s rule.
- Device cookie: every successful password login, password change, `/recover/finish`, `/api/setup` and `/api/auth/register` sets `inked_device` = base64url(userId) + "." + base64url(HMAC-SHA256(serverSecret, "device:" + userId + ":" + auth_salt)) (HttpOnly, SameSite=Strict, Path=/api/auth, Max-Age 180 days, Secure when `COOKIE_SECURE=true`). Logout does not clear it. Because the HMAC binds the user's `auth_salt`, a password change or a recovery (both issue a new salt) revokes every earlier device cookie; the device that made the change gets a fresh one, so it stays known. The login/recovery check looks the user up first, verifies the tag in constant time (the same work whether or not the user exists), and treats the request as a known device only when the tag is valid and its user id matches the looked-up user.
- `TRUST_PROXY` (how the server learns the client IP, which lockouts key on): unset, empty, `false`, `0`, `no` or `off` trusts no proxy. A number N trusts N hops; it is implemented as a trust function because Fastify 5 treats a raw number as "trust nothing". `true`, `yes` and `on` all mean 1 hop (never "trust every hop"). Anything else is a comma-separated list of IPs/CIDRs, validated with `isIP` plus the prefix range (invalid values fail startup). A hop count is only safe when the container is reachable solely through the proxy; otherwise give the proxy's IP or CIDR.
- First-run setup token: when there are no users, the server generates a token in memory, logs it at warn level as `Inked first-run setup token: …` and also writes that line straight to stderr, so it shows even with `LOG_LEVEL=silent`. `/api/setup` requires it as `setupToken` (8–128 chars). It is cleared once setup succeeds.
- Registration checks the invite before hashing the password and re-checks it inside the transaction that consumes it.
- Request logs strip query strings and redact `/join/<token>`.
- Username enumeration: `GET /api/auth/params` for an unknown user returns a fake but stable salt = HMAC-SHA256(serverSecret, "salt:" + username) and default params.
- Usernames: 3–32 chars, `[a-z0-9_.-]`, lowercased.

## HTTP API

JSON in/out. Errors: `{ "error": "<code>", "message"?: string }` with 4xx. All `/api/*` except setup/params/login/register/recover require a session.

### Setup and auth

| method | path | body | response |
|---|---|---|---|
| GET | /api/status | – | `{ needsSetup: boolean }` |
| POST | /api/setup | RegisterBody (no inviteToken) plus `setupToken` | only when zero users; creates admin; sets cookie; `{ user }`. 409 `already_setup` is checked first, then a wrong token gets 403 `invalid_setup_token` |
| GET | /api/auth/params?username= | – | `{ kdfSalt, kdfParams }` |
| POST | /api/auth/login | `{ username, authKey }` | sets the session and device cookies; `{ user, wrappedUserKey }` |
| POST | /api/auth/logout | – | `{ ok: true }` |
| GET | /api/me | – | `{ user, wrappedUserKey }` (used after reload; browser must still re-enter password to unlock) |
| POST | /api/auth/register | RegisterBody with `inviteToken` | consumes invite; sets cookie; `{ user }` |
| POST | /api/auth/password | `{ currentAuthKey, kdfSalt, kdfParams, authKey, wrappedUserKey }` | re-issues the device cookie; `{ ok: true }`; 429 `locked` (with `retryAfter`) when the per-(IP, user) limiter trips |
| POST | /api/auth/recovery-key | `{ currentAuthKey, recoveryAuth, wrappedUserKeyRecovery }` | needs a session and the current authKey; 403 `invalid_credentials` if wrong, 429 `locked` (with `retryAfter`) when the per-(IP, user) limiter trips, else `{ ok: true }`; the old recovery key stops working |
| POST | /api/auth/recover/start | `{ username, recoveryAuth }` | `{ userId, wrappedUserKeyRecovery }` (same 401 for unknown user or bad proof) |
| POST | /api/auth/recover/finish | `{ username, recoveryAuth, kdfSalt, kdfParams, authKey, wrappedUserKey }` | sets the session and device cookies; `{ user, wrappedUserKey }` |

`RegisterBody = { inviteToken?, userId, username, kdfSalt, kdfParams, authKey, wrappedUserKey, recoveryAuth, wrappedUserKeyRecovery }`. `userId` is client-generated (needed for AAD). `kdfParams = { alg: "argon2id", m: 65536, t: 3, p: 1 }` (bounds `65536 <= m <= 1048576`, `3 <= t <= 16`, `1 <= p <= 8`). `kdfSalt` = base64url of 16 random bytes. `user = { id, username, isAdmin }`.

### Invites (admin only)

| method | path | body | response |
|---|---|---|---|
| POST | /api/invites | `{ expiresInHours?: number }` (default 72) | `{ token, expiresAt }` (token: 24 random bytes base64url; DB stores SHA-256) |
| GET | /api/invites | – | `{ invites: [{ id, createdAt, expiresAt, usedBy?: username, usedAt? }] }` |
| DELETE | /api/invites/:id | – | `{ ok: true }` |
| GET | /api/invites/check?token= | – (no session) | `{ valid: boolean }` |

### Vaults, folders, notes (owner only; 404 for anything not owned)

| method | path | body | response |
|---|---|---|---|
| GET | /api/vaults | – | `{ vaults: [Vault] }` |
| POST | /api/vaults | `{ id, encMeta, wrappedKey }` | `{ vault: Vault }` |
| PATCH | /api/vaults/:id | `{ encMeta }` | `{ vault }` |
| DELETE | /api/vaults/:id | – | deletes vault, folders, notes |
| GET | /api/vaults/:id/tree | – | `{ folders: [Folder], notes: [NoteHead] }` |
| POST | /api/vaults/:id/folders | `{ id, parentId: string\|null, encMeta }` | `{ folder }` |
| PATCH | /api/folders/:id | `{ encMeta?, parentId? }` | `{ folder }` (reject cycles) |
| DELETE | /api/folders/:id | – | deletes folder subtree and its notes |
| POST | /api/vaults/:id/notes | `{ id, folderId: string\|null, encMeta, encBody }` | `{ note: NoteHead }` |
| GET | /api/notes/:id | – | `{ note: NoteHead & { encBody } }` |
| PUT | /api/notes/:id | `{ encMeta?, encBody?, folderId?, baseUpdatedAt? }` | `{ note: NoteHead }`; if `baseUpdatedAt` given and older than stored → 409 `{error:"conflict"}` |
| DELETE | /api/notes/:id | – | `{ ok: true }` |
| GET | /api/vaults/:id/bodies | – | `{ notes: [{ id, encBody, updatedAt }] }` (for full-text search after unlock) |

`Vault = { id, encMeta, wrappedKey, createdAt, updatedAt, noteCount, activeNoteCount7d }` (`activeNoteCount7d` = notes updated in the last 7 days; drives the vault ink-level icon).
`Folder = { id, parentId, encMeta, createdAt, updatedAt }`.
`NoteHead = { id, folderId, encMeta, size, createdAt, updatedAt }` (`size` = encBody length).
Timestamps are ISO-8601 strings. Limits: encBody ≤ 2 MB, encMeta ≤ 8 KB, request body ≤ 4 MiB (nginx allows 5 MiB, so the app's limit is the effective one). An `encBody` over the limit gets 413 `too_large`.

## Storage (SQLite)

```
users(id PK, username UNIQUE, is_admin, kdf_salt, kdf_params JSON, auth_salt, auth_hash,
      wrapped_user_key, recovery_salt, recovery_hash, wrapped_user_key_recovery, created_at)
sessions(token_hash PK, user_id, created_at, expires_at)
invites(id PK, token_hash UNIQUE, created_by, created_at, expires_at, used_by, used_at)
vaults(id PK, user_id, enc_meta, wrapped_key, created_at, updated_at)
folders(id PK, vault_id, parent_id, enc_meta, created_at, updated_at)
notes(id PK, vault_id, folder_id, enc_meta, enc_body, size, created_at, updated_at)
```

Foreign keys on, `ON DELETE CASCADE` from vaults. WAL mode.

## Security headers (all responses)

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cross-Origin-Opener-Policy: same-origin
```

## Web app

- React 18 + react-router. Routes: `/setup`, `/join/:token`, `/login`, `/recover`, `/` (home: search + results + concept map of every vault), `/v/:vaultId` (vault: tree), `/v/:vaultId/n/:noteId` (note), `/settings` (password change, invites for admin).
- Fonts self-hosted via @fontsource (Public Sans, Spectral italic, JetBrains Mono). No CDN.
- Markdown: markdown-it (CommonMark + GFM tables/strikethrough + linkify off) + task lists + `[[wiki-link]]` rule; output sanitized with DOMPurify before insertion. Links to external sites get `rel="noopener noreferrer" target="_blank"`.
- Lock (button, idle) flushes pending saves, drops all keys, remembers only the username (`localStorage['inked.lastUsername']`) and calls `/api/auth/logout`, so the session dies with the keys. A lock while offline cannot reach the server; the session cookie stays valid until it expires or the next successful logout. Keys and plaintext are dropped either way. The login page then shows "Unlocking as <name> · Not you?".
- Tabs share the session cookie, so they coordinate over `BroadcastChannel("inked")` (nothing in storage; messages carry no keys, text or names). Each tab broadcasts activity at most every 15 s, and the idle timer uses the newest activity in any tab, so a tab only idle-locks once every tab has been idle for 15 minutes. A lock broadcasts `lock`; the other tabs run their own lock (flushing their edits first) and answer when done, and the tab that started it calls logout once they have answered, or after at most 4 s. Sign-out is broadcast the same way as lock (`signout`): the peers flush, drop their keys and forget the username too. The logout request is bounded at 5 s (the keys are gone either way), and sign-in, recovery and registration wait for a pending logout (this tab's or another tab's) to finish first: after the key derivation, right before the session-starting request. A lock that arrives during that wait is applied and answered at once, so the two never wait on each other. A lock broadcast by a peer while this tab is mid-sign-in does not end the new session under it: the lock is applied once the sign-in has completed, and this tab then ends the session it just started itself, since the peer's own logout may have run before that session existed. While a lock (or sign-out, or session end) is flushing, the editor is read-only and a second lock or sign-out does nothing.
- Stale responses: a note head older than the one already stored (a late response) is dropped whole, never merged field by field, and its body is skipped too. A note load that reads such an older version reads once more, so the editor opens on the current head and body; if that read is still stale it is returned as is, and the next save takes the conflict path.
- When the server ends the session (401: a lock in another tab, a password change or recovery elsewhere), open editors are flushed while the keys are still in memory; the failed save (401 is transient) puts the text in the pending-save queue as ciphertext, and it is sent after the next sign-in. Only then are the keys dropped.
- Pending-save queue: an edit that cannot be saved yet is encrypted and held as ciphertext only, in memory only (it survives lock but not a reload). It retries after unlock, on `online` and every 30 s. Each item records its owner and is only ever sent with that account's session (never while signed out, never under another account); every request re-checks that the same user is still signed in and the session is unlocked, and a pass stops at an account switch. Each request names the owner in `X-Inked-User` and has a 30 s timeout (a timeout counts as a network error, so the item stays queued); after a queued save lands, the note's head is re-read so the tree, search and conflict base are current. A 409 whose stored body is exactly the queued ciphertext (an earlier attempt that timed out but landed) counts as saved. So does a 409 whose stored body holds the same text under another IV (a racing editor save that timed out but landed): while the vault key is in memory, both bodies are decrypted with the note-body AAD and compared in memory only, and nothing decrypted is kept; without the key, or if either body does not decrypt, only equal ciphertext counts. If the note changed elsewhere (409) or was deleted, the edit becomes an "(unsaved copy)" note; if its folder was deleted the copy goes to the vault root and the notice says so. If the vault was deleted, the server rejects the item (other 4xx) or it is too large (413), the item is dropped with a notice that names the cause (deleted, rejected or too large). Network errors, 5xx, 401, 408, 429 and `user_mismatch` are transient and leave the item queued. A conflicting edit is never silently discarded. Queue notices produced while the keys are gone (after a lock) are kept in memory per owner and shown when that account signs in again. A lock leaves items that were not sent yet in the queue for that owner's next unlock. The "N change(s) waiting to sync" count only counts the current (or last signed-in) account's items. Leaving a note waits at most 10 s, and locking at most 4 s, before the text goes to the queue. `beforeunload` prompts while anything is queued or still settling. A banner shows "N change(s) waiting to sync".
- Secure context: WebCrypto needs HTTPS or localhost. When `window.isSecureContext === false` or WebCrypto is missing, the app shows an explanatory page instead of the login form.
- Spell-check is off by default for every field holding note content or names (one toggle in Settings covers them all, stored as `localStorage['inked.spellcheck']`, a non-secret preference); see the threat model.
- localStorage holds exactly two keys: `inked.lastUsername` (the username, to prefill sign-in) and `inked.spellcheck` (the spell-check preference). Never keys, note content or names.
- Links: only root-relative Markdown links (matching `^/(?![/\\])`, so not `//host` or `/\host`) and `[[wiki-links]]` are routed in-app; other links open in a new tab as above. Only a plain left click is intercepted: modified clicks (Ctrl, Meta, Shift, Alt) and middle clicks fall through to the browser.
- Link graph: backlinks and the concept map share one graph (`web/src/map/graph.ts`), built in the browser from decrypted note bodies. It counts `[[wiki-links]]` (resolved by title; on duplicate titles the most recently edited note wins) and root-relative `/v/{vaultId}/n/{noteId}` Markdown links within the same vault. Nothing about the graph or the map is sent to the server or stored.
- Edit | View toggle; Edit is a monospace textarea; autosave 800 ms after typing stops; "Saved" indicator.
- Fuzzy search over `vault / folder path / title` across all unlocked vaults (subsequence scoring with word-start and consecutive bonuses, highlighted matches); body substring search after bodies are decrypted in the background.
- Visual system: see the design canvas and `PRODUCT.md`. Dark ground `#17161C`, sidebar `#121117`, panels `#1B1A21`/`#211F28`, text `#E6E3EE`, muted `#A29DB2`/`#8D879F`, ink `#7452E0`, ink light `#B69CFF`; 13px base, 28px rows. Vault colours `#45A89E #D19C3C #6F95D6 #D9768F` (+ user picks). Vault icon = tip-up ink drop with node hole; fill level = activeNoteCount7d / noteCount. Logo = slender nib (see `web/src/brand`).
