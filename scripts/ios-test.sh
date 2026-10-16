#!/usr/bin/env bash
# Generates apps/ios/Synclet.xcodeproj and runs the app's unit tests (scheme Synclet) on a
# private iOS simulator that is deleted afterwards.
# IOS_DEVICE overrides the simulator device type (default "iPhone 18 Pro").
set -euo pipefail
cd "$(dirname "$0")/../apps/ios"
xcodegen generate --quiet
NAME="synclet-ios-$$"
UDID=$(xcrun simctl create "$NAME" "${IOS_DEVICE:-iPhone 18 Pro}")
trap 'xcrun simctl delete "$UDID" >/dev/null 2>&1 || true' EXIT
# No `simctl diagnose` on failures (it can hang for minutes).
LOG="${DERIVED:-.build/test-dd}.log"
mkdir -p "$(dirname "$LOG")"
set +e
xcodebuild test -scheme Synclet -destination "id=$UDID" -derivedDataPath "${DERIVED:-.build/test-dd}" \
    -collect-test-diagnostics never >"$LOG" 2>&1
STATUS=$?
set -e
# Failures and compile errors first, then the summary.
grep -E "error:|: failed|with [1-9][0-9]* failures" "$LOG" | head -n 60 || true
tail -n 15 "$LOG"
exit "$STATUS"
