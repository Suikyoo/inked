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

Set `CLOUDFLARED_NET_CIDR` in `.env` to the subnet of `cloudflared-net`. nginx trusts the `CF-Connecting-IP` header only from this subnet:

```bash
docker network inspect cloudflared-net --format '{{(index .IPAM.Config 0).Subnet}}'
```

On Linux, make the data directory writable by the container user (uid 1000):

```bash
mkdir -p data && sudo chown 1000:1000 data
```

## 3. Cloudflare dashboard

In the tunnel's configuration, add a Public hostname, for example `notes.example.com`, with Service type `HTTP` and URL `inked-nginx:80`.

## 4. Start

```bash
docker compose up -d --build
```

## 5. First run

```bash
docker compose logs inked
```

Copy the first-run setup token, open the hostname, and create the admin account.

## 6. Backups

`./data` holds only ciphertext and hashes. The SQLite database runs in WAL mode, so for a consistent copy either stop the container first (`docker compose stop inked`) or use `sqlite3 <db> ".backup <file>"`.

## 7. Accepted risk

Any container placed on `cloudflared-net` can reach nginx and could forge `CF-Connecting-IP`, which would let it choose the IP that login lockouts are keyed on. Only trusted containers belong on that network. The per-account lockout cap still applies.

## Local test

```bash
docker network create cloudflared-net   # once
docker compose -f compose.yaml -f compose.local.yaml up -d --build
bash deploy/smoke-test.sh
```

The override publishes nginx on `127.0.0.1:${INKED_PORT:-8088}` and turns off `Secure` cookies so plain HTTP works.
