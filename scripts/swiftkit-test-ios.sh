#!/usr/bin/env bash
# Runs the SyncletKit tests on a private iOS simulator and deletes it afterwards.
# IOS_DEVICE overrides the simulator device type (default "iPhone 18 Pro").
set -euo pipefail
cd "$(dirname "$0")/../apps/apple/SyncletKit"
NAME="synclet-kit-$$"
UDID=$(xcrun simctl create "$NAME" "${IOS_DEVICE:-iPhone 18 Pro}")
trap 'xcrun simctl delete "$UDID" >/dev/null 2>&1 || true' EXIT
xcodebuild test -scheme SyncletKit -destination "id=$UDID" -derivedDataPath "${DERIVED:-.build/ios-dd}" 2>&1 | tail -n 25
exit "${PIPESTATUS[0]}"
