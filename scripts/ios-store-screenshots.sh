#!/usr/bin/env bash
# App Store screenshots of the iOS app with the website's SAMPLE data:
#   iPhone 6.9" (iPhone 17 Pro Max, 1320 × 2868, portrait) and iPad 13" (iPad Pro 13-inch (M5),
#   2752 × 2064, landscape), in English and German, six scenes each (StoreScreenshotsUITests).
#
#   scripts/ios-store-screenshots.sh            # → apps/ios/build/store-screenshots/<device>-<lang>/
#   STORE_DEVICES=ipad scripts/ios-store-screenshots.sh   # only one device (iphone, ipad)
#
# Starts the website's throwaway stack (apps/site/scripts/store-stack.ts: own compose project,
# image tags and temp folders), builds the UI tests once and runs them on two private simulators
# (system language per run, status bar 9:41 / full bars / full battery). Removes only its own
# stack and simulators on exit. Needs Docker, xcodegen and the site's node_modules (pnpm install).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=$ROOT/apps/ios/build/store-screenshots
WORK=$(mktemp -d)
STACK_PID=
SIMS=()
# runtime <device type id>: the newest available iOS runtime that supports this device type.
runtime() {
  xcrun simctl list runtimes -j | jq -r --arg t "$1" \
    '[.runtimes[] | select(.platform == "iOS" and .isAvailable and any(.supportedDeviceTypes[]; .identifier == $t))] | last | .identifier // empty'
}

cleanup() {
  local rc=$?
  for udid in "${SIMS[@]:-}"; do
    [ -n "$udid" ] || continue
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
    # iOS 27 runtime: CoreSimulator may keep the File Provider's CloudStorage folder (see
    # ios-live-tests.sh); a leftover device is only reported.
    xcrun simctl delete "$udid" >/dev/null 2>&1 || echo "WARN: simulator $udid not deleted (xcrun simctl delete $udid)" >&2
  done
  if [ -n "$STACK_PID" ]; then kill -TERM "$STACK_PID" 2>/dev/null || true; wait "$STACK_PID" 2>/dev/null || true; fi
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

(cd "$ROOT/apps/site" && exec node scripts/store-stack.ts "$WORK/ready.json") &
STACK_PID=$!
for _ in $(seq 1 600); do [ -s "$WORK/ready.json" ] && break; kill -0 "$STACK_PID" 2>/dev/null || exit 1; sleep 1; done
[ -s "$WORK/ready.json" ] || { echo "FAIL: sample stack not ready" >&2; exit 1; }
SERVER=$(jq -r .base "$WORK/ready.json")
TOKEN=$(jq -r .token "$WORK/ready.json")

cd "$ROOT/apps/ios"
xcodegen generate --quiet
xcodebuild build-for-testing -scheme SyncletUITests -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath "$WORK/dd" -quiet

# boot <udid> <language> <locale>: (re)boot with that system language, then the status bar.
boot() {
  xcrun simctl shutdown "$1" >/dev/null 2>&1 || true
  xcrun simctl boot "$1"
  xcrun simctl spawn "$1" defaults write -g AppleLanguages -array "$2"
  xcrun simctl spawn "$1" defaults write -g AppleLocale "$3"
  xcrun simctl shutdown "$1"
  xcrun simctl boot "$1"
  xcrun simctl bootstatus "$1" -b >/dev/null
  xcrun simctl status_bar "$1" override --time 9:41 --dataNetwork wifi --wifiMode active --wifiBars 3 \
    --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
}

for device in "iphone:com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max" \
              "ipad:com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB"; do
  [[ " ${STORE_DEVICES:-iphone ipad} " == *" ${device%%:*} "* ]] || continue
  rt=$(runtime "${device#*:}")
  [ -n "$rt" ] || { echo "FAIL: no iOS runtime supports ${device#*:}" >&2; exit 1; }
  udid=$(xcrun simctl create "synclet-store-${device%%:*}-$$" "${device#*:}" "$rt")
  SIMS+=("$udid")
  for lang in en:en_US de:de_DE; do
    dir=$OUT/${device%%:*}-${lang%%:*}
    rm -rf "$dir" "$dir.xcresult" && mkdir -p "$dir"
    boot "$udid" "${lang%%:*}" "${lang#*:}"
    echo "== ${device%%:*} ${lang%%:*}"
    TEST_RUNNER_SYNCLET_UITEST_SERVER=$SERVER TEST_RUNNER_SYNCLET_UITEST_TOKEN=$TOKEN \
    TEST_RUNNER_SYNCLET_UITEST_SHOTS_DIR=$dir TEST_RUNNER_SYNCLET_UITEST_LANGUAGE=${lang%%:*} \
      xcodebuild test-without-building -scheme SyncletUITests -destination "id=$udid" -derivedDataPath "$WORK/dd" \
        -only-testing:SyncletUITests/StoreScreenshotsUITests -resultBundlePath "$dir.xcresult" > "$dir.log" 2>&1 \
      || { grep -E "error:|Test Case|EXECUTE" "$dir.log" >&2; echo "FAIL: see $dir.log" >&2; exit 1; }
  done
done
echo "== screenshots: $OUT"
