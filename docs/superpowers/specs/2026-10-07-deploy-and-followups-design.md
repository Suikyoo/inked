# Deployment behind cloudflared + nginx, and round-1 follow-ups — design

Date: 2026-10-07. Status: approved in conversation (section 1 and section 2). Base spec: `docs/architecture.md`.

## Intent

The owner will run Inked on a Linux server and reach it on a public hostname over HTTPS. The plan is to serve it through an existing Cloudflare Tunnel (`cloudflared`) with nginx in front of the app. Before that ships, the open follow-ups from the round-1 review fixes get closed out (`docs/superpowers/followups-2026-10-06.md`).

Success means:
- `docker compose up -d --build` on the server exposes Inked only through nginx, reachable only through `cloudflared-net`, with no host ports published.
- Login lockouts key on the real client IP taken from Cloudflare.
- Cookies are `Secure`.
- The parked and deferred follow-ups are fixed and tested.
- The full suite and build pass.

What the owner said:
- Use nginx.
- Use a public domain.
- Host on a Linux server.
- Join the exposed service to the external Docker network `cloudflared-net`.
- Use layout 1 (cloudflared → nginx → Inked).
- Do the follow-ups first.

Assumptions:
- A `cloudflared` container already exists on `cloudflared-net`, and its tunnel is configured in the Cloudflare dashboard.
- "Follow-ups" means every item still open in the follow-ups file.

## Section 1 — Deployment

### Topology

```
Internet ──HTTPS──▶ Cloudflare edge ══tunnel══▶ cloudflared  (network: cloudflared-net, external)
                                                     │  http://inked-nginx:80
                                                     ▼
                                        nginx  (networks: cloudflared-net [alias inked-nginx], inked-internal)
                                                     │  http://inked:8080
                                                     ▼
                                        inked  (network: inked-internal only; internal: true → no egress)
```

### `compose.yaml` (server/production)

- **Service `inked`**
  - `build: .`
  - **No `ports`.**
  - `volumes: ./data:/data`
  - `restart: unless-stopped`
  - `networks: [inked-internal]`
  - `environment`:
    - `COOKIE_SECURE: "true"`
    - `TRUST_PROXY: "172.31.250.0/28"`
  - Existing healthcheck (Dockerfile) unchanged.
- **Service `nginx`**
  - `image: nginx:1.27-alpine`
  - `depends_on: { inked: { condition: service_healthy } }`
  - `restart: unless-stopped`
  - **No `ports`.**
  - `networks`:
    - `inked-internal`
    - `cloudflared-net: { aliases: [inked-nginx] }`
  - `volumes: ./deploy/nginx/templates:/etc/nginx/templates:ro`. The official image runs `envsubst` on `*.template` into `/etc/nginx/conf.d/`.
  - `environment: CLOUDFLARED_NET_CIDR: ${CLOUDFLARED_NET_CIDR:-172.16.0.0/12}`
  - `healthcheck`: `wget -q -O /dev/null http://127.0.0.1/healthz` every 30 s. nginx answers `/healthz` itself with 200.
- **`networks`**
  - `inked-internal`:
    - `internal: true`
    - `ipam: { config: [{ subnet: 172.31.250.0/28 }] }`
  - `cloudflared-net`:
    - `external: true`

### `compose.local.yaml` (override for testing on a workstation)

- `nginx.ports: ["127.0.0.1:${INKED_PORT:-8088}:80"]`
- `inked.environment.COOKIE_SECURE: "false"`
- Used as `docker compose -f compose.yaml -f compose.local.yaml up -d --build`.
- Requires the network to exist once: `docker network create cloudflared-net`.

### `deploy/nginx/templates/inked.conf.template`

```nginx
server_tokens off;

# Only the tunnel network may set the client IP; everything else is the TCP peer.
real_ip_header CF-Connecting-IP;
set_real_ip_from ${CLOUDFLARED_NET_CIDR};
real_ip_recursive off;

server {
    listen 80;
    server_name _;

    client_max_body_size 5m;
    proxy_connect_timeout 5s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;

    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    add_header Strict-Transport-Security "max-age=31536000" always;

    location = /healthz { access_log off; return 200 "ok\n"; }

    location / {
        proxy_pass http://inked:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        # Replace, never append: Inked trusts exactly one hop (nginx), so it must see one value.
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Connection "";
    }
}
```

Note: `add_header` at server level combines with the security headers Inked sets, because nginx passes upstream headers through. nginx must not add a second CSP.

### `.env.example`

```
# Subnet of the external cloudflared-net network:
#   docker network inspect cloudflared-net --format '{{(index .IPAM.Config 0).Subnet}}'
CLOUDFLARED_NET_CIDR=172.16.0.0/12
# Local testing only (compose.local.yaml)
INKED_PORT=8088
```

### `docs/deploy.md`

1. Prerequisites: Docker, and a `cloudflared` container on `cloudflared-net`.
2. `cp .env.example .env`. Set `CLOUDFLARED_NET_CIDR` to the network's subnet; the inspect command is in the file.
3. In the Cloudflare dashboard, add the tunnel public hostname: `notes.example.com` → `HTTP`, `inked-nginx:80`.
4. `docker compose up -d --build`
5. `docker compose logs inked`. Copy the first-run setup token, open the hostname, and create the admin account.
6. Backups: `./data` holds only ciphertext and hashes. Note that SQLite WAL needs a stopped container or `sqlite3 .backup` for a consistent copy.
7. Accepted risk: any container placed on `cloudflared-net` can reach nginx and could forge `CF-Connecting-IP`. Only trusted containers belong on that network; the per-account cap still applies.

`docs/architecture.md` and the top of `compose.yaml` point to `docs/deploy.md`. The old direct-port comment block is replaced.

### Acceptance tests (section 1)

- `docker compose config` succeeds for `compose.yaml` and for `compose.yaml + compose.local.yaml`.
- `docker compose run --rm nginx nginx -t` (or exec in the running container) reports the config OK.
- Local stack with the override:
  - `GET /api/status` through `127.0.0.1:8088` returns 200, with Inked's CSP header plus HSTS.
  - Two different `CF-Connecting-IP` values get independent per-IP lockout counters. Five wrong logins with IP A, then a wrong login with IP B, gives 401, not 429.
  - A client-supplied `X-Forwarded-For` alone does not change the keyed IP.
  - A body over 5 MB returns 413 from nginx.
  - `inked` has no published port.

## Section 2 — Follow-ups

### A. Security

- **A1. Revocable device cookie.**
  - The HMAC input becomes `"device:" + userId + ":" + auth_salt`.
  - A password change or recovery rotates `auth_salt`, which revokes every existing device cookie.
  - `/api/setup` and `/api/auth/register` also set `inked_device`.
  - Tests:
    - the cookie stops exempting after a password change and after recovery;
    - setup and register set it.
- **A2. Sign-out reaches every tab.**
  - `signOut()` broadcasts `{type:'signout'}`.
  - Receiving tabs flush, drop keys and decrypted data, and move to `signedOut` **without** calling `rememberUsername`.
  - Tests:
    - a peer receiving `signout` flushes, then drops keys;
    - `inked.lastUsername` stays cleared.
- **A3. Fail-closed edges become clean.**
  - The logout fetch is bounded by an `AbortController` with a 5 s timeout.
  - `recover()` and `register()` await any pending logout, the same way `unlock()` already does.
  - A `lock` broadcast received while this tab's `unlock()` is in flight is remembered. Once unlock completes, the tab locks itself through the normal path, instead of the peer's logout killing the fresh session.
  - Tests cover each of the three.
- **A4.** The note title input is `readOnly` while `locking`, like the body.

### B. Correctness and wording

- **B1. Notices name the real cause.**
  - A dropped item says "deleted elsewhere" only for a 404. For 400 or 413 it says the change "was rejected by the server" or "is too large to save".
  - A copy created at the root after its folder was deleted says the folder was deleted.
  - A copy notice produced during a lock's flush is kept and shown after the next unlock.
- **B2. Queue.**
  - `pendingCount` counts only items owned by the current user, and nothing is sent unless `owner === userId`. This is already enforced; `pendingCount` must match it.
  - Queued sends and the racing save get a 30 s request timeout, so a hung request can't hold an item forever.
  - A `createNote` 409 counts as "copied" only when `code === 'exists'`. Any other 409 is retried.
  - After an item is `'saved'` while unlocked, refresh that note's head (and its body if loaded), so search and the conflict base are current.
- **B3. Stale responses.**
  - `putHead` drops a head older than the stored one, instead of merging it.
  - `loadNote` and `saveNoteBody` don't write `bodies[id]` when their head was stale.
- **B4. Links.**
  - The DOMPurify hook removes `data-internal` in every non-internal branch.
  - The NotePane click handler ignores clicks with Ctrl, Meta or Shift held, or with a middle button, so the browser opens a new tab.
  - Render tests are added for `/\evil.example` and `javascript:` hrefs.
- **B5.** `redactUrl` collapses repeated slashes and matches `/join/` case-insensitively before redacting. Tests are added for `//join/x`, `/JOIN/x`, `/join/` and `/join/abc/`.
- **B6. Small cleanups.**
  - The startup hop-count warning is logged only when `trustProxy` is numeric.
  - A setup token shorter than 8 characters gets the client message "That setup token is too short — copy the whole token from the server log."
  - Re-attach the detached `describeError` JSDoc in `util.ts`.
  - Remove the unused `error` prop of `RecoveryKeyPanel`.
  - Catch rejections in the unmount `settle(...).finally(unregister)` chain.
  - `updateVault` throws `LockedError` after a lock, consistent with `createVault`.

### C. Tests and docs

- **C1. Tests to add:**
  - the burst test asserts the `retryAfter` body field and the `Retry-After` header;
  - limiter tests for `/api/auth/password` and `/api/auth/recovery-key`;
  - a missing `X-Inked` header on `/api/auth/recovery-key` gives 403;
  - a `toFastifyTrustProxy` unit test with n = 2 and a multi-hop chain;
  - the App insecure-context gate renders the explanation page;
  - `adoptHead` ignores a foreign timestamp;
  - `useNoteEditor` unmount triggers settle, and unregisters after;
  - the `online` event, the 30 s interval and `beforeunload` behaviour of the queue.
- **C2. Docs:**
  - architecture says "root-relative links and [[wiki-links]] are routed in-app";
  - the API table lists 429 for password and recovery-key;
  - list the TRUST_PROXY aliases (`no`/`off`/`0`/`false`, `yes`/`on`/`true` → 1);
  - mark the follow-ups file as resolved, with a pointer to this spec.

## Out of scope

- The concept map (round 2).
- `DESIGN.md`.
- Canvas cleanup.
- Any change to the crypto format.
- Certificate management. Cloudflare terminates TLS.

## Constraints carried from the base spec

- The server never receives plaintext or decrypting keys.
- Ciphertext format and AAD strings are unchanged.
- Only `inked.lastUsername` may be written to localStorage.
- KDF bounds are unchanged.
- Every non-GET request carries `X-Inked: 1`.
