#!/usr/bin/env bash
# Attaches Synclet.dmg to a GitHub release by carrying it over from the newest older release that has one,
# as long as the macOS app (apps/macos, apps/apple; Markdown ignored) is unchanged between the two tags.
# The website and README link to releases/latest/download/Synclet.dmg, so every release needs that asset.
#
#   apps/macos/attach_release_dmg.sh v0.1.9            # attach (needs gh with write access)
#   apps/macos/attach_release_dmg.sh v0.1.9 --dry-run  # only report what would happen
#
# A notarized DMG cannot be built in CI (Developer ID signing runs through Xcode cloud signing on the build
# Mac). If the app changed, the script exits 1 with the steps for a local build_and_notarize.sh run.
set -euo pipefail
cd "$(dirname "$0")/../.."

TAG=${1:-}
[[ "$TAG" =~ ^v[0-9] ]] || { echo "usage: $0 <tag> [--dry-run]" >&2; exit 2; }
DRY=0; [ "${2:-}" = "--dry-run" ] && DRY=1
ASSET=Synclet.dmg

has_dmg() { gh release view "$1" --json assets -q '.assets[].name' | grep -qx "$ASSET"; }

if has_dmg "$TAG"; then echo "$TAG already has $ASSET"; exit 0; fi

# Releases newest first; the source is the first one after $TAG that has the DMG.
SRC=""; seen=0
while read -r t; do
  if [ "$t" = "$TAG" ]; then seen=1; continue; fi
  [ $seen = 1 ] && has_dmg "$t" && { SRC=$t; break; }
done < <(gh release list --limit 100 --exclude-drafts --json tagName -q '.[].tagName')
[ $seen = 1 ] || { echo "::error::release $TAG not found" >&2; exit 1; }

build_steps="Build and attach it on the build Mac:
  SYNCLET_NOTARY_PROFILE=<profile> apps/macos/build_and_notarize.sh
  cp apps/macos/build/Synclet-<version>.dmg apps/macos/build/$ASSET
  gh release upload $TAG apps/macos/build/$ASSET"
if [ -z "$SRC" ]; then
  echo "::error::no older release has $ASSET. $build_steps" >&2; exit 1
fi

git fetch --quiet --tags origin 2>/dev/null || true
if ! git diff --quiet "$SRC" "$TAG" -- apps/macos apps/apple ':(exclude)*.md'; then
  echo "::error::the macOS app changed between $SRC and $TAG, so the old DMG cannot be reused. $build_steps" >&2
  git diff --stat "$SRC" "$TAG" -- apps/macos apps/apple ':(exclude)*.md' >&2
  exit 1
fi

echo "macOS app unchanged since $SRC: carrying over its $ASSET"
[ $DRY = 1 ] && exit 0
dir=$(mktemp -d); trap 'rm -rf "$dir"' EXIT
gh release download "$SRC" -p "$ASSET" -D "$dir"
gh release upload "$TAG" "$dir/$ASSET"
echo "attached $ASSET to $TAG"
