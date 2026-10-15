#!/usr/bin/env bash
# Runs the Playwright suite against a fresh, throwaway stack (empty DB, empty data folder) with
# versions on, a mock OpenID provider and an authenticating reverse proxy for forward-auth
# (e2e/stack/compose.e2e.yml). E2E_OFFICE=1 adds the Euro-Office Document Server (big image, ~4 GB RAM).
# Then runs the Sync API conformance suite (packages/sync-contract) against the same stack.
# Extra arguments go to Playwright (e.g. `tests/versions.spec.ts`) and skip the contract suite
# unless E2E_CONTRACT=1.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${SYNCLET_E2E_PORT:-18081}
TLS_PORT=${SYNCLET_E2E_TLS_PORT:-18444}
OIDC_PORT=${SYNCLET_E2E_OIDC_PORT:-18901}
FORWARD_PORT=${SYNCLET_E2E_FORWARD_PORT:-18082}
OFFICE=${E2E_OFFICE:-0}
PROJECT=synclet-e2e-$$
TAG=e2e-$$
WORK=$(mktemp -d)
mkdir -p "$WORK/files" "$WORK/meta"
# A folder without a user, for the "use an existing folder" case of the admin spec.
mkdir -p "$WORK/files/altbestand/Projekte"
printf 'aus dem alten Server' > "$WORK/files/altbestand/Projekte/notiz.txt"
cat > "$WORK/.env" <<ENV
SYNCLET_DATA=$WORK/files
SYNCLET_META=$WORK/meta
PUID=$(id -u)
PGID=$(id -g)
POSTGRES_PASSWORD=e2e
SYNCLET_PORT=$PORT
SYNCLET_TLS_PORT=$TLS_PORT
SYNCLET_SITE_ADDRESS=:80
SYNCLET_PUBLIC_URL=http://localhost:$PORT
SYNCLET_VERSIONS=on
SYNCLET_SSO_ALLOW_HTTP_ISSUER=1
E2E_TAG=$TAG
E2E_OIDC_PORT=$OIDC_PORT
E2E_FORWARD_PORT=$FORWARD_PORT
ENV
FILES=(-f "$ROOT/deploy/compose.yml" -f "$ROOT/e2e/stack/compose.e2e.yml")
if [ "$OFFICE" = 1 ]; then
  # The Document Server on its own subdomain of the same Caddy (office.localhost resolves to the
  # loopback address in Chromium), plain http like the rest of the e2e stack.
  cat >> "$WORK/.env" <<ENV
OFFICE_JWT_SECRET=$(openssl rand -hex 32)
SYNCLET_OFFICE_SITE_ADDRESS=http://office.localhost
SYNCLET_OFFICE_PUBLIC_URL=http://office.localhost:$PORT
ENV
  FILES+=(-f "$ROOT/deploy/compose.office.yml")
fi
DC=(docker compose -p "$PROJECT" "${FILES[@]}" --env-file "$WORK/.env")
cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "${E2E_LOGS:-0}" = 1 ]; then "${DC[@]}" logs --tail 200 server 2>/dev/null || true; fi
  "${DC[@]}" down -v >/dev/null 2>&1 || true
  docker image rm "synclet-e2e/server:$TAG" "synclet-e2e/caddy:$TAG" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT
wait_for() { # <seconds/2> <url> <what>
  for _ in $(seq 1 "$1"); do curl -fs "$2" >/dev/null && return 0; sleep 2; done
  echo "FAIL: $3 did not become ready ($2)" >&2; exit 1
}
"${DC[@]}" up -d --build
wait_for 60 "localhost:$PORT/api/health" "stack"
wait_for 60 "localhost:$OIDC_PORT/default/.well-known/openid-configuration" "mock OIDC provider"

# Caddy may only trust the auth proxy container as a source of Remote-* headers (never the Docker
# gateway the browser's connections come from), so its address is known only now: restart Caddy
# with it (SYNCLET_FORWARD_AUTH_PROXIES for the headers, SYNCLET_TRUSTED_PROXIES for its XFF).
# The server trusts the whole e2e network (a throwaway stack; it only ever sees Caddy).
PROXY=$("${DC[@]}" ps -q authproxy)
NET=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}' "$PROXY")
PROXY_IP=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$PROXY")
CIDR=$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$NET" | tr ' ' '\n' | grep -m1 '\.' || true)
[ -n "$PROXY_IP" ] && [ -n "$CIDR" ] || { echo "FAIL: cannot determine the e2e network ($NET: proxy '$PROXY_IP', subnet '$CIDR')" >&2; exit 1; }
echo "SYNCLET_FORWARD_AUTH_PROXIES=$PROXY_IP/32" >> "$WORK/.env"
echo "SYNCLET_TRUSTED_PROXIES=$PROXY_IP/32" >> "$WORK/.env"
"${DC[@]}" up -d --no-deps caddy
wait_for 30 "localhost:$PORT/api/health" "Caddy"
wait_for 30 "localhost:$FORWARD_PORT/api/health" "auth proxy"
if [ "$OFFICE" = 1 ]; then wait_for 150 "http://office.localhost:$PORT/healthcheck" "Document Server"; fi

cd "$ROOT" && SYNCLET_URL="http://localhost:$PORT" \
  E2E_DATA_DIR="$WORK/files" \
  E2E_OIDC_ISSUER="http://oidc.localhost:$OIDC_PORT/default" \
  E2E_FORWARD_URL="http://localhost:$FORWARD_PORT" \
  E2E_NETWORK_CIDR="$CIDR" \
  E2E_OFFICE="$OFFICE" \
  E2E_OFFICE_URL="http://office.localhost:$PORT" \
  pnpm test:e2e "$@"

# The Sync API conformance suite against the same stack (versions on, worker running), as the
# administrator the Playwright setup created. Skipped for partial runs (Playwright arguments) or
# with E2E_CONTRACT=0.
if [ "${E2E_CONTRACT:-$([ $# -eq 0 ] && echo 1 || echo 0)}" = 1 ]; then
  SYNCLET_URL="http://localhost:$PORT" SYNCLET_USER=e2e SYNCLET_PASSWORD='correct horse battery' pnpm test:contract
fi
