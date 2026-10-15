#!/bin/sh
set -e
umask 002
prisma migrate deploy --schema /app/prisma/schema.prisma
exec node /app/dist/main.js
