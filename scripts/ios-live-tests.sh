#!/usr/bin/env bash
# Live tests of the iOS client against a fresh, throwaway stack (empty DB and data folder, its own
# compose project `synclet-ios-live-<pid>`, free ports and per-run image tags, the derivatives
# worker running):
#   1. SyncletKit live tests (`swift test --filter Live`, incl. LiveBackgroundUploadTests) with the
#      same environment as scripts/macos-live-tests.sh;
#   2. the app's UI tests (scheme SyncletUITests) on a private simulator: LaunchTests on the fresh
#      install, then BrowserFlowUITests (incl. the upload into the team folder `/teams/UITeam`,
#      created through the admin API) signed in through the DEBUG test login
#      (`-SyncletTestServer`/`-SyncletTestToken`, handed to the runner as TEST_RUNNER_* env vars
#      and turned into launch arguments by UITestSupport).
# The administrator is created through the setup API; device tokens are registered with its access
# token. The trap removes only this run's compose project (volumes, images), work folder and simulator.
#
#   scripts/ios-live-tests.sh            # Kit live tests + UI tests
#   scripts/ios-live-tests.sh --kit      # only the Kit live tests
#   scripts/ios-live-tests.sh --ui       # only the UI tests
#   scripts/ios-live-tests.sh --serve    # no tests: keep the stack up and print URL + an iOS device
#                                        # token (debug sign-in, device checklist) until Ctrl-C
#
# Env: SYNCLET_IOSLIVE_PORT / _TLS_PORT (default: the first free port from 18281 / 18644 up),
# SYNCLET_LIVE_SIZE_MB (interrupted-transfer tests, default 48), IOS_DEVICE (simulator device
# type, default "iPhone 18 Pro"; the UI flow expects the compact iPhone layout), IOSLIVE_LOGS=1
# prints the server log on failure.
set -euo pipefail
command -v docker >/dev/null || { echo "FAIL: docker is required" >&2; exit 2; }
command -v jq >/dev/null || { echo "FAIL: jq is required" >&2; exit 2; }
command -v swift >/dev/null || { echo "FAIL: swift (Xcode) is required" >&2; exit 2; }
command -v xcodegen >/dev/null || { echo "FAIL: xcodegen is required" >&2; exit 2; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MODE=${1:-all}
case "$MODE" in all|--kit|--ui|--serve) ;; *) echo "usage: $0 [--kit|--ui|--serve]" >&2; exit 2 ;; esac
# First port from $1 up that nothing listens on (and that is not $2).
free_port() {
  local port=$1
  while nc -z localhost "$port" >/dev/null 2>&1 || [ "$port" = "${2:-}" ]; do port=$((port + 1)); done
  echo "$port"
}
PORT=${SYNCLET_IOSLIVE_PORT:-$(free_port 18281)}
TLS_PORT=${SYNCLET_IOSLIVE_TLS_PORT:-$(free_port 18644 "$PORT")}
PROJECT=synclet-ios-live-$$
TAG=ioslive-$$
USER_NAME=ioslive
PASSWORD='correct horse battery staple'
WORK=$(mktemp -d)
UDID=
TEAM_NAME=UITeam
mkdir -p "$WORK/files" "$WORK/meta" "$WORK/teams"
cat > "$WORK/.env" <<ENV
SYNCLET_DATA=$WORK/files
SYNCLET_META=$WORK/meta
SYNCLET_TEAMS=$WORK/teams
PUID=$(id -u)
PGID=$(id -g)
POSTGRES_PASSWORD=ioslive
SYNCLET_PORT=$PORT
SYNCLET_TLS_PORT=$TLS_PORT
SYNCLET_SITE_ADDRESS=:80
SYNCLET_PUBLIC_URL=http://localhost:$PORT
SYNCLET_VERSIONS=on
ENV
# Images tagged per run, so parallel runs and the dev images (synclet/*:dev) never collide.
cat > "$WORK/compose.ioslive.yml" <<YML
services:
  server:
    image: synclet-ioslive/server:$TAG
  worker:
    image: synclet-ioslive/server:$TAG
    pull_policy: never
  caddy:
    image: synclet-ioslive/caddy:$TAG
YML
DC=(docker compose -p "$PROJECT" -f "$ROOT/deploy/compose.yml" -f "$ROOT/deploy/compose.build.yml" -f "$WORK/compose.ioslive.yml" --env-file "$WORK/.env")
cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "${IOSLIVE_LOGS:-0}" = 1 ]; then "${DC[@]}" logs --tail 200 server worker 2>/dev/null || true; fi
  if [ -n "$UDID" ]; then
    xcrun simctl shutdown "$UDID" >/dev/null 2>&1 || true
    if ! xcrun simctl delete "$UDID" >/dev/null 2>&1; then
      # CoreSimulator sometimes may not move the device's data folder away ("Operation not
      # permitted", seen with the iOS 27 runtime); remove this run's data folder, then retry.
      local dir="$HOME/Library/Developer/CoreSimulator/Devices/$UDID"
      if [[ "$UDID" =~ ^[0-9A-F-]{36}$ ]] && [ -d "$dir/data" ]; then rm -rf "$dir/data" || true; fi
      xcrun simctl delete "$UDID" >/dev/null 2>&1 || echo "WARN: simulator $UDID not deleted" >&2
    fi
  fi
  "${DC[@]}" down -v >/dev/null 2>&1 || true
  docker image rm "synclet-ioslive/server:$TAG" "synclet-ioslive/caddy:$TAG" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  echo "== cleaned up: compose project $PROJECT${UDID:+, simulator $UDID}"
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
  -d "{\"username\":\"$USER_NAME\",\"displayName\":\"iOS Live\",\"password\":\"$PASSWORD\"}")
ACCESS=$(jq -r .accessToken <<<"$SETUP")
USER_ID=$(jq -r .user.id <<<"$SETUP")
[ -n "$ACCESS" ] && [ "$ACCESS" != null ] || fail "setup returned no access token"

# Team folder (Phase 4): the administrator creates /teams/UITeam through the admin API with
# itself as a writing member (one request, atomic); the UI flow uploads into it. A server without
# the admin spaces API (404) only skips this; the team space UI test then skips itself (no
# TEST_RUNNER_SYNCLET_UITEST_TEAM). Admin kind `team` = Sync API kind `shared`.
TEAM=
if [ "$(curl -s -o /dev/null -w '%{http_code}' "$B/admin/spaces" -H "authorization: Bearer $ACCESS")" = 200 ]; then
  TEAM_ID=$(curl -fsS -XPOST "$B/admin/spaces" -H "authorization: Bearer $ACCESS" -H 'content-type: application/json' \
    -d "{\"name\":\"$TEAM_NAME\",\"members\":[{\"kind\":\"user\",\"id\":\"$USER_ID\",\"role\":\"write\"}]}" \
    | jq -r '.id // empty') || fail "creating the team folder $TEAM_NAME failed"
  [ -n "$TEAM_ID" ] || fail "creating the team folder $TEAM_NAME returned no id"
  TEAM=$TEAM_NAME
  echo "== team folder $TEAM_NAME ($TEAM_ID): $USER_NAME is a writing member"
else
  echo "== the server has no admin spaces API: no team folder (the team space UI test skips)"
fi
# register_device <name> <platform>: a device token through the documented registration.
register_device() {
  local token
  token=$(curl -fsS -XPOST "$B/sync/v1/devices" -H "authorization: Bearer $ACCESS" -H 'content-type: application/json' \
    -d "{\"name\":\"$1\",\"platform\":\"$2\",\"appVersion\":\"0.1.0\"}" | jq -r .token)
  [ -n "$token" ] && [ "$token" != null ] || fail "device registration returned no token"
  echo "$token"
}
KIT_TOKEN=$(register_device "ios-live-tests Kit" macos)
APP_TOKEN=$(register_device "ios-live-tests UI" ios)

if [ "$MODE" = "--serve" ]; then
  cat <<INFO

== Throwaway server ready: http://localhost:$PORT
   user: $USER_NAME   password: $PASSWORD   (web UI: same address)
   debug sign-in (simulator, DEBUG build):
     -SyncletTestServer http://localhost:$PORT -SyncletTestToken $APP_TOKEN
   stop/start the server: docker compose -p $PROJECT stop server / start server
   Ctrl-C removes the stack.
INFO
  while true; do sleep 3600; done
fi

if [ "$MODE" = all ] || [ "$MODE" = --kit ]; then
  echo "== swift test --filter Live against http://localhost:$PORT (user $USER_NAME)"
  (cd "$ROOT/apps/apple/SyncletKit" &&
    SYNCLET_LIVE_URL="http://localhost:$PORT" \
    SYNCLET_LIVE_USER="$USER_NAME" \
    SYNCLET_LIVE_PASSWORD="$PASSWORD" \
    SYNCLET_LIVE_TOKEN="$KIT_TOKEN" \
    SYNCLET_LIVE_SIZE_MB="${SYNCLET_LIVE_SIZE_MB:-48}" \
    swift test --filter Live)
fi

if [ "$MODE" = all ] || [ "$MODE" = --ui ]; then
  cd "$ROOT/apps/ios"
  xcodegen generate --quiet
  UDID=$(xcrun simctl create "synclet-ios-live-$$" "${IOS_DEVICE:-iPhone 18 Pro}")
  # Derived data and logs stay (gitignored) for incremental rebuilds and failure analysis.
  DD=${DERIVED:-$ROOT/apps/ios/.build/ioslive-dd}
  mkdir -p "$ROOT/apps/ios/.build"
  echo "== UI tests (scheme SyncletUITests) on simulator $UDID"
  # run_xcodebuild <log name> <xcodebuild action and options …>
  run_xcodebuild() {
    local log="$ROOT/apps/ios/.build/ioslive-$1.log" status=0
    shift
    TEST_RUNNER_SYNCLET_UITEST_SERVER="http://localhost:$PORT" \
      TEST_RUNNER_SYNCLET_UITEST_TOKEN="$APP_TOKEN" \
      TEST_RUNNER_SYNCLET_UITEST_TEAM="$TEAM" \
      xcodebuild "$@" -scheme SyncletUITests -destination "id=$UDID" -derivedDataPath "$DD" \
      -collect-test-diagnostics never >"$log" 2>&1 || status=$?
    grep -E "error:|: failed|Test Case .*(passed|failed|skipped)|UITEST:|\*\* .* \*\*" "$log" | tail -n 40 || true
    [ "$status" -eq 0 ] || echo "(full log: $log)" >&2
    return "$status"
  }
  # LaunchTests needs the fresh install (no account), so it runs before the signed-in flow
  # (the second run only rebuilds what changed, i.e. nothing).
  run_xcodebuild launch test -only-testing:SyncletUITests/LaunchTests
  run_xcodebuild flow test -only-testing:SyncletUITests/BrowserFlowUITests
fi
echo "== ios-live-tests: all passed"
