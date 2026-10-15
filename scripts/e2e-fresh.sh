#!/usr/bin/env bash
# Runs the Playwright smoke test against a fresh, throwaway stack (empty DB, empty data folder).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${SYNCLET_E2E_PORT:-18081}
TLS_PORT=${SYNCLET_E2E_TLS_PORT:-18444}
PROJECT=synclet-e2e-$$
WORK=$(mktemp -d)
mkdir -p "$WORK/files" "$WORK/meta"
cat > "$WORK/.env" <<ENV
SYNCLET_DATA=$WORK/files
SYNCLET_META=$WORK/meta
PUID=$(id -u)
PGID=$(id -g)
POSTGRES_PASSWORD=e2e
SYNCLET_PORT=$PORT
SYNCLET_TLS_PORT=$TLS_PORT
SYNCLET_SITE_ADDRESS=:80
ENV
DC=(docker compose -p "$PROJECT" -f "$ROOT/deploy/compose.yml" --env-file "$WORK/.env")
cleanup() { local rc=$?; "${DC[@]}" down -v >/dev/null 2>&1 || true; rm -rf "$WORK"; exit "$rc"; }
trap cleanup EXIT
"${DC[@]}" up -d --build
for i in $(seq 1 60); do curl -fs "localhost:$PORT/api/health" >/dev/null && break; sleep 2; done
curl -fs "localhost:$PORT/api/health" >/dev/null || { echo "FAIL: stack did not become healthy" >&2; exit 1; }
cd "$ROOT" && SYNCLET_URL="http://localhost:$PORT" pnpm test:e2e "$@"
