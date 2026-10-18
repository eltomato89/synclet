# Development

```bash
pnpm install
pnpm dev:db                      # Postgres on localhost:5434
cd apps/server && pnpm prisma generate
# create a test database once:
docker compose -f deploy/compose.dev.yml exec postgres psql -U synclet -c 'CREATE DATABASE synclet_test'
pnpm test
```

**Database schema changes.** Some database objects exist only as raw SQL in the migrations, because Prisma cannot express them: the `pg_trgm`/`unaccent` extensions, the `synclet_unaccent()` function and the partial or expression indexes `Item_name_trgm_idx`, `Item_owner_mtime_idx`, `Item_contentHash_idx` and `Item_owner_path_live_key` (the list is repeated at the top of `apps/server/prisma/schema.prisma`). Create new migrations with `pnpm prisma migrate dev --create-only --name <name>` and check the generated SQL for `DROP` statements touching these objects before applying it. The server test `test/schema-drift.spec.ts` runs `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code` against a shadow database (`<test database>_shadow` on the same Postgres, created on demand; override with `SCHEMA_DRIFT_SHADOW_URL`) and fails if the schema and the migrations disagree. It is skipped with a warning when the Prisma CLI or the shadow database is not available.

## Architecture

Four containers (five with the optional `office` Document Server): `postgres` (index and journal), `server` (NestJS/Fastify API, indexer, file access), `worker` (same image; thumbnails, previews, text extraction) and `caddy` (reverse proxy for `/api/*` plus the static web app). The spec lists the web app as a separate service; it is served from the Caddy image instead, which is leaner and equivalent. `server` and `worker` run the image `ghcr.io/eltomato89/synclet-server` (`deploy/Dockerfile.server`), `caddy` runs `ghcr.io/eltomato89/synclet-web` (`deploy/Dockerfile.caddy`: Caddy, the built web app and the Caddyfiles). Both are built by the `Container images` workflow for every release tag (`X.Y.Z`, `X.Y`, `latest`) and for pushes to `main` that change the code, the Dockerfiles or the Caddyfiles (`edge`, `sha-<commit>`). For automatic Let's Encrypt certificates set `SYNCLET_SITE_ADDRESS=<your domain>`, `SYNCLET_PORT=80` and `SYNCLET_TLS_PORT=443` (all three are required, plus public DNS and reachable ports 80/443). With the defaults (`:80`, ports 8080/8443) no certificates are issued; use that behind an existing reverse proxy.
