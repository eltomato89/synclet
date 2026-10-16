#!/usr/bin/env bash
# Runs the opt-in live tests of SyncletKit (apps/apple/SyncletKit: LiveAPITests, LiveTransferTests,
# LiveThumbnailTests, EventStreamLiveTests, LiveSpacesTests) against a fresh, throwaway stack: empty
# DB and data folder, its own compose project, ports and image tags, the derivatives worker running
# (thumbnails). The administrator is created through the setup API; a device token for the SSE and
# spaces tests is registered with its access token. A team folder `Test` is created through the admin
# API (`POST /api/admin/spaces {name, members}`, which makes `/teams/Test`) with the administrator as a
# writing member (a server without spaces skips this, and LiveSpacesTests skip themselves). The trap removes only this run's project, volumes, images and
# work folder.
#
#   scripts/macos-live-tests.sh                 # all live test classes (swift test --filter Live)
#   scripts/macos-live-tests.sh LiveAPITests    # another `swift test --filter` expression
#   scripts/macos-live-tests.sh --serve         # no tests: keep the stack up for the manual Finder
#                                               # checklist (apps/macos/README.md) until Ctrl-C
#
# Env: SYNCLET_MACLIVE_PORT / _TLS_PORT (default: the first free port from 18181 / 18544 up, so
# parallel runs do not collide), SYNCLET_MACLIVE_DATA_DIR (the server's files folder instead of a fresh
# temp folder, e.g. on a small disk image for the manual 507 check; never removed by the trap),
# SYNCLET_LIVE_SIZE_MB (size of the
# interrupted-transfer tests, default 48 here), SYNCLET_LIVE_INTERRUPT (see LiveTransferTests),
# SYNCLET_MACLIVE_MAX_UPLOAD_BYTES sets the server's SYNCLET_MAX_UPLOAD_BYTES (for the manual 413 check
# with --serve; the live tests need more than 64 MB), MACLIVE_LOGS=1 prints the server log on
# failure. macOS only (swift test needs FileProvider).
set -euo pipefail
command -v docker >/dev/null || { echo "FAIL: docker is required" >&2; exit 2; }
command -v jq >/dev/null || { echo "FAIL: jq is required" >&2; exit 2; }
command -v swift >/dev/null || { echo "FAIL: swift (Xcode) is required" >&2; exit 2; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# First port from $1 up that nothing listens on (and that is not $2).
free_port() {
  local port=$1
  while nc -z localhost "$port" >/dev/null 2>&1 || [ "$port" = "${2:-}" ]; do port=$((port + 1)); done
  echo "$port"
}
PORT=${SYNCLET_MACLIVE_PORT:-$(free_port 18181)}
TLS_PORT=${SYNCLET_MACLIVE_TLS_PORT:-$(free_port 18544 "$PORT")}
PROJECT=synclet-maclive-$$
TAG=maclive-$$
FILTER=${1:-Live}
USER_NAME=maclive
PASSWORD='correct horse battery staple'
WORK=$(mktemp -d)
DATA_DIR=${SYNCLET_MACLIVE_DATA_DIR:-$WORK/files}
TEAM_NAME=Test
mkdir -p "$DATA_DIR" "$WORK/meta" "$WORK/teams"
cat > "$WORK/.env" <<ENV
SYNCLET_DATA=$DATA_DIR
SYNCLET_META=$WORK/meta
SYNCLET_TEAMS=$WORK/teams
PUID=$(id -u)
PGID=$(id -g)
POSTGRES_PASSWORD=maclive
SYNCLET_PORT=$PORT
SYNCLET_TLS_PORT=$TLS_PORT
SYNCLET_SITE_ADDRESS=:80
SYNCLET_PUBLIC_URL=http://localhost:$PORT
SYNCLET_VERSIONS=on
ENV
# Only when set: an empty value would override the server's default.
if [ -n "${SYNCLET_MACLIVE_MAX_UPLOAD_BYTES:-}" ]; then
  echo "SYNCLET_MAX_UPLOAD_BYTES=$SYNCLET_MACLIVE_MAX_UPLOAD_BYTES" >> "$WORK/.env"
fi
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
SETUP=$(curl -fsS -XPOST "$B/setup" -H 'content-type: application/json' \
  -d "{\"username\":\"$USER_NAME\",\"displayName\":\"macOS Live\",\"password\":\"$PASSWORD\"}")
ACCESS=$(jq -r .accessToken <<<"$SETUP")
USER_ID=$(jq -r .user.id <<<"$SETUP")
[ -n "$ACCESS" ] && [ "$ACCESS" != null ] || fail "setup returned no access token"
# A device token for EventStreamLiveTests (it takes a ready token instead of signing in).
DEVICE_TOKEN=$(curl -fsS -XPOST "$B/sync/v1/devices" -H "authorization: Bearer $ACCESS" -H 'content-type: application/json' \
  -d '{"name":"macos-live-tests SSE","platform":"macos","appVersion":"0.1.0"}' | jq -r .token)
[ -n "$DEVICE_TOKEN" ] && [ "$DEVICE_TOKEN" != null ] || fail "device registration returned no token"

# Team folder (Phase 4): created with the administrator as a writing member in one call.
# A server without the admin spaces API (404) only skips this; LiveSpacesTests then skip too.
TEAM_ID=
if [ "$(curl -s -o /dev/null -w '%{http_code}' "$B/admin/spaces" -H "authorization: Bearer $ACCESS")" = 200 ]; then
  TEAM_ID=$(curl -fsS -XPOST "$B/admin/spaces" -H "authorization: Bearer $ACCESS" -H 'content-type: application/json' \
    -d "{\"name\":\"$TEAM_NAME\",\"members\":[{\"kind\":\"user\",\"id\":\"$USER_ID\",\"role\":\"write\"}]}" | jq -r '.id // empty') \
    || fail "creating the team folder $TEAM_NAME failed"
  [ -n "$TEAM_ID" ] || fail "creating the team folder $TEAM_NAME returned no id"
  echo "== team folder $TEAM_NAME ($TEAM_ID): $USER_NAME is a writing member"
else
  echo "== the server has no admin spaces API: no team folder (LiveSpacesTests skip)"
fi

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
  SYNCLET_LIVE_TEAM="$TEAM_NAME" \
  SYNCLET_LIVE_SIZE_MB="${SYNCLET_LIVE_SIZE_MB:-48}" \
  swift test --filter "$FILTER"
