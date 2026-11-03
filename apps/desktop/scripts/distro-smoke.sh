#!/usr/bin/env bash
# Runs the published spike (out/linux-<arch>/Synclet.FuseSpike) plus smoke.sh in a clean distro container.
#   distro-smoke.sh ubuntu:24.04|fedora:41|debian:trixie [linux/arm64|linux/amd64]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
image=$1
platform=${2:-linux/arm64}
arch=${platform#linux/}; [ "$arch" = amd64 ] && arch=x64

docker run --rm -i --platform "$platform" --device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
  -v "$here/../out/linux-$arch":/spike:ro -v "$here":/scripts:ro "$image" bash -s <<'EOF'
set -euo pipefail
if command -v apt-get >/dev/null; then
  apt-get update -qq >/dev/null && apt-get install -y -qq fuse3 libicu-dev >/dev/null 2>&1
  lib=$(dpkg-query -W -f='${Version}' 'libfuse3-[0-9]*' | head -1)
else
  dnf install -y -q fuse3 libicu >/dev/null 2>&1
  lib=$(rpm -q --qf '%{VERSION}' fuse3-libs)
fi
. /etc/os-release
echo "== $PRETTY_NAME, $(uname -m), libfuse $lib"
/spike/Synclet.FuseSpike /mnt/synclet --read-delay-ms 0 < <(sleep infinity) > /tmp/spike.out 2> /tmp/spike.err &
pid=$!
for _ in $(seq 50); do grep -q ready /tmp/spike.out 2>/dev/null && break; sleep 0.2; done
grep -q ready /tmp/spike.out || { cat /tmp/spike.err; exit 1; }
/scripts/smoke.sh /mnt/synclet
kill -TERM $pid; wait $pid
grep -q /mnt/synclet /proc/mounts && { echo "still mounted"; exit 1; }
echo "== clean unmount"
EOF
