#!/usr/bin/env bash
# Archives the iOS app (Release, generic iOS device) and exports an App Store Connect build
# (ExportOptions.plist: method app-store-connect, team JC32M95WLZ, automatic signing).
#
#   cd apps/ios && ./build_archive.sh            # build/export/Synclet.ipa
#   cd apps/ios && ./build_archive.sh --upload   # upload straight to App Store Connect (TestFlight)
#
# Signing: with -allowProvisioningUpdates Xcode signs with cloud-managed distribution certificates,
# so no local "Apple Distribution" certificate is needed, only an Xcode account of the team
# (Xcode → Settings → Accounts). Uploading uses that account too.
# The build number (CFBundleVersion) is a UTC timestamp, so every archive can be uploaded; the
# version shown to users is MARKETING_VERSION in project.yml.
set -euo pipefail
cd "$(dirname "$0")"

DESTINATION=export
if [ "${1:-}" = "--upload" ]; then DESTINATION=upload; fi
BUILD_NUMBER=$(date -u +%Y%m%d%H%M)

xcodegen generate
rm -rf build/Synclet.xcarchive build/export
xcodebuild archive -scheme Synclet -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/Synclet.xcarchive -allowProvisioningUpdates CURRENT_PROJECT_VERSION="$BUILD_NUMBER"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
OPTIONS="$TMP/ExportOptions.plist"
sed "s#<string>export</string>#<string>$DESTINATION</string>#" ExportOptions.plist > "$OPTIONS"
xcodebuild -exportArchive -archivePath build/Synclet.xcarchive -exportOptionsPlist "$OPTIONS" \
  -exportPath build/export -allowProvisioningUpdates
if [ "$DESTINATION" = upload ]; then
  echo "== uploaded build $BUILD_NUMBER; it shows up in TestFlight after processing"
else
  echo "== exported build $BUILD_NUMBER: $(pwd)/build/export"
fi
