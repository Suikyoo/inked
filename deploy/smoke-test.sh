#!/usr/bin/env bash
# Smoke test for the nginx-fronted Inked stack (see docs/deploy.md, "Local test").
set -euo pipefail
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
