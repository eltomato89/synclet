#!/usr/bin/env bash
# Google Play screenshots of the Android app with the website's SAMPLE data:
#   phone (AVD SyncletPixel, Pixel 7, 1080 × 2400, portrait) and tablet (AVD SyncletTablet, Pixel Tablet,
#   2560 × 1600, landscape), in English and German, seven scenes each (StoreScreenshotsTest).
#
#   scripts/android-store-screenshots.sh                       # → apps/android/build/store-screenshots/<device>-<lang>/
#   STORE_DEVICES=tablet scripts/android-store-screenshots.sh  # only one device (phone, tablet)
#
# Starts the website's throwaway stack (apps/site/scripts/store-stack.ts: own compose project, image tags
# and temp folders) with an Android device token, then per device boots a fresh, read-only emulator
# (created on first use from system-images;android-35;google_apis;arm64-v8a), installs the debug app and
# its tests, and runs the test per language (app language through the per-app locale, status bar in demo
# mode: 9:41, full bars, full battery, no notifications). Removes only its own stack and emulators on exit.
# Needs Docker, jq and the site's node_modules (pnpm install).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$ROOT/apps/android/build/store-screenshots
export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}
export JAVA_HOME=${JAVA_HOME:-$(/usr/libexec/java_home -v 21)}
ADB="$ANDROID_HOME/platform-tools/adb"
EMULATOR="$ANDROID_HOME/emulator/emulator"
AVDMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
IMAGE="system-images;android-35;google_apis;arm64-v8a"
APP=tech.jensk.synclet
WORK=$(mktemp -d)
STACK_PID=
EMU_PID=
SERIAL=

stop_emulator() {
  if [ -n "$SERIAL" ]; then "$ADB" -s "$SERIAL" emu kill >/dev/null 2>&1 || true; fi
  if [ -n "$EMU_PID" ]; then
    for _ in $(seq 1 20); do kill -0 "$EMU_PID" 2>/dev/null || break; sleep 1; done
    # Exactly the emulator process this run started, and only while it is still running.
    if kill -0 "$EMU_PID" 2>/dev/null; then kill "$EMU_PID" 2>/dev/null || true; fi
  fi
  EMU_PID=; SERIAL=
}
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  stop_emulator
  if [ -n "$STACK_PID" ]; then kill -TERM "$STACK_PID" 2>/dev/null || true; wait "$STACK_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
fail() { echo "FAIL: $*" >&2; exit 1; }

(cd "$ROOT/apps/site" && STORE_PLATFORM=android exec node scripts/store-stack.ts "$WORK/ready.json") &
STACK_PID=$!
for _ in $(seq 1 600); do [ -s "$WORK/ready.json" ] && break; kill -0 "$STACK_PID" 2>/dev/null || exit 1; sleep 1; done
[ -s "$WORK/ready.json" ] || fail "sample stack not ready"
# The emulator reaches the host's loopback as 10.0.2.2.
SERVER=$(jq -r .base "$WORK/ready.json" | sed -e 's#//localhost:#//10.0.2.2:#' -e 's#//127\.0\.0\.1:#//10.0.2.2:#')
TOKEN=$(jq -r .token "$WORK/ready.json")

cd "$ROOT/apps/android"
[ -f local.properties ] || echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew -q :app:assembleDebug :app:assembleDebugAndroidTest

# start_emulator <avd> <device profile>
start_emulator() {
  [ -d "$ANDROID_HOME/system-images/android-35/google_apis/arm64-v8a" ] || fail "system image missing: sdkmanager \"$IMAGE\""
  if ! "$EMULATOR" -list-avds | grep -qx "$1"; then
    echo "== creating AVD $1 ($2)"
    echo no | "$AVDMANAGER" create avd -n "$1" -k "$IMAGE" -d "$2" >/dev/null
  fi
  # A console port no other emulator (and nothing else) uses; adb finds emulators on 5554–5585.
  local port=5570
  while "$ADB" devices | grep -q "emulator-$port" || nc -z localhost "$port" >/dev/null 2>&1 || nc -z localhost $((port + 1)) >/dev/null 2>&1; do
    port=$((port + 2))
  done
  [ "$port" -le 5584 ] || fail "no free emulator port in 5570–5584"
  SERIAL=emulator-$port
  # -read-only: the AVD's own data stays untouched, every run boots a fresh device.
  "$EMULATOR" -avd "$1" -port "$port" -no-window -no-audio -no-boot-anim -no-snapshot -read-only \
    -gpu swiftshader_indirect >"$WORK/emulator-$1.log" 2>&1 &
  EMU_PID=$!
  echo "== booting $1 as $SERIAL"
  local booted=""
  for _ in $(seq 1 180); do
    kill -0 "$EMU_PID" 2>/dev/null || { tail -n 30 "$WORK/emulator-$1.log" >&2; fail "emulator exited during boot"; }
    if [ "$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1 ]; then booted=1; break; fi
    sleep 2
  done
  [ -n "$booted" ] || fail "emulator did not boot within 6 minutes"
  for s in window_animation_scale transition_animation_scale animator_duration_scale; do
    "$ADB" -s "$SERIAL" shell settings put global "$s" 0
  done
}

# Status bar in SystemUI's demo mode.
demo_status_bar() {
  local a=("$ADB" -s "$SERIAL" shell)
  # SystemUI ignores demo commands until it has started (some time after boot_completed).
  for _ in $(seq 1 30); do [ -n "$("${a[@]}" pidof com.android.systemui | tr -d '\r')" ] && break; sleep 1; done
  sleep 10
  "${a[@]}" settings put global sysui_demo_allowed 1
  sleep 2
  "${a[@]}" am broadcast -a com.android.systemui.demo -e command enter >/dev/null
  "${a[@]}" am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941 >/dev/null
  "${a[@]}" am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false >/dev/null
  "${a[@]}" am broadcast -a com.android.systemui.demo -e command network -e wifi show -e level 4 >/dev/null
  "${a[@]}" am broadcast -a com.android.systemui.demo -e command network -e mobile show -e datatype none -e level 4 >/dev/null
  "${a[@]}" am broadcast -a com.android.systemui.demo -e command notifications -e visible false >/dev/null
}

DEVICES=${STORE_DEVICES:-phone tablet}
for device in $DEVICES; do
  case "$device" in
    phone) start_emulator SyncletPixel pixel_7 ;;
    tablet) start_emulator SyncletTablet pixel_tablet ;;
    *) fail "unknown device $device (phone, tablet)" ;;
  esac
  "$ADB" -s "$SERIAL" install -r -g app/build/outputs/apk/debug/app-debug.apk >/dev/null
  "$ADB" -s "$SERIAL" install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk >/dev/null
  if [ "$device" = tablet ]; then
    "$ADB" -s "$SERIAL" shell settings put system accelerometer_rotation 0
    "$ADB" -s "$SERIAL" shell settings put system user_rotation 0       # the Pixel Tablet's natural orientation is landscape
  fi
  for pair in en:en-US de:de-DE; do
    lang=${pair%%:*}; locale=${pair#*:}
    dir="$OUT/$device-$lang"
    rm -rf "$dir"; mkdir -p "$dir"
    "$ADB" -s "$SERIAL" shell pm clear "$APP" >/dev/null
    "$ADB" -s "$SERIAL" shell cmd locale set-app-locales "$APP" --locales "$locale"
    echo "== $device $lang"
    demo_status_bar                                                    # right before the run: SystemUI is up by now
    "$ADB" -s "$SERIAL" shell am instrument -w -r -e class tech.jensk.synclet.live.StoreScreenshotsTest -e storeShots 1 \
      -e syncletServer "$SERVER" -e syncletToken "$TOKEN" "$APP.test/androidx.test.runner.AndroidJUnitRunner" > "$dir.log" 2>&1 || true
    grep -q "^OK (1 test)" "$dir.log" || { grep -E "Error|Exception|FAILURES|OK \(" "$dir.log" | head -20 >&2; fail "$device $lang: test failed (log: $dir.log)"; }
    "$ADB" -s "$SERIAL" pull "/sdcard/Android/data/$APP/files/store-shots/." "$dir" >/dev/null
    echo "   $(ls "$dir" | wc -l | tr -d ' ') screenshots → ${dir#"$ROOT"/}"
  done
  stop_emulator
done
echo "== done: ${OUT#"$ROOT"/}"
