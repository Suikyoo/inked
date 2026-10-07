#!/usr/bin/env bash
# Smoke test for the nginx-fronted Inked stack (see docs/deploy.md, "Local test").
#   INKED_PORT    port nginx is published on locally (default 8088)
#   COMPOSE_ARGS  docker compose arguments naming the stack, used to read its logs
#                 (default "-p inked-test -f compose.yaml -f compose.local.yaml"; paths are relative to the repo root)
set -Eeuo pipefail
trap 'rc=$?; echo "FAIL: line $LINENO: command exited $rc (curl transport error or docker failure)" >&2; exit $rc' ERR
cd "$(dirname "$0")/.."
BASE="http://127.0.0.1:${INKED_PORT:-8088}"
COMPOSE_ARGS="${COMPOSE_ARGS:--p inked-test -f compose.yaml -f compose.local.yaml}"
SECRET=SMOKE-SECRET-TOKEN-123
fail() { echo "FAIL: $*" >&2; exit 1; }
# 1. Through nginx: app answers, Inked's CSP and nginx HSTS present
h=$(curl -sS -D - -o /dev/null "$BASE/api/status")
echo "$h" | grep -qi '^content-security-policy: default-src' || fail "CSP missing"
echo "$h" | grep -qi '^strict-transport-security: max-age=31536000' || fail "HSTS missing"
# 2. nginx health
[ "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/healthz")" = 200 ] || fail "healthz"
# 3. Lockout keys on CF-Connecting-IP, not on client X-Forwarded-For
login() { curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" \
  -H 'content-type: application/json' -H 'x-inked: 1' "$@" \
  -d '{"username":"smoke-nobody","authKey":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}'; }
for i in 1 2 3 4 5; do login -H 'CF-Connecting-IP: 203.0.113.10' >/dev/null; done
[ "$(login -H 'CF-Connecting-IP: 203.0.113.10')" = 429 ] || fail "IP A not locked"
[ "$(login -H 'CF-Connecting-IP: 203.0.113.11')" = 401 ] || fail "IP B wrongly locked"
# 4. Client-forged X-Forwarded-For alone cannot pick the keyed IP
[ "$(login -H 'X-Forwarded-For: 203.0.113.10')" != 429 ] || fail "XFF trusted from client"
# 5. Body limit enforced by nginx itself: its HTML 413 page, not Inked's JSON
big=$(head -c 6000000 /dev/zero | tr '\0' 'a')
resp=$(printf '{"x":"%s"}' "$big" | curl -sS -w '\n%{http_code}' -X POST "$BASE/api/setup" \
  -H 'content-type: application/json' -H 'x-inked: 1' --data-binary @-)
code=${resp##*$'\n'}
body=${resp%$'\n'*}
[ "$code" = 413 ] || fail "no 413 (got $code)"
case "$body" in *'"error":"too_large"'*) fail "413 came from Inked, not nginx" ;; esac
case "$body" in *413*nginx*) ;; *) fail "413 body is not nginx's page" ;; esac
# 6. Secrets in URLs stay out of the container logs (nginx access log off, Inked redacts /join)
[ "$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/join/$SECRET")" = 200 ] || fail "join page"
sleep 1 # let the log lines reach Docker
nginx_logs=$(docker compose $COMPOSE_ARGS logs nginx 2>&1)
inked_logs=$(docker compose $COMPOSE_ARGS logs inked 2>&1)
grep -qF '/join/[redacted]' <<<"$inked_logs" || fail "inked did not log the join request (wrong COMPOSE_ARGS?)"
! grep -qF "$SECRET" <<<"$nginx_logs" || fail "nginx logs contain the invite token"
! grep -qF "$SECRET" <<<"$inked_logs" || fail "inked logs contain the invite token"
# 7. Test nginx must not be on cloudflared-net (older Compose may ignore !override)
nginx_id=$(docker compose $COMPOSE_ARGS ps -q nginx)
[ -n "$nginx_id" ] || fail "test nginx container not found (wrong COMPOSE_ARGS?)"
nets=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$nginx_id")
case " $nets " in *" cloudflared-net "*) fail "test nginx is on cloudflared-net (Compose older than v2.24.4?)" ;; esac
echo "smoke OK"
