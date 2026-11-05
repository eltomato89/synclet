#!/usr/bin/env bash
# Smoke test against a running Synclet.FuseSpike: smoke.sh <mountpoint>. Exits 1 if any check fails.
set -uo pipefail
cd "$1" || exit 1
id=$$
failed=0

# check <description> <bash snippet>: the snippet runs with errexit; its last command is the verdict.
check() {
  printf '  %-36s' "$1"
  if out=$(bash -ec "$2" 2>&1); then echo ok; else echo "FAILED ${out:+($out)}"; failed=$((failed + 1)); fi
}

M="Meine Dateien"
nfd=$(printf 'Gru\xcc\x88\xc3\x9fe-%s.txt' "$id")
nfc=$(printf 'Gr\xc3\xbc\xc3\x9fe-%s.txt' "$id")
export M id nfd nfc

check "is a synclet FUSE mount"   '[ "$(awk -v m="$PWD" "\$2 == m { print \$3 }" /proc/mounts)" = fuse.synclet ]'
[ "$failed" -eq 0 ] || { echo "smoke FAILED (not a synclet mount, nothing else checked)"; exit 1; }
check "spaces listed"             '[ "$(ls -1)" = "$(printf "Meine Dateien\nTeam Foto")" ]'
check "read file"                 '[ "$(cat "$M/hallo.txt")" = "Hallo Synclet" ]'
check "write and read back"       'printf abc > "$M/smoke-$id.txt"; [ "$(cat "$M/smoke-$id.txt")" = abc ]'
check "8 MiB copy roundtrip"      'head -c 8388608 /dev/urandom > "/tmp/smoke-$id.bin"; cp "/tmp/smoke-$id.bin" "$M/smoke-$id.bin"
                                   [ "$(sha256sum < "/tmp/smoke-$id.bin")" = "$(sha256sum < "$M/smoke-$id.bin")" ]'
check "move into folder"          'mv "$M/smoke-$id.txt" "$M/Dokumente/"; [ -f "$M/Dokumente/smoke-$id.txt" ]'
check "delete"                    'rm "$M/Dokumente/smoke-$id.txt" "$M/smoke-$id.bin" "/tmp/smoke-$id.bin"; [ ! -e "$M/smoke-$id.bin" ]'
check "mkdir / rmdir"             'mkdir "$M/dir-$id"; rmdir "$M/dir-$id"; [ ! -e "$M/dir-$id" ]'
check "gedit save pattern"        'printf alt > "$M/g-$id.txt"; cd "$M"; printf neu > ".goutputstream-$id"; mv -f ".goutputstream-$id" "g-$id.txt"
                                   [ "$(cat "g-$id.txt")" = neu ]; [ ! -e ".goutputstream-$id" ]; rm "g-$id.txt"'
check "umlauts, NFD input -> NFC" 'echo hi > "$M/$nfd"; ls "$M" | grep -qx "$nfc"; [ "$(cat "$M/$nfc")" = hi ]; rm "$M/$nfc"'
check "free space reported"       '[ "$(df -B1 --output=avail . | tail -1 | tr -d " ")" -gt 0 ]'
check "read-only space refuses"   '! touch "Team Foto/x-$id" 2>/dev/null'
check "root refuses"              '! mkdir "neu-$id" 2>/dev/null'

if [ "$failed" -gt 0 ]; then echo "smoke FAILED ($failed)"; exit 1; fi
echo "smoke ok"
