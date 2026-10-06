# Deploying Inked behind nginx and cloudflared

Inked runs on a Linux server and is reached on a public hostname over HTTPS. Cloudflare Tunnel terminates TLS, so nginx needs no certificates.

```
Internet --HTTPS--> Cloudflare edge ==tunnel==> cloudflared   (network: cloudflared-net, external)
                                                     |  http://inked-nginx:80
                                                     v
                                        nginx  (cloudflared-net [alias inked-nginx], inked-internal)
                                                     |  http://inked:8080
                                                     v
                                        inked  (inked-internal only; internal: true, no egress)
```

No host ports are published. Inked is reachable only through nginx, and nginx only through `cloudflared-net`.

## 1. Prerequisites

Docker with the Compose plugin, and a `cloudflared` container already running on the external network `cloudflared-net`. Create the network if it does not exist:

```bash
docker network inspect cloudflared-net >/dev/null 2>&1 || docker network create cloudflared-net
```

## 2. Configure

```bash
cp .env.example .env
```

Set `CLOUDFLARED_NET_CIDR` in `.env` to the subnet of `cloudflared-net`. nginx trusts the `CF-Connecting-IP` header only from this subnet. If the value is wrong, nginx ignores `CF-Connecting-IP` and every visitor shares the one lockout bucket of the proxy's address, so confirm the subnet with this command:

```bash
docker network inspect cloudflared-net --format '{{(index .IPAM.Config 0).Subnet}}'
```

The encrypted database lives in `INKED_DATA_DIR` (default `./data`, mounted at `/data` in the container). Set it in `.env` to keep the data elsewhere. On Linux, make that directory writable by the container user (uid 1000):

```bash
mkdir -p "${INKED_DATA_DIR:-./data}" && sudo chown 1000:1000 "${INKED_DATA_DIR:-./data}"
```

## 3. Cloudflare dashboard

In the tunnel's configuration, add a Public hostname, for example `notes.example.com`, with Service type `HTTP` and URL `inked-nginx:80`.

## 4. Start

```bash
docker compose up -d --build
```

nginx's `default.conf` is masked by `deploy/nginx/empty.conf` (mounted over it), so the nginx image's default server, which would otherwise answer first on port 80, never does. `deploy/nginx/templates/inked.conf.template` is the only server.

### Rebuilding Inked

nginx resolves the `inked` address once, at startup. After recreating the `inked` container on its own (for example `docker compose up -d --build inked`), restart nginx too, or it keeps sending traffic to the old address:

```bash
docker compose restart nginx
```

### Logging

nginx's access log is off on purpose (`access_log off;` in the template). Its default format writes the full request line, with the real client IP, to stdout, and Docker keeps that on disk. Request lines carry secrets: invite tokens (`/join/<token>`, `/api/invites/check?token=<token>`) and usernames (`/api/auth/params?username=<name>`). Inked already logs every request with the real client IP (it trusts nginx), and it strips query strings and reduces `/join/...` to `/join/[redacted]`. Read those logs with `docker compose logs inked`.

nginx's error log keeps the image default. Its entries can include the request line of the request that failed (for example when Inked is unreachable), so treat `docker compose logs nginx` as sensitive too.

### Request size

The effective request limit is the app's 4 MiB. nginx allows 5 MiB (`client_max_body_size 5m`), so nginx itself never cuts off a legitimate request; anything between the two limits reaches Inked, which answers 413.

## 5. First run

```bash
docker compose logs inked
```

Copy the first-run setup token, open the hostname, and create the admin account.

## 6. Backups

`INKED_DATA_DIR` (default `./data`) holds only ciphertext and hashes. The SQLite database runs in WAL mode, so for a consistent copy either stop the container first (`docker compose stop inked`) or use `sqlite3 <db> ".backup <file>"`.

## 7. Accepted risk

Any container placed on `cloudflared-net` can reach nginx and could forge `CF-Connecting-IP`, which would let it choose the IP that login lockouts are keyed on. Only trusted containers belong on that network. The Docker host itself can do the same: its bridge gateway address sits inside the trusted range, so a process on the host can also set `CF-Connecting-IP`. The per-account lockout cap still applies.

## Local test

```bash
docker network create cloudflared-net   # once
d=$(mktemp -d); sudo chown 1000:1000 "$d"; INKED_DATA_DIR=$d docker compose -p inked-test -f compose.yaml -f compose.local.yaml up -d --build
bash deploy/smoke-test.sh
```

The `chown` is needed on Linux only. Lockout counters live in the server's memory, so recreate the stack (`docker compose -p inked-test -f compose.yaml -f compose.local.yaml down`, then `up` again) before each smoke run; otherwise the per-account cap builds up in the long-running container. A fresh data directory is optional.

The test stack uses the same fixed `inked-internal` subnet (172.31.250.0/28) as production, so it cannot run alongside the production stack on the same host. Stop one before starting the other.

The override publishes nginx on `127.0.0.1:${INKED_PORT:-8088}` and turns off `Secure` cookies so plain HTTP works.

The smoke test also requests `/join/SMOKE-SECRET-TOKEN-123` and then fails if that token shows up in `docker compose logs nginx` or `docker compose logs inked`. It reads the logs of the stack named by `COMPOSE_ARGS` (default `-p inked-test -f compose.yaml -f compose.local.yaml`); set it if you started the stack differently.
