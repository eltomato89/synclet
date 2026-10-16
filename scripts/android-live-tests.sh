#!/usr/bin/env bash
# Live tests of the Android client against a fresh, throwaway stack (empty DB and data folder, its own compose
# project synclet-android-live-<pid>, free ports, per-run image tags, the derivatives worker running):
#   1. core live tests on the JVM (LiveUploadTest: interrupted tus upload resumed without duplicate, conflict copy);
#   2. instrumented tests on the emulator AVD "SyncletPixel" (created on first use from
#      system-images;android-35;google_apis;arm64-v8a): :core (Keystore) and :app (DocumentsProvider through the
#      ContentResolver, Compose browser flow, preview pager gestures, browser-login redirect and re-sign-in,
#      provider write-on-close). The emulator reaches the host as 10.0.2.2.
# SYNCLET_PUBLIC_URL stays unset, so share links come back relative (/s/<token>) and the app must resolve them.
# The trap removes only this run's compose project (volumes, images), work folder and emulator process.
#
#   scripts/android-live-tests.sh            # core live tests + instrumented tests
#   scripts/android-live-tests.sh --core     # only the JVM live tests
#   scripts/android-live-tests.sh --app      # only the instrumented tests
#   scripts/android-live-tests.sh --serve    # no tests: stack + emulator (with window) stay up, the debug app is
#                                            # installed and signed in; prints URL and tokens until Ctrl-C
#                                            # (or kill -TERM <pid> when started in the background)
#
# Env: SYNCLET_ANDROIDLIVE_PORT / _TLS_PORT (default: first free port from 18381 / 18744 up), SYNCLET_LIVE_SIZE_MB
# (default 48), ANDROID_HOME (default ~/Library/Android/sdk), EMULATOR_HEADLESS=0 shows the emulator window,
# ANDROIDLIVE_LOGS=1 prints the server log on failure, ANDROIDLIVE_CLASS=<class>[#method] runs only that instrumented
# test class (of :core when it lies in tech.jensk.synclet.core, else of :app).
set -euo pipefail
for tool in docker jq nc curl; do command -v "$tool" >/dev/null || { echo "FAIL: $tool is required" >&2; exit 2; }; done

ROOT=$(cd "$(dirname "$0")/.." && pwd)
MODE=${1:-all}
case "$MODE" in all|--core|--app|--serve) ;; *) echo "usage: $0 [--core|--app|--serve]" >&2; exit 2 ;; esac
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}
export JAVA_HOME=${JAVA_HOME:-$(/usr/libexec/java_home -v 21)}
ADB="$ANDROID_HOME/platform-tools/adb"
EMULATOR="$ANDROID_HOME/emulator/emulator"
AVDMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
AVD=SyncletPixel
IMAGE="system-images;android-35;google_apis;arm64-v8a"

# First port from $1 up that nothing listens on (and that is not $2).
free_port() {
  local port=$1
  while nc -z localhost "$port" >/dev/null 2>&1 || [ "$port" = "${2:-}" ]; do port=$((port + 1)); done
  echo "$port"
}
PORT=${SYNCLET_ANDROIDLIVE_PORT:-$(free_port 18381)}
TLS_PORT=${SYNCLET_ANDROIDLIVE_TLS_PORT:-$(free_port 18744 "$PORT")}
PROJECT=synclet-android-live-$$
TAG=androidlive-$$
USER_NAME=androidlive
# No spaces: instrumentation arguments go through `am instrument -e` on the device shell.
PASSWORD='correct-horse-battery-staple'
TEAM_NAME=UITeam
WORK=$(mktemp -d)
EMU_PID=""
SERIAL=""
SLEEP_PID=""
mkdir -p "$WORK/files" "$WORK/meta" "$WORK/teams"
cat > "$WORK/.env" <<ENV
SYNCLET_DATA=$WORK/files
SYNCLET_META=$WORK/meta
SYNCLET_TEAMS=$WORK/teams
PUID=$(id -u)
PGID=$(id -g)
POSTGRES_PASSWORD=androidlive
SYNCLET_PORT=$PORT
SYNCLET_TLS_PORT=$TLS_PORT
SYNCLET_SITE_ADDRESS=:80
SYNCLET_VERSIONS=on
ENV
# Images tagged per run, so parallel runs and the dev images (synclet/*:dev) never collide.
cat > "$WORK/compose.androidlive.yml" <<YML
services:
  server:
    image: synclet-androidlive/server:$TAG
  worker:
    image: synclet-androidlive/server:$TAG
    pull_policy: never
  caddy:
    image: synclet-androidlive/caddy:$TAG
YML
DC=(docker compose -p "$PROJECT" -f "$ROOT/deploy/compose.yml" -f "$ROOT/deploy/compose.build.yml" -f "$WORK/compose.androidlive.yml" --env-file "$WORK/.env")

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "$rc" -ne 0 ] && [ "${ANDROIDLIVE_LOGS:-0}" = 1 ]; then "${DC[@]}" logs --tail 200 server worker 2>/dev/null || true; fi
  if [ -n "$SLEEP_PID" ]; then kill "$SLEEP_PID" 2>/dev/null || true; fi
  if [ -n "$SERIAL" ]; then "$ADB" -s "$SERIAL" emu kill >/dev/null 2>&1 || true; fi
  if [ -n "$EMU_PID" ]; then
    for _ in $(seq 1 20); do kill -0 "$EMU_PID" 2>/dev/null || break; sleep 1; done
    kill "$EMU_PID" 2>/dev/null || true          # exactly the emulator process this run started
  fi
  "${DC[@]}" down -v >/dev/null 2>&1 || true
  docker image rm "synclet-androidlive/server:$TAG" "synclet-androidlive/caddy:$TAG" >/dev/null 2>&1 || true
  rm -rf "$WORK"
  echo "== cleaned up: compose project $PROJECT${SERIAL:+, emulator $SERIAL}"
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
  -d "{\"username\":\"$USER_NAME\",\"displayName\":\"Android Live\",\"password\":\"$PASSWORD\"}")
ACCESS=$(jq -r .accessToken <<<"$SETUP")
USER_ID=$(jq -r .user.id <<<"$SETUP")
[ -n "$ACCESS" ] && [ "$ACCESS" != null ] || fail "setup returned no access token"

# Team folder: the administrator creates /teams/UITeam with itself as a writing member; a server without the
# admin spaces API only skips this (the team-folder UI test then skips itself).
TEAM=""
if [ "$(curl -s -o /dev/null -w '%{http_code}' "$B/admin/spaces" -H "authorization: Bearer $ACCESS")" = 200 ]; then
  curl -fsS -XPOST "$B/admin/spaces" -H "authorization: Bearer $ACCESS" -H 'content-type: application/json' \
    -d "{\"name\":\"$TEAM_NAME\",\"members\":[{\"kind\":\"user\",\"id\":\"$USER_ID\",\"role\":\"write\"}]}" >/dev/null \
    || fail "creating the team folder $TEAM_NAME failed"
  TEAM=$TEAM_NAME
  echo "== team folder $TEAM_NAME: $USER_NAME is a writing member"
fi

# register_device <name> <installation id>: a device token through the documented registration.
register_device() {
  local token
  token=$(curl -fsS -XPOST "$B/sync/v1/devices" -H "authorization: Bearer $ACCESS" -H 'content-type: application/json' \
    -d "{\"name\":\"$1\",\"platform\":\"android\",\"appVersion\":\"0.1.5\",\"installationId\":\"$2\"}" | jq -r .token)
  [ -n "$token" ] && [ "$token" != null ] || fail "device registration returned no token"
  echo "$token"
}
CORE_TOKEN=$(register_device "android-live core" "core-$$")
APP_TOKEN=$(register_device "android-live app" "app-$$")

start_emulator() {
  [ -d "$ANDROID_HOME/system-images/android-35/google_apis/arm64-v8a" ] || fail "system image missing: sdkmanager \"$IMAGE\""
  if ! "$EMULATOR" -list-avds | grep -qx "$AVD"; then
    echo "== creating AVD $AVD"
    echo no | "$AVDMANAGER" create avd -n "$AVD" -k "$IMAGE" -d pixel_7 >/dev/null
  fi
  # A console port no other emulator (and nothing else) uses; adb finds emulators on 5554–5585.
  local port=5580
  while "$ADB" devices | grep -q "emulator-$port" || nc -z localhost "$port" >/dev/null 2>&1 || nc -z localhost $((port + 1)) >/dev/null 2>&1; do
    port=$((port + 2))
  done
  [ "$port" -le 5584 ] || fail "no free emulator port in 5580–5584"
  SERIAL=emulator-$port
  local window=(-no-window)
  if [ "${EMULATOR_HEADLESS:-1}" = 0 ] || [ "$MODE" = --serve ]; then window=(); fi
  # -read-only: the AVD's own data stays untouched, every run boots a fresh device.
  "$EMULATOR" -avd "$AVD" -port "$port" "${window[@]}" -no-audio -no-boot-anim -no-snapshot -read-only \
    -gpu swiftshader_indirect >"$WORK/emulator.log" 2>&1 &
  EMU_PID=$!
  echo "== booting $AVD as $SERIAL (pid $EMU_PID)"
  local booted=""
  for _ in $(seq 1 180); do
    kill -0 "$EMU_PID" 2>/dev/null || { tail -n 30 "$WORK/emulator.log" >&2; fail "emulator exited during boot"; }
    if [ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; then booted=1; break; fi
    sleep 2
  done
  [ -n "$booted" ] || { tail -n 30 "$WORK/emulator.log" >&2; fail "emulator did not boot within 6 minutes"; }
  for s in window_animation_scale transition_animation_scale animator_duration_scale; do
    "$ADB" -s "$SERIAL" shell settings put global "$s" 0
  done
  echo "== emulator $SERIAL ($AVD) is up"
}

cd "$ROOT/apps/android"
[ -f local.properties ] || echo "sdk.dir=$ANDROID_HOME" > local.properties

if [ "$MODE" = --serve ]; then
  start_emulator
  ANDROID_SERIAL="$SERIAL" ./gradlew -q :app:installDebug
  "$ADB" -s "$SERIAL" shell am start -n tech.jensk.synclet/tech.jensk.synclet.login.DebugLoginActivity \
    --es server "http://10.0.2.2:$PORT" --es token "$APP_TOKEN" >/dev/null
  cat <<INFO

== Throwaway server ready: http://localhost:$PORT (emulator: http://10.0.2.2:$PORT)
   user: $USER_NAME   password: $PASSWORD   (web UI: same address)
   emulator $SERIAL: debug app installed and signed in
   sign in again: $ADB -s $SERIAL shell am start -n tech.jensk.synclet/tech.jensk.synclet.login.DebugLoginActivity --es server http://10.0.2.2:$PORT --es token $APP_TOKEN
   contract suite: SYNCLET_URL=http://localhost:$PORT SYNCLET_TOKEN=$CORE_TOKEN pnpm test:contract
   Ctrl-C (or kill -TERM $$) removes stack and emulator.
INFO
  # sleep in the background + wait: the INT/TERM trap runs at once, not only after the sleep.
  while true; do sleep 3600 & SLEEP_PID=$!; wait "$SLEEP_PID"; done
fi

if [ "$MODE" = all ] || [ "$MODE" = --core ]; then
  echo "== core live tests against http://localhost:$PORT"
  ./gradlew :core:testDebugUnitTest --tests 'tech.jensk.synclet.core.live.*' \
    -PsyncletLiveUrl="http://localhost:$PORT" -PsyncletLiveToken="$CORE_TOKEN" -PsyncletLiveSizeMb="${SYNCLET_LIVE_SIZE_MB:-48}"
fi

if [ "$MODE" = all ] || [ "$MODE" = --app ]; then
  start_emulator
  echo "== instrumented tests on $SERIAL"
  ARGS=(syncletServer="http://10.0.2.2:$PORT" syncletToken="$APP_TOKEN" syncletUser="$USER_NAME" syncletPassword="$PASSWORD")
  if [ -n "$TEAM" ]; then ARGS+=(syncletTeam="$TEAM"); fi    # an empty -e value would break am instrument
  TASKS=(:core:connectedDebugAndroidTest :app:connectedDebugAndroidTest)
  if [ -n "${ANDROIDLIVE_CLASS:-}" ]; then
    ARGS+=(class="$ANDROIDLIVE_CLASS")
    case "$ANDROIDLIVE_CLASS" in tech.jensk.synclet.core.*) TASKS=(:core:connectedDebugAndroidTest) ;; *) TASKS=(:app:connectedDebugAndroidTest) ;; esac
  fi
  ANDROID_SERIAL="$SERIAL" ./gradlew "${TASKS[@]}" \
    "${ARGS[@]/#/-Pandroid.testInstrumentationRunnerArguments.}"
fi
echo "== android-live-tests: all passed"
