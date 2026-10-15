#!/usr/bin/env bash
# Proves the core promise: Synclet writes exactly the visible structure into the folder
# and nothing else; external changes keep IDs; removing the stack leaves a normal folder.
set -euo pipefail
command -v jq >/dev/null || { echo "FAIL: jq is required"; exit 2; }
command -v docker >/dev/null || { echo "FAIL: docker is required"; exit 2; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORT=${SYNCLET_THROWAWAY_PORT:-18080}
TLS_PORT=${SYNCLET_THROWAWAY_TLS_PORT:-18443}
PROJECT=synclet-throwaway-$$
WORK=$(mktemp -d)
FILES="$WORK/files"; META="$WORK/meta"
NFD_NAME=$(printf 'Cafe\xcc\x81.txt')   # NFD name as created by macOS
mkdir -p "$FILES/jens/Bestand/Unterordner" "$META"
printf 'alt' > "$FILES/jens/Bestand/alt.txt"
printf 'nfd' > "$FILES/jens/Bestand/$NFD_NAME"
ENV="$WORK/.env"
# Low scan interval: on macOS Docker Desktop host FS events may reach the container late or not
# at all, so the periodic scan is the fallback that makes the external move visible.
cat > "$ENV" <<EOF
SYNCLET_DATA=$FILES
SYNCLET_META=$META
PUID=$(id -u)
PGID=$(id -g)
POSTGRES_PASSWORD=throwaway
SYNCLET_PORT=$PORT
SYNCLET_TLS_PORT=$TLS_PORT
SYNCLET_SITE_ADDRESS=:80
SYNCLET_SCAN_INTERVAL=${SYNCLET_THROWAWAY_SCAN_INTERVAL:-10}
EOF
DC=(docker compose -p "$PROJECT" -f "$ROOT/deploy/compose.yml" --env-file "$ENV")
STARTED=0
cleanup() {
  local rc=$?
  if [ "$rc" -ne 0 ] && [ "$STARTED" = 1 ]; then "${DC[@]}" logs --tail 80 server 2>/dev/null || true; fi
  "${DC[@]}" down -v >/dev/null 2>&1 || true
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

STARTED=1
"${DC[@]}" up -d --build
for i in $(seq 1 60); do curl -fs "localhost:$PORT/api/health" >/dev/null && break; sleep 2; done
curl -fs "localhost:$PORT/api/health" >/dev/null || fail "stack did not become healthy"

B=http://localhost:$PORT/api
TOKEN=$(curl -fsS -XPOST "$B/setup" -H 'content-type: application/json' \
  -d '{"username":"jens","displayName":"Jens","password":"correct horse battery"}' | jq -r .accessToken)
[ -n "$TOKEN" ] && [ "$TOKEN" != null ] || fail "setup returned no access token"
H=(-H "authorization: Bearer $TOKEN")
api() { curl -fsS "${H[@]}" "$@"; }

# poll <description> <command...>: retries the command (which must print a non-empty value)
# for up to 60 s and echoes its output.
poll() {
  local what=$1; shift
  local out
  for i in $(seq 1 60); do
    out=$("$@" 2>/dev/null || true)
    if [ -n "$out" ]; then echo "$out"; return 0; fi
    sleep 1
  done
  fail "timed out waiting for $what"
}
# External (non-API) move. On Linux this is a plain host `mv`. Docker Desktop on macOS hands out
# synthetic inode numbers per path on bind mounts, so a rename done on the macOS host shows up in the
# container as a new inode and move detection (dev+ino) cannot work there; the rename is then done
# by another process inside the Docker VM, i.e. on the same file system the server sees – exactly
# what a host `mv` is on a Linux server. SYNCLET_THROWAWAY_HOST_MV=1 forces the host `mv`.
ext_mv() {
  if [ "$(uname -s)" = Darwin ] && [ "${SYNCLET_THROWAWAY_HOST_MV:-0}" != 1 ]; then
    docker run --rm --user "$(id -u):$(id -g)" --entrypoint mv -v "$FILES:/d" synclet/server:dev "/d/$1" "/d/$2"
  else
    mv "$FILES/$1" "$FILES/$2"
  fi
}
child_id() { api "$B/sync/v1/items/$1/children" | jq -r --arg n "$2" '.items[] | select(.name==$n) | .id'; }

# 0) The pre-existing folder is adopted (initial scan after setup).
ALT=$(poll "initial scan of the existing folder" child_id root Bestand)

# 1) API writes land 1:1 on disk.
DOCS=$(api -XPOST "$B/sync/v1/items" -H 'content-type: application/json' -d '{"parentId":"root","type":"folder","name":"Dokumente"}' | jq -r .id)
F=$(api -XPOST "$B/sync/v1/items/upload?parentId=$DOCS&name=Angebot%20%C3%BC.txt" -H 'content-type: application/octet-stream' --data-binary 'hallo' | jq -r .id)
api -XPATCH "$B/sync/v1/items/$F" -H 'content-type: application/json' -d '{"name":"Angebot final.txt"}' >/dev/null
TMPF=$(api -XPOST "$B/sync/v1/items/upload?parentId=root&name=weg.txt" -H 'content-type: application/octet-stream' --data-binary 'x' | jq -r .id)
api -XDELETE "$B/sync/v1/items/$TMPF" >/dev/null

# 2) External move keeps the ID.
ALT_FILE=$(poll "alt.txt to be indexed" child_id "$ALT" alt.txt)
[ -d "$FILES/jens/Dokumente" ] || fail "API-created folder missing on disk"
ext_mv jens/Bestand/alt.txt jens/Dokumente/alt-verschoben.txt
MOVED=$(poll "external move to be detected" child_id "$DOCS" alt-verschoben.txt)
[ "$MOVED" = "$ALT_FILE" ] || fail "ID changed on external move ($ALT_FILE -> $MOVED)"
[ -z "$(child_id "$ALT" alt.txt)" ] || fail "moved file still listed at its old place"

# 3) NFD name from disk is listed and downloadable.
NFD=$(api "$B/sync/v1/items/$ALT/children" | jq -r '.items[] | select(.type=="file") | .id' | head -1)
[ -n "$NFD" ] || fail "NFD file not listed"
[ "$(api "$B/sync/v1/items/$NFD/content")" = "nfd" ] || fail "NFD file not served"

# 4) Nothing but user content in the data folder: trash staging (.synclet-trash-*) is moved to
#    /meta after commit, temp files (.synclet-tmp-*) never outlive a request.
leftovers() { (cd "$FILES" && find . -name '.synclet-*'); }
for i in $(seq 1 30); do [ -z "$(leftovers)" ] && break; sleep 1; done
[ -z "$(leftovers)" ] || fail "synclet entries left in the data folder: $(leftovers)"

# 5) Tear down and compare the folder with the expected tree.
"${DC[@]}" down -v
STARTED=0
[ -z "$(leftovers)" ] || fail "synclet entries left in the data folder after teardown: $(leftovers)"
ACTUAL=$(cd "$FILES" && find . -mindepth 1 | LC_ALL=C sort)
EXPECTED=$(printf '%s\n' ./jens ./jens/Bestand "./jens/Bestand/$NFD_NAME" ./jens/Bestand/Unterordner \
  ./jens/Dokumente "./jens/Dokumente/Angebot final.txt" ./jens/Dokumente/alt-verschoben.txt | LC_ALL=C sort)
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "FAIL: folder differs"; diff <(echo "$EXPECTED") <(echo "$ACTUAL"); exit 1
fi
[ "$(cat "$FILES/jens/Dokumente/Angebot final.txt")" = "hallo" ] || fail "content"
[ "$(cat "$FILES/jens/Dokumente/alt-verschoben.txt")" = "alt" ] || fail "moved file content"
ls "$META/trash"/*/weg.txt >/dev/null || fail "deleted file not in /meta/trash"
echo "PASS: folder is a plain 1:1 copy of what Synclet showed, metadata stayed outside"
