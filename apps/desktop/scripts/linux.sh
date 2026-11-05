#!/usr/bin/env bash
# Runs a command inside the Linux build image with FUSE access, e.g.
#   apps/desktop/scripts/linux.sh dotnet test
# SYNCLET_PLATFORM=linux/amd64 runs the x64 image (Docker Desktop: Rosetta/QEMU).
# SYNCLET_DISTRO=debian13 runs on Debian 13 (libfuse 3.17) instead of Ubuntu 24.04 (3.14).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
platform="${SYNCLET_PLATFORM:-}"
distro="${SYNCLET_DISTRO:-}"
image="synclet-desktop-dev"
volume="synclet-nuget"
dockerfile="$here/Dockerfile.linux"
plat=()
env=()
if [ -n "$distro" ]; then
  dockerfile="$here/Dockerfile.$distro"
  image="synclet-desktop-$distro"
  env=(-e "SYNCLET_ARTIFACTS=/src/apps/desktop/out/artifacts-$distro")
fi
if [ -n "$platform" ]; then
  plat=(--platform "$platform")
  image="$image:${platform//\//-}"
  volume="$volume-${platform//\//-}"
  env=(-e "SYNCLET_ARTIFACTS=/src/apps/desktop/out/artifacts-${platform//\//-}")
fi

docker build -q ${plat[@]+"${plat[@]}"} -t "$image" -f "$dockerfile" "$here" >/dev/null

exec docker run --rm -i ${plat[@]+"${plat[@]}"} ${env[@]+"${env[@]}"} \
  --device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
  -v "$root":/src -v "$volume":/root/.nuget/packages \
  -w /src/apps/desktop "$image" "$@"
