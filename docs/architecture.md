# Inked — architecture (round 1: core)

Inked is a self-hosted, multi-user Markdown notes app. Notes are encrypted in the browser, so the server stores only ciphertext. Round 1 covers: setup, invites, login, recovery, vaults, folders, notes, Markdown edit/view, fuzzy search, and Docker Compose. The concept map comes in round 2.

## Layout

```
/compose.yaml            one service "inked", volume ./data -> /data
/Dockerfile              multi-stage: build web, build server, run on node:22-alpine
/package.json            npm workspaces: server, web
/server                  Fastify API + static hosting of web/dist, node:sqlite storage
/web                     React + Vite + TypeScript SPA; all crypto lives here
/docs                    this file
```

Runtime: Node 22 (uses the built-in `node:sqlite`; no native modules). The server listens on `PORT` (default 8080) and serves the SPA from `WEB_DIST` (default `../web/dist`, in the container `/app/web/dist`). Data lives in `DATA_DIR` (default `./data`, container `/data`): `inked.db` plus `server-secret` (32 random bytes, created on first boot, mode 0600).

## Threat model in one paragraph

A stolen database, disk or backup must reveal no note content, titles, folder names or vault names. The server never receives the password or any key that can decrypt. What the server can see: usernames, the number and size of vaults, folders and notes, the folder tree shape (parent ids), and timestamps. The residual risk is a compromised live server serving malicious JavaScript; we reduce it with a strict CSP (`style-src 'self'`, no `'unsafe-inline'`), self-hosted assets and no third-party scripts.

Residual risks we accept and state plainly:

- **Rollback, replay and structure.** AAD binds a ciphertext to its slot, not to a version or to the structure. A malicious server can serve an older ciphertext for the same slot (rollback or replay), and can see or alter folder membership, `parentId`, timestamps and deletions. It cannot read or forge content for a slot.
- **Password change does not re-key data.** Changing the password re-wraps `userKey` but does not re-key vaults or notes. Anyone holding an old backup plus the old password can still decrypt data from that backup.
- **Enhanced browser spell-check.** Some browsers send text to a remote service for enhanced spell-check, which would take plaintext off-device. Spell-check is therefore off by default, with a toggle in Settings.

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

Changing the password only re-wraps `userKey` (data is not re-keyed; see the threat model). Recovery: user enters the recovery key, proves `recoveryAuth`, gets `wrappedUserKeyRecovery`, unwraps `userKey`, sets a new password (new kdfSalt, authKey, wrappedUserKey). The recovery key can be rotated while signed in (Settings, "Make a new recovery key"): the client makes a new recovery key and sends its `recoveryAuth` plus `userKey` re-wrapped by it, and the old recovery key stops working. It is offered automatically right after a password reset.

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
- Lockout (in memory) counts an attempt before the secret is verified, so parallel bursts cannot outrun it; success resets the counters. Login and recovery (`/recover/start`, `/recover/finish`) use two limiters. Per (IP, username): 5 attempts in 15 min → 60 s lock. Per account, independent of IP: 30 attempts in 15 min → 15 min lock. `retryAfter` is checked on both before either records an attempt, so a request one limiter rejects spends none of the other's budget. A locked request gets 429 `{error:"locked", retryAfter}` and a `Retry-After` header. Password change and recovery-key rotation count attempts before verifying too, against a per-(IP, user) limiter with the 5 / 15 min → 60 s rule.
- `TRUST_PROXY` (how the server learns the client IP, which lockouts key on): unset, `false`, `0` or `off` trusts no proxy. A number N trusts N hops; it is implemented as a trust function because Fastify 5 treats a raw number as "trust nothing". `true` means 1 hop. Anything else is a comma-separated list of IPs/CIDRs, validated with `isIP` plus the prefix range (invalid values fail startup). A hop count is only safe when the container is reachable solely through the proxy; otherwise give the proxy's IP or CIDR.
- First-run setup token: when there are no users, the server generates a token in memory and logs it at warn level as `Inked first-run setup token: …`. `/api/setup` requires it as `setupToken` (8–128 chars). It is cleared once setup succeeds.
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
| POST | /api/auth/login | `{ username, authKey }` | sets cookie; `{ user, wrappedUserKey }` |
| POST | /api/auth/logout | – | `{ ok: true }` |
| GET | /api/me | – | `{ user, wrappedUserKey }` (used after reload; browser must still re-enter password to unlock) |
| POST | /api/auth/register | RegisterBody with `inviteToken` | consumes invite; sets cookie; `{ user }` |
| POST | /api/auth/password | `{ currentAuthKey, kdfSalt, kdfParams, authKey, wrappedUserKey }` | `{ ok: true }` |
| POST | /api/auth/recovery-key | `{ currentAuthKey, recoveryAuth, wrappedUserKeyRecovery }` | needs a session and the current authKey; 403 `invalid_credentials` if wrong, else `{ ok: true }`; the old recovery key stops working |
| POST | /api/auth/recover/start | `{ username, recoveryAuth }` | `{ userId, wrappedUserKeyRecovery }` (same 401 for unknown user or bad proof) |
| POST | /api/auth/recover/finish | `{ username, recoveryAuth, kdfSalt, kdfParams, authKey, wrappedUserKey }` | sets cookie; `{ user, wrappedUserKey }` |

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
Timestamps are ISO-8601 strings. Limits: encBody ≤ 2 MB, encMeta ≤ 8 KB, request body ≤ 4 MB. An `encBody` over the limit gets 413 `too_large`.

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

- React 18 + react-router. Routes: `/setup`, `/join/:token`, `/login`, `/recover`, `/` (home: search + results + vault list; map placeholder for round 2), `/v/:vaultId` (vault: tree), `/v/:vaultId/n/:noteId` (note), `/settings` (password change, invites for admin).
- Fonts self-hosted via @fontsource (Public Sans, Spectral italic, JetBrains Mono). No CDN.
- Markdown: markdown-it (CommonMark + GFM tables/strikethrough + linkify off) + task lists + `[[wiki-link]]` rule; output sanitized with DOMPurify before insertion. Links to external sites get `rel="noopener noreferrer" target="_blank"`.
- Lock (button, idle) flushes pending saves, drops all keys, remembers only the username (`localStorage['inked.lastUsername']`) and calls `/api/auth/logout`, so the session dies with the keys. The login page then shows "Unlocking as <name> · Not you?".
- Pending-save queue: an edit that cannot be saved yet is encrypted and held as ciphertext only, in memory only (it survives lock but not a reload). It retries after unlock, on `online` and every 30 s. If the note changed elsewhere (409) or was deleted, the edit becomes an "(unsaved copy)" note; if its folder was deleted the copy goes to the vault root. If the vault was deleted or the server answers another non-transient 4xx, the item is dropped with a visible notice. A conflicting edit is never silently discarded. Leaving a note waits at most 10 s, and locking at most 4 s, before the text goes to the queue. `beforeunload` prompts while anything is queued or still settling. A banner shows "N change(s) waiting to sync".
- Secure context: WebCrypto needs HTTPS or localhost. When `window.isSecureContext === false` or WebCrypto is missing, the app shows an explanatory page instead of the login form.
- Spell-check is off by default (toggle in Settings); see the threat model.
- Same-origin Markdown links are routed in-app; other links open as above.
- Edit | View toggle; Edit is a monospace textarea; autosave 800 ms after typing stops; "Saved" indicator.
- Fuzzy search over `vault / folder path / title` across all unlocked vaults (subsequence scoring with word-start and consecutive bonuses, highlighted matches); body substring search after bodies are decrypted in the background.
- Visual system: see the design canvas and `PRODUCT.md`. Dark ground `#17161C`, sidebar `#121117`, panels `#1B1A21`/`#211F28`, text `#E6E3EE`, muted `#A29DB2`/`#8D879F`, ink `#7452E0`, ink light `#B69CFF`; 13px base, 28px rows. Vault colours `#45A89E #D19C3C #6F95D6 #D9768F` (+ user picks). Vault icon = tip-up ink drop with node hole; fill level = activeNoteCount7d / noteCount. Logo = slender nib (see `web/src/brand`).
