#!/bin/sh
set -e
umask 002
# SYNCLET_ROLE=server (default): migrate, then run the API. worker: derivatives worker only, never migrates.
case "${SYNCLET_ROLE:-server}" in
  server)
    prisma migrate deploy --schema /app/prisma/schema.prisma
    exec node /app/dist/main.js
    ;;
  worker)
    exec node /app/dist/main.worker.js
    ;;
  *)
    echo "unknown SYNCLET_ROLE: ${SYNCLET_ROLE}" >&2
    exit 1
    ;;
esac
