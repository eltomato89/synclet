#!/usr/bin/env bash
# Builds the notarized Synclet DMG for direct distribution:
#   xcodegen → xcodebuild archive (Release) → export with Developer ID (ExportOptions.plist,
#   team JC32M95WLZ) → notarize + staple the app → DMG (background, Applications link, volume
#   icon) → sign, notarize + staple the DMG → build/Synclet-<version>.dmg
#
# One-time setup on the build Mac (see README.md, "Signing and notarization"):
#   - a "Developer ID Application" certificate of team JC32M95WLZ in the login keychain
#   - xcrun notarytool store-credentials synclet-notary --apple-id <id> --team-id JC32M95WLZ
#
# Env: SYNCLET_SKIP_NOTARIZE=1 builds build/Synclet-<version>-unnotarized.dmg without the notary
# steps (local testing only: Gatekeeper rejects it on other Macs). The DMG window layout uses
# Finder via AppleScript (needs an unlocked GUI session); without it the DMG still works, the
# script warns that the background could not be applied.
set -euo pipefail
cd "$(dirname "$0")"
HERE=$(pwd)
TEAM=JC32M95WLZ
PROFILE=synclet-notary
BUILD="$HERE/build"
ARCHIVE="$BUILD/Synclet.xcarchive"
EXPORT="$BUILD/export"
SKIP_NOTARIZE=${SYNCLET_SKIP_NOTARIZE:-0}

step() { printf '\n== %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit "${2:-1}"; }
for tool in xcodegen xcodebuild hdiutil ditto codesign; do
  command -v "$tool" >/dev/null || fail "$tool is required"
done

notary_profile_ok() { xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; }
notary_missing() {
  fail "notary profile '$PROFILE' is missing in the keychain – notarization is not possible.
       One-time setup (an app-specific password from appleid.apple.com):
         xcrun notarytool store-credentials $PROFILE --apple-id <your Apple ID> --team-id $TEAM
       Then run this script again. (SYNCLET_SKIP_NOTARIZE=1 builds an unnotarized DMG for local tests.)" 3
}
# Fail fast: without the notary profile there is no point in archiving and exporting first.
if [ "$SKIP_NOTARIZE" != 1 ]; then
  notary_profile_ok || notary_missing
fi

# notarize <file>: submits and waits; prints the log on rejection.
notarize() {
  local file=$1 out id status
  out=$(xcrun notarytool submit "$file" --keychain-profile "$PROFILE" --wait --output-format json) \
    || fail "notarytool submit failed for $(basename "$file"): $out"
  id=$(/usr/bin/plutil -extract id raw -o - - <<<"$out" 2>/dev/null || true)
  status=$(/usr/bin/plutil -extract status raw -o - - <<<"$out" 2>/dev/null || true)
  echo "notarytool: $(basename "$file") → ${status:-?} (submission ${id:-?})"
  if [ "$status" != "Accepted" ]; then
    [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$PROFILE" >&2 || true
    fail "notarization of $(basename "$file") was not accepted (status '${status:-unknown}')"
  fi
}

step "xcodegen generate"
xcodegen generate --quiet

step "xcodebuild archive (Release)"
rm -rf "$ARCHIVE" "$EXPORT"
mkdir -p "$BUILD"
xcodebuild archive -project Synclet.xcodeproj -scheme Synclet -configuration Release \
  -destination 'generic/platform=macOS' -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$TEAM" -quiet \
  || fail "archive failed"
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ARCHIVE/Products/Applications/Synclet.app/Contents/Info.plist")
echo "version $VERSION"

step "export with Developer ID (team $TEAM)"
if ! security find-identity -v -p codesigning | grep -q "Developer ID Application:.*($TEAM)"; then
  echo "NOTE: no local 'Developer ID Application ($TEAM)' identity; the export relies on Xcode's cloud signing" >&2
  echo "      (an Xcode account with Admin/Account Holder role in Settings → Accounts)." >&2
fi
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$EXPORT" \
  -exportOptionsPlist "$HERE/ExportOptions.plist" -allowProvisioningUpdates \
  || fail "Developer ID export failed – a 'Developer ID Application' certificate of team $TEAM (and Developer ID
       provisioning profiles for tech.jensk.synclet.mac and tech.jensk.synclet.mac.fileprovider with the
       app group and keychain group) are required; see README.md, \"Signing and notarization\""
APP="$EXPORT/Synclet.app"
codesign --verify --deep --strict --verbose=2 "$APP"
AUTHORITY=$(codesign -dvv "$APP" 2>&1 | sed -n 's/^Authority=//p' | head -1)
echo "signed by: $AUTHORITY"
case "$AUTHORITY" in "Developer ID Application:"*"($TEAM)") ;; *) fail "the exported app is not signed with Developer ID ($AUTHORITY)";; esac

DMG_NAME="Synclet-$VERSION.dmg"
if [ "$SKIP_NOTARIZE" = 1 ]; then
  echo "SYNCLET_SKIP_NOTARIZE=1: skipping notarization (not for distribution)"
  DMG_NAME="Synclet-$VERSION-unnotarized.dmg"
else
  step "notarize the app"
  notary_profile_ok || notary_missing
  ditto -c -k --keepParent "$APP" "$BUILD/Synclet-notarize.zip"
  notarize "$BUILD/Synclet-notarize.zip"
  rm -f "$BUILD/Synclet-notarize.zip"
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
fi

step "DMG"
VOLNAME="Synclet"
[ -e "/Volumes/$VOLNAME" ] && fail "a volume named '$VOLNAME' is mounted – eject it first (the Finder layout addresses the disk by name)"
STAGE=$(mktemp -d)
RW="$BUILD/Synclet-rw.dmg"
DMG="$BUILD/$DMG_NAME"
MOUNT=""
cleanup() {
  [ -n "$MOUNT" ] && hdiutil detach "$MOUNT" -quiet -force >/dev/null 2>&1 || true
  rm -rf "$STAGE" "$RW"
}
trap cleanup EXIT
ditto "$APP" "$STAGE/Synclet.app"
ln -s /Applications "$STAGE/Applications"
mkdir "$STAGE/.background"
tiffutil -cathidpicheck dmg/background.png dmg/background@2x.png -out "$STAGE/.background/background.tiff" >/dev/null 2>&1
rm -f "$RW" "$DMG"
hdiutil create -srcfolder "$STAGE" -volname "$VOLNAME" -fs HFS+ -format UDRW -ov "$RW" -quiet
MOUNT=$(hdiutil attach "$RW" -readwrite -noverify -noautoopen | sed -n 's#^/dev/[^[:space:]]*[[:space:]]*Apple_HFS[[:space:]]*##p' | head -1)
[ -d "$MOUNT" ] || fail "could not mount the DMG"
# Window layout: 660×400, icons 128 pt, app left, Applications right, background picture.
# Best effort with a 60 s limit (Finder automation needs an unlocked GUI session and the
# Automation permission for the terminal).
if ! perl -e 'alarm shift; exec @ARGV' 60 osascript <<OSA
tell application "Finder"
  tell disk "$VOLNAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 120, 860, 520}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 128
    set text size of opts to 13
    set background picture of opts to file ".background:background.tiff"
    set position of item "Synclet.app" of container window to {170, 190}
    set position of item "Applications" of container window to {490, 190}
    update without registering applications
    delay 1
    close
  end tell
end tell
OSA
then
  echo "WARNING: Finder layout not applied (locked screen or no Automation permission) – the DMG works, but without background/positions" >&2
fi
# Volume icon after the Finder step (Finder drops .VolumeIcon.icns and the custom-icon flag when
# it rewrites the window settings).
cp dmg/VolumeIcon.icns "$MOUNT/.VolumeIcon.icns"
xcrun SetFile -a C "$MOUNT"
rm -rf "$MOUNT/.fseventsd"
chmod -Rf go-w "$MOUNT" || true
sync
hdiutil detach "$MOUNT" -quiet
MOUNT=""
hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$DMG" -quiet

# Xcode's cloud signing only signs the exported app; a disk image can only be signed with a local
# identity. Without one the DMG stays unsigned – the app inside is Developer ID signed and the
# DMG's notarization ticket is stapled, which is what Gatekeeper checks for downloaded images.
DMG_SIGNED=0
if security find-identity -v -p codesigning | grep -qF "$AUTHORITY"; then
  codesign --sign "$AUTHORITY" --timestamp "$DMG"
  DMG_SIGNED=1
else
  echo "NOTE: no local '$AUTHORITY' identity – the DMG itself stays unsigned (the app inside is signed)" >&2
fi
if [ "$SKIP_NOTARIZE" != 1 ]; then
  step "notarize the DMG"
  notarize "$DMG"
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  if [ "$DMG_SIGNED" = 1 ]; then
    spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
  fi
fi
step "done"
echo "$DMG"
