#!/usr/bin/env bash
# Proves the core promise: Synclet writes exactly the visible structure into the folder
# and nothing else; external changes keep IDs; removing the stack leaves a normal folder.
set -euo pipefail
command -v jq >/dev/null || { echo "FAIL: jq is required"; exit 2; }
command -v docker >/dev/null || { echo "FAIL: docker is required"; exit 2; }
command -v unzip >/dev/null || { echo "FAIL: unzip is required"; exit 2; }
command -v node >/dev/null || { echo "FAIL: node is required"; exit 2; }

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

# poll_for <seconds> <description> <command...>: retries the command (which must print a non-empty
# value) for up to <seconds> and echoes its output. poll = poll_for 60.
poll_for() {
  local secs=$1 what=$2; shift 2
  local out
  for i in $(seq 1 "$secs"); do
    out=$("$@" 2>/dev/null || true)
    if [ -n "$out" ]; then echo "$out"; return 0; fi
    sleep 1
  done
  fail "timed out waiting for $what"
}
poll() { poll_for 60 "$@"; }
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

# 3a) Trash: a deleted folder is restored with the IDs of its whole subtree.
mkfolder() { api -XPOST "$B/sync/v1/items" -H 'content-type: application/json' -d "{\"parentId\":\"$1\",\"type\":\"folder\",\"name\":\"$2\"}" | jq -r .id; }
upload() { api -XPOST "$B/sync/v1/items/upload?parentId=$1&name=$2" -H 'content-type: application/octet-stream' --data-binary "$3" | jq -r .id; }
ARCH=$(mkfolder root Archiv)
ARCH_SUB=$(mkfolder "$ARCH" Alt)
ARCH_F=$(upload "$ARCH" liste.txt 'liste')
ARCH_SUB_F=$(upload "$ARCH_SUB" tief.txt 'tief')
api -XDELETE "$B/sync/v1/items/$ARCH" >/dev/null
[ ! -e "$FILES/jens/Archiv" ] || fail "deleted folder still on disk"
[ -z "$(child_id root Archiv)" ] || fail "deleted folder still listed"
ENTRY=$(api "$B/trash" | jq -r --arg id "$ARCH" '.[] | select(.itemId==$id) | .id')
[ -n "$ENTRY" ] || fail "deleted folder not in the trash"
RESTORED=$(api -XPOST "$B/trash/$ENTRY/restore" | jq -r .item.id)
[ "$RESTORED" = "$ARCH" ] || fail "restored folder got a new ID ($ARCH -> $RESTORED)"
[ "$(child_id root Archiv)" = "$ARCH" ] || fail "restored folder not listed with its ID"
[ "$(child_id "$ARCH" Alt)" = "$ARCH_SUB" ] || fail "restored subfolder got a new ID"
[ "$(child_id "$ARCH" liste.txt)" = "$ARCH_F" ] || fail "restored file got a new ID"
[ "$(child_id "$ARCH_SUB" tief.txt)" = "$ARCH_SUB_F" ] || fail "restored nested file got a new ID"
[ "$(cat "$FILES/jens/Archiv/Alt/tief.txt")" = tief ] || fail "restored content missing on disk"
[ -z "$(api "$B/trash" | jq -r --arg id "$ARCH" '.[] | select(.itemId==$id) | .id')" ] || fail "restored folder still in the trash"

# 3b) Password-protected folder share: anonymous info, ZIP of the whole folder, external upload.
SHARE_URL=$(api -XPOST "$B/shares" -H 'content-type: application/json' \
  -d "{\"itemId\":\"$ARCH\",\"password\":\"geheim-123\",\"allowUpload\":true}" | jq -r .url)
STOKEN=${SHARE_URL##*/s/}
[ -n "$STOKEN" ] && [ "$STOKEN" != "$SHARE_URL" ] || fail "share link has no token: $SHARE_URL"
P=$B/public/shares/$STOKEN
JAR="$WORK/share-cookies"
[ "$(curl -s "$P" | jq -r .code)" = share_password_required ] || fail "protected share readable without password"
curl -fsS -c "$JAR" -XPOST "$P/unlock" -H 'content-type: application/json' -d '{"password":"geheim-123"}' >/dev/null || fail "unlock failed"
INFO=$(curl -fsS -b "$JAR" "$P")
[ "$(jq -r '.name + "|" + .type + "|" + .ownerDisplayName + "|" + (.allowUpload|tostring)' <<<"$INFO")" = "Archiv|folder|Jens|true" ] \
  || fail "unexpected share info: $INFO"
curl -fsS -b "$JAR" -o "$WORK/share.zip" "$P/zip" || fail "ZIP download failed"
ZIP_NAMES=$(unzip -Z1 "$WORK/share.zip" | sed 's#/$##' | LC_ALL=C sort)
[ "$ZIP_NAMES" = "$(printf '%s\n' Alt Alt/tief.txt liste.txt)" ] || fail "ZIP lists: $ZIP_NAMES"
[ "$(unzip -p "$WORK/share.zip" Alt/tief.txt)" = tief ] || fail "ZIP content"
EXT=$(curl -fsS -b "$JAR" -XPOST "$P/upload?name=extern.txt" -H 'content-type: application/octet-stream' --data-binary 'von aussen' | jq -r .id)
[ -n "$EXT" ] && [ "$EXT" != null ] || fail "external upload failed"
[ "$(cat "$FILES/jens/Archiv/extern.txt" 2>/dev/null)" = "von aussen" ] || fail "external upload not on disk"
[ "$(child_id "$ARCH" extern.txt)" = "$EXT" ] || fail "external upload not listed for the owner"

# 3c) Derivatives: the worker (read-only /data) produces thumbnails for jpg/heic/pdf/mp4 and
#     extracts the text of the pdf for search.
FX=$ROOT/apps/server/test/fixtures
MEDIA=$(mkfolder root Medien)
node -e '
  const [file, text] = process.argv.slice(1);
  const stream = `BT /F1 12 Tf 20 50 Td (${text}) Tj ET`;
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let pdf = "%PDF-1.4\n"; const off = [];
  objs.forEach((o, i) => { off.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  require("node:fs").writeFileSync(file, pdf, "latin1");
' "$WORK/rechnung.pdf" "Rechnung Zitronenfalter 2026"
JPG=$(upload "$MEDIA" foto.jpg "@$FX/rotated.jpg")
HEIC=$(upload "$MEDIA" foto.heic "@$FX/sample.heic")
MP4=$(upload "$MEDIA" clip.mp4 "@$FX/sample.mp4")
PDF=$(upload "$MEDIA" rechnung.pdf "@$WORK/rechnung.pdf")
thumb_ok() { [ "$(curl -s -o /dev/null -w '%{http_code}' "${H[@]}" "$B/sync/v1/items/$1/thumbnail?size=$2")" = 200 ] && echo ok; }
for id in "$JPG" "$HEIC" "$MP4" "$PDF"; do
  poll_for 90 "thumbnail of $id" thumb_ok "$id" 256 >/dev/null
  thumb_ok "$id" 1024 >/dev/null || fail "no 1024 thumbnail for $id"
done
search_hit() { api "$B/sync/v1/search?q=$1" | jq -r --arg id "$2" '.hits[] | select(.item.id==$id) | .matched'; }
[ "$(poll_for 90 "pdf text to be searchable" search_hit zitronenfalter "$PDF")" = content ] || fail "pdf found, but not by content"

# 3d) Resumable upload (tus 1.0) with plain curl: create, two PATCHes, the file appears.
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
TUS_HDR=(-H 'Tus-Resumable: 1.0.0')
LOC=$(api "${TUS_HDR[@]}" -XPOST "$B/sync/v1/uploads" -H 'Upload-Length: 11' \
  -H "Upload-Metadata: name $(b64 tus.txt),parentId $(b64 "$DOCS")" -D - -o /dev/null | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')
[ -n "$LOC" ] || fail "tus create returned no Location"
[ ! -e "$FILES/jens/Dokumente/tus.txt" ] || fail "unfinished tus upload visible in the data folder"
api "${TUS_HDR[@]}" -XPATCH "http://localhost:$PORT$LOC" -H 'Upload-Offset: 0' -H 'content-type: application/offset+octet-stream' --data-binary 'hallo ' >/dev/null
[ ! -e "$FILES/jens/Dokumente/tus.txt" ] || fail "half-finished tus upload visible in the data folder"
[ "$(api "${TUS_HDR[@]}" -I "http://localhost:$PORT$LOC" | tr -d '\r' | awk 'tolower($1)=="upload-offset:"{print $2}')" = 6 ] || fail "tus offset after first PATCH"
api "${TUS_HDR[@]}" -XPATCH "http://localhost:$PORT$LOC" -H 'Upload-Offset: 6' -H 'content-type: application/offset+octet-stream' --data-binary 'welt!' >/dev/null
[ "$(cat "$FILES/jens/Dokumente/tus.txt" 2>/dev/null)" = "hallo welt!" ] || fail "tus upload not on disk"
[ -n "$(child_id "$DOCS" tus.txt)" ] || fail "tus upload not listed"

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
  ./jens/Dokumente "./jens/Dokumente/Angebot final.txt" ./jens/Dokumente/alt-verschoben.txt ./jens/Dokumente/tus.txt \
  ./jens/Archiv ./jens/Archiv/Alt ./jens/Archiv/Alt/tief.txt ./jens/Archiv/liste.txt ./jens/Archiv/extern.txt \
  ./jens/Medien ./jens/Medien/foto.jpg ./jens/Medien/foto.heic ./jens/Medien/clip.mp4 ./jens/Medien/rechnung.pdf | LC_ALL=C sort)
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "FAIL: folder differs"; diff <(echo "$EXPECTED") <(echo "$ACTUAL"); exit 1
fi
[ "$(cat "$FILES/jens/Dokumente/Angebot final.txt")" = "hallo" ] || fail "content"
[ "$(cat "$FILES/jens/Dokumente/alt-verschoben.txt")" = "alt" ] || fail "moved file content"
ls "$META/trash"/*/weg.txt >/dev/null || fail "deleted file not in /meta/trash"
cmp -s "$FILES/jens/Medien/foto.heic" "$FX/sample.heic" || fail "uploaded heic differs"
[ -n "$(find "$META/derived" -type f | head -1)" ] || fail "/meta/derived is empty"
[ -z "$(ls -A "$META/uploads")" ] || fail "/meta/uploads not empty: $(ls -A "$META/uploads")"
echo "PASS: folder is a plain 1:1 copy of what Synclet showed, metadata stayed outside"
