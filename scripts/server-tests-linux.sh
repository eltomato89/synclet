#!/usr/bin/env bash
# Runs the server test suite in a Linux container (case-sensitive FS), so every itIfCaseSensitive
# test actually runs. The repo is copied into the container (host node_modules are left alone).
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
  V4=$(getent ahostsv4 host.docker.internal | awk "NR==1{print \$1}" || true)
  if [ -n "$V4" ]; then export TEST_DATABASE_URL=${TEST_DATABASE_URL//host.docker.internal/$V4}; fi
  mkdir /src && cd /repo && tar --exclude=node_modules --exclude=dist --exclude=.git -cf - . | tar -xf - -C /src
  cd /src && corepack enable && pnpm install --frozen-lockfile >/dev/null
  cd apps/server && pnpm prisma generate >/dev/null && pnpm test
' 2>&1 | tee "$LOG"
if grep -q 'skipped on case-insensitive FS' "$LOG"; then
  echo "FAIL: case-sensitive tests were skipped" >&2; exit 1
fi
echo "PASS: server suite on Linux, case-sensitive tests included"
