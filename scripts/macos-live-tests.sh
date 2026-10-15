#!/usr/bin/env bash
# Runs the opt-in live tests of SyncletKit (apps/apple/SyncletKit: LiveAPITests, LiveTransferTests,
# LiveThumbnailTests, EventStreamLiveTests) against a fresh, throwaway stack: empty DB and data
# folder, its own compose project, ports and image tags, the derivatives worker running (thumbnails).
# The administrator is created through the setup API; a device token for the SSE test is registered
# with its access token. The trap removes only this run's project, volumes, images and work folder.
#
#   scripts/macos-live-tests.sh                 # all live test classes (swift test --filter Live)
#   scripts/macos-live-tests.sh LiveAPITests    # another `swift test --filter` expression
#   scripts/macos-live-tests.sh --serve         # no tests: keep the stack up for the manual Finder
#                                               # checklist (apps/macos/README.md) until Ctrl-C
#
# Env: SYNCLET_MACLIVE_PORT / _TLS_PORT (default 18181 / 18544), SYNCLET_LIVE_SIZE_MB (size of the
# interrupted-transfer tests, default 48 here), SYNCLET_LIVE_INTERRUPT (see LiveTransferTests),
# SYNCLET_MACLIVE_MAX_UPLOAD_BYTES sets the server's SYNCLET_MAX_UPLOAD_BYTES (for the manual 413 check
# with --serve; the live tests need more than 64 MB), MACLIVE_LOGS=1 prints the server log on
# failure. macOS only (swift test needs FileProvider).
set -euo pipefail
command -v docker >/dev/null || { echo "FAIL: docker is required" >&2; exit 2; }
command -v jq >/dev/null || { echo "FAIL: jq is required" >&2; exit 2; }
command -v swift >/dev/null || { echo "FAIL: swift (Xcode) is required" >&2; exit 2; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${SYNCLET_MACLIVE_PORT:-18181}
TLS_PORT=${SYNCLET_MACLIVE_TLS_PORT:-18544}
PROJECT=synclet-maclive-$$
TAG=maclive-$$
FILTER=${1:-Live}
USER_NAME=maclive
PASSWORD='correct horse battery staple'
WORK=$(mktemp -d)
mkdir -p "$WORK/files" "$WORK/meta"
cat > "$WORK/.env" <<ENV
SYNCLET_DATA=$WORK/files
SYNCLET_META=$WORK/meta
PUID=$(id -u)
PGID=$(id -g)
POSTGRES_PASSWORD=maclive
SYNCLET_PORT=$PORT
SYNCLET_TLS_PORT=$TLS_PORT
SYNCLET_SITE_ADDRESS=:80
SYNCLET_PUBLIC_URL=http://localhost:$PORT
SYNCLET_VERSIONS=on
SYNCLET_MAX_UPLOAD_BYTES=${SYNCLET_MACLIVE_MAX_UPLOAD_BYTES:-}
ENV
# Images tagged per run, so parallel runs and the dev images (synclet/*:dev) never collide.
cat > "$WORK/compose.maclive.yml" <<YML
services:
  server:
    image: synclet-maclive/server:$TAG
  worker:
    image: synclet-maclive/server:$TAG
    pull_policy: never
  caddy:
    image: synclet-maclive/caddy:$TAG
YML
DC=(docker compose -p "$PROJECT" -f "$ROOT/deploy/compose.yml" -f "$WORK/compose.maclive.yml" --env-file "$WORK/.env")
cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "${MACLIVE_LOGS:-0}" = 1 ]; then "${DC[@]}" logs --tail 200 server worker 2>/dev/null || true; fi
  "${DC[@]}" down -v >/dev/null 2>&1 || true
  docker image rm "synclet-maclive/server:$TAG" "synclet-maclive/caddy:$TAG" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
fail() { echo "FAIL: $*" >&2; exit 1; }

"${DC[@]}" up -d --build
for _ in $(seq 1 90); do curl -fs "localhost:$PORT/api/health" >/dev/null && break; sleep 2; done
curl -fs "localhost:$PORT/api/health" >/dev/null || fail "stack did not become healthy (localhost:$PORT)"
[ -n "$("${DC[@]}" ps -q worker)" ] || fail "derivatives worker is not running"

B=http://localhost:$PORT/api
ACCESS=$(curl -fsS -XPOST "$B/setup" -H 'content-type: application/json' \
  -d "{\"username\":\"$USER_NAME\",\"displayName\":\"macOS Live\",\"password\":\"$PASSWORD\"}" | jq -r .accessToken)
[ -n "$ACCESS" ] && [ "$ACCESS" != null ] || fail "setup returned no access token"
# A device token for EventStreamLiveTests (it takes a ready token instead of signing in).
DEVICE_TOKEN=$(curl -fsS -XPOST "$B/sync/v1/devices" -H "authorization: Bearer $ACCESS" -H 'content-type: application/json' \
  -d '{"name":"macos-live-tests SSE","platform":"macos","appVersion":"0.1.0"}' | jq -r .token)
[ -n "$DEVICE_TOKEN" ] && [ "$DEVICE_TOKEN" != null ] || fail "device registration returned no token"

if [ "$FILTER" = "--serve" ]; then
  cat <<INFO

== Throwaway server ready: http://localhost:$PORT
   user: $USER_NAME   password: $PASSWORD   (web UI: same address)
   stop/start the server: docker compose -p $PROJECT stop server / start server
   Ctrl-C removes the stack (sign out of the Mac app first, so its domain is removed).
INFO
  while true; do sleep 3600; done
fi

echo "== swift test --filter $FILTER against http://localhost:$PORT (user $USER_NAME)"
cd "$ROOT/apps/apple/SyncletKit"
SYNCLET_LIVE_URL="http://localhost:$PORT" \
  SYNCLET_LIVE_USER="$USER_NAME" \
  SYNCLET_LIVE_PASSWORD="$PASSWORD" \
  SYNCLET_LIVE_TOKEN="$DEVICE_TOKEN" \
  SYNCLET_LIVE_SIZE_MB="${SYNCLET_LIVE_SIZE_MB:-48}" \
  swift test --filter "$FILTER"
