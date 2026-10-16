#!/usr/bin/env bash
# Runs the server test suite in a Linux container (case-sensitive FS, all preview tools installed),
# so every itIfCaseSensitive and itIfTool test actually runs. The repo is copied into the container (host node_modules are left alone).
# Needs the dev Postgres (pnpm dev:db, host port 5434); uses its own test database.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ "$(uname -s)" = Darwin ]; then
  # Docker Desktop: --network host does not reach the macOS host; host.docker.internal does
  # (rewritten to its IPv4 address in the container – Prisma's engines try the unroutable IPv6 one).
  NET=(); DB_HOST=host.docker.internal
else
  NET=(--network host); DB_HOST=localhost
fi
URL=${TEST_DATABASE_URL_LINUX:-postgresql://synclet:synclet@$DB_HOST:5434/synclet_test_linux}
LOG=$(mktemp)
trap 'rm -f "$LOG"' EXIT
docker run --rm ${NET[@]+"${NET[@]}"} -e TEST_DATABASE_URL="$URL" -e CI=true -v "$ROOT":/repo:ro node:24-bookworm bash -c '
  set -euo pipefail
  # The tools the worker uses (same packages as deploy/Dockerfile.server), so no itIfTool test skips.
  apt-get update -qq >/dev/null && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
    ffmpeg poppler-utils libheif-examples unzip >/dev/null
  for t in ffmpeg ffprobe pdftoppm pdftotext heif-convert unzip; do command -v "$t" >/dev/null || { echo "missing tool: $t"; exit 1; }; done
  V4=$(getent ahostsv4 host.docker.internal | awk "NR==1{print \$1}" || true)
  if [ -n "$V4" ]; then export TEST_DATABASE_URL=${TEST_DATABASE_URL//host.docker.internal/$V4}; fi
  mkdir /src && cd /repo && tar --exclude=node_modules --exclude=dist --exclude=.git -cf - . | tar -xf - -C /src
  corepack enable
  # As the unprivileged "node" user like the server image (PUID): root ignores file permissions,
  # so the permission tests (e.g. a read-only versions dir) would have to skip.
  chown -R node:node /src
  su node -s /bin/bash -c "set -euo pipefail; export TEST_DATABASE_URL=\"$TEST_DATABASE_URL\" CI=true
    cd /src && pnpm install --frozen-lockfile >/dev/null
    cd apps/server && pnpm prisma generate >/dev/null && pnpm test"
' 2>&1 | tee "$LOG"
if grep -q 'skipped on case-insensitive FS' "$LOG"; then
  echo "FAIL: case-sensitive tests were skipped" >&2; exit 1
fi
if grep -q 'skipped (missing' "$LOG"; then
  echo "FAIL: tool-dependent tests were skipped:" >&2; grep 'skipped (missing' "$LOG" >&2; exit 1
fi
if grep -Eq '^(Tests|Test Suites):.* skipped' "$LOG"; then
  echo "FAIL: tests were skipped:" >&2; grep -E '^(Tests|Test Suites):' "$LOG" >&2; exit 1
fi
echo "PASS: server suite on Linux (as a non-root user), no skipped tests"
