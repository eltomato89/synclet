#!/usr/bin/env bash
# Archives the iOS app (Release, generic iOS device) and exports an App Store Connect build
# (ExportOptions.plist: method app-store-connect, team JC32M95WLZ, automatic signing).
#
#   cd apps/ios && ./build_archive.sh
#
# Result: build/Synclet.xcarchive and build/export/Synclet.ipa (upload with Xcode's Organizer
# or Transporter). Needs an "Apple Distribution" certificate of the team in the keychain;
# without it the script stops (exit 2) before archiving.
set -euo pipefail
cd "$(dirname "$0")"

# Captured first: `grep -q` closing the pipe early must not fail `security` under pipefail.
IDENTITIES=$(security find-identity -v -p codesigning)
if ! grep -q "Apple Distribution" <<<"$IDENTITIES"; then
  echo "Kein Apple-Distribution-Zertifikat – in Xcode → Settings → Accounts anlegen" >&2
  exit 2
fi

xcodegen generate
rm -rf build/Synclet.xcarchive build/export
xcodebuild archive -scheme Synclet -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/Synclet.xcarchive -allowProvisioningUpdates
xcodebuild -exportArchive -archivePath build/Synclet.xcarchive -exportOptionsPlist ExportOptions.plist \
  -exportPath build/export -allowProvisioningUpdates
echo "== exported: $(pwd)/build/export"
