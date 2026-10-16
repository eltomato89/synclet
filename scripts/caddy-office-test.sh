#!/usr/bin/env bash
# Checks the office routing of deploy/Caddyfile (+ Caddyfile.office) against a stub Document
# Server: /documentserver on/off, prefix stripping and forwarded headers, the welcome/example
# block (incl. path tricks) and the subdomain mode. Needs Docker; touches only its own containers
# and network. CADDY_IMAGE selects the Caddy image (default caddy:2.11-alpine, as in the web image).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
IMAGE=${CADDY_IMAGE:-caddy:2.11-alpine}
ID=$$
NET=synclet-caddytest-$ID
UP=synclet-caddytest-up-$ID
MAIN=synclet-caddytest-main-$ID
WORK=$(mktemp -d)
cleanup() {
  docker rm -f "$MAIN" "$UP" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# The stub echoes what it received: path, forwarded host and proto.
printf ':80 {\n\trespond "up {uri} {header.X-Forwarded-Host} {header.X-Forwarded-Proto}"\n}\n' > "$WORK/up.caddy"
docker network create "$NET" >/dev/null
docker run -d --name "$UP" --network "$NET" --network-alias office -v "$WORK/up.caddy:/etc/caddy/Caddyfile:ro" "$IMAGE" >/dev/null

PORT=
start() { # env assignments for the main Caddy
  docker rm -f "$MAIN" >/dev/null 2>&1 || true
  local envs=()
  for e in "$@"; do envs+=(-e "$e"); done
  docker run -d --name "$MAIN" --network "$NET" -p 127.0.0.1::80 "${envs[@]}" \
    -v "$ROOT/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
    -v "$ROOT/deploy/Caddyfile.office:/etc/caddy/office/on/office.caddy:ro" "$IMAGE" >/dev/null
  PORT=$(docker port "$MAIN" 80/tcp | head -1 | sed 's/.*://')
  for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && return 0; sleep 0.2; done
  docker logs "$MAIN" >&2; echo "FAIL: Caddy did not start ($*)" >&2; exit 1
}
FAILS=0
check() { # <expected status> <expected body substring or -> <path> [curl args...]
  local want=$1 body=$2 p=$3; shift 3
  local out status
  out=$(curl -s --path-as-is -o "$WORK/body" -w '%{http_code}' "$@" "http://127.0.0.1:$PORT$p")
  status=$out
  if [ "$status" != "$want" ] || { [ "$body" != - ] && ! grep -qF -- "$body" "$WORK/body"; }; then
    echo "FAIL $p ($*): got $status '$(head -c 200 "$WORK/body")', want $want '$body'"; FAILS=$((FAILS + 1))
  else
    echo "ok   $p $*"
  fi
}

echo "# office off (default)"
start SYNCLET_OFFICE_ENABLED= SYNCLET_CADDY_OFFICE=
check 404 - /documentserver/healthcheck
check 404 - /documentserver

echo "# office on, /documentserver"
start SYNCLET_OFFICE_ENABLED=on
check 200 "up /healthcheck 127.0.0.1:$PORT/documentserver http" /documentserver/healthcheck
check 200 "up /healthcheck 127.0.0.1:$PORT/documentserver http" /documentserver/healthcheck -H 'X-Forwarded-Host: evil.example' -H 'X-Forwarded-Proto: https'
check 200 "up /9.3.5-abc/web-apps/apps/api/documents/api.js?x=1 " '/documentserver/9.3.5-abc/web-apps/apps/api/documents/api.js?x=1'
check 308 - /documentserver
for p in /documentserver/welcome /documentserver/welcome/ /documentserver/welcome/index.html /DocumentServer/Welcome/ \
  /documentserver//welcome/ /documentserver/%77elcome/ /documentserver/./welcome/ /documentserver/x/../welcome/ \
  /documentserver/example/ /documentserver/example; do
  check 404 - "$p"
done
check 200 "up /welcomex" /documentserver/welcomex

echo "# office on, welcome opt-in"
start SYNCLET_OFFICE_ENABLED=on SYNCLET_OFFICE_WELCOME=on
check 200 "up /welcome/" /documentserver/welcome/

echo "# office on its own subdomain (compose.office.yml)"
start SYNCLET_OFFICE_ENABLED=on SYNCLET_CADDY_OFFICE=on SYNCLET_OFFICE_SITE_ADDRESS=http://office.localhost
check 404 - /documentserver/healthcheck
check 200 "up /healthcheck office.localhost http" /healthcheck -H 'Host: office.localhost'

[ "$FAILS" = 0 ] && echo "all checks passed" || { echo "$FAILS check(s) failed"; exit 1; }
