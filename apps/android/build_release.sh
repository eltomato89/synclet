#!/usr/bin/env bash
# Signed release build of the Android app: Synclet.apk (GitHub release asset) and Synclet.aab (Google Play).
#
#   apps/android/build_release.sh 0.1.6                    # build + verify only
#   apps/android/build_release.sh 0.1.6 --github v0.1.6    # also attach Synclet.apk to that GitHub release
#   apps/android/build_release.sh 0.1.6 --play             # also upload the AAB to the internal test track
#
# Signing: keystore.properties next to this script (see keystore.properties.example) or SYNCLET_KEYSTORE_FILE,
# SYNCLET_KEYSTORE_PASSWORD, SYNCLET_KEY_ALIAS, SYNCLET_KEY_PASSWORD. Play: SYNCLET_PLAY_CREDENTIALS or
# playCredentials in keystore.properties (service account JSON outside the repo). The very first AAB must be
# uploaded by hand in the Play Console.
# versionCode = UTC yyDDDHHmm (e.g. 262891230): grows monotonically and stays below Play's limit 2100000000.
set -euo pipefail
cd "$(dirname "$0")"

VERSION=${1:-}
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || { echo "usage: $0 <version> [--github <tag>] [--play]" >&2; exit 2; }
shift
GITHUB_TAG=""; PLAY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --github) GITHUB_TAG=${2:?--github needs a tag}; shift 2 ;;
    --play) PLAY=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

export ANDROID_HOME=${ANDROID_HOME:-$HOME/Library/Android/sdk}
export JAVA_HOME=${JAVA_HOME:-$(/usr/libexec/java_home -v 21)}
# Prerequisites, checked before any build. Relative paths resolve against apps/android (this script's directory).
prop() { [ -f keystore.properties ] && sed -n "s/^$1[[:space:]]*=[[:space:]]*//p" keystore.properties | tail -1 || true; }
STORE=${SYNCLET_KEYSTORE_FILE:-$(prop storeFile)}
STORE_PW=${SYNCLET_KEYSTORE_PASSWORD:-$(prop storePassword)}
KEY_ALIAS=${SYNCLET_KEY_ALIAS:-$(prop keyAlias)}
KEY_PW=${SYNCLET_KEY_PASSWORD:-$(prop keyPassword)}
if [ -z "$STORE" ]; then
  echo "No upload keystore: create keystore.properties (see keystore.properties.example) or set SYNCLET_KEYSTORE_FILE." >&2
  exit 2
fi
[ -f "$STORE" ] || { echo "Keystore file not found: $STORE (relative paths resolve against apps/android)." >&2; exit 2; }
[ -n "$STORE_PW" ] && [ -n "$KEY_ALIAS" ] && [ -n "$KEY_PW" ] || {
  echo "Incomplete signing config: storePassword/keyAlias/keyPassword (or SYNCLET_KEYSTORE_PASSWORD, SYNCLET_KEY_ALIAS, SYNCLET_KEY_PASSWORD) must all be set." >&2
  exit 2
}
if [ -n "$GITHUB_TAG" ]; then
  command -v gh >/dev/null || { echo "gh is required for --github." >&2; exit 2; }
  gh release view "$GITHUB_TAG" >/dev/null 2>&1 || { echo "GitHub release $GITHUB_TAG not found (create it first)." >&2; exit 2; }
fi
if [ "$PLAY" = 1 ]; then
  PLAY_CREDS=${SYNCLET_PLAY_CREDENTIALS:-$(prop playCredentials)}
  { [ -n "$PLAY_CREDS" ] && [ -f "$PLAY_CREDS" ] && [ -r "$PLAY_CREDS" ]; } || {
    echo "--play needs readable Play credentials: set SYNCLET_PLAY_CREDENTIALS or playCredentials in keystore.properties (service account JSON; relative paths resolve against apps/android)." >&2
    exit 2
  }
fi

CODE=$(date -u +%y%j%H%M)
PROPS=(-PsyncletVersionName="$VERSION" -PsyncletVersionCode="$CODE")
echo "== Synclet $VERSION (versionCode $CODE)"
./gradlew --no-configuration-cache "${PROPS[@]}" :app:clean :app:assembleRelease :app:bundleRelease

APK=app/build/outputs/apk/release/app-release.apk
AAB=app/build/outputs/bundle/release/app-release.aab
[ -f "$APK" ] || { echo "FAIL: $APK missing (unsigned build? check the keystore settings)" >&2; exit 1; }
BUILD_TOOLS=$(ls "$ANDROID_HOME/build-tools" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
CERTS=$("$ANDROID_HOME/build-tools/$BUILD_TOOLS/apksigner" verify --print-certs "$APK")
echo "$CERTS" | grep "certificate DN"
if echo "$CERTS" | grep -q "CN=Android Debug"; then echo "FAIL: signed with the debug key" >&2; exit 1; fi
JARSIGN=$("$JAVA_HOME/bin/jarsigner" -verify -J-Duser.language=en "$AAB" 2>&1 || true)
grep -q "jar verified." <<<"$JARSIGN" || { echo "FAIL: $AAB is not signed" >&2; exit 1; }

mkdir -p build/release
cp "$APK" build/release/Synclet.apk
cp "$AAB" build/release/Synclet.aab
echo "== build/release/Synclet.apk and Synclet.aab"

if [ -n "$GITHUB_TAG" ]; then
  gh release upload "$GITHUB_TAG" build/release/Synclet.apk --clobber
  echo "== attached Synclet.apk to $GITHUB_TAG"
fi
if [ "$PLAY" = 1 ]; then
  ./gradlew --no-configuration-cache "${PROPS[@]}" :app:publishReleaseBundle
  echo "== uploaded to the internal test track"
fi
