# Synclet

Synclet is a self-hosted, Dropbox-like file server. Your folder stays a normal folder: Synclet indexes and serves the files you already have on disk, and never stores anything inside them besides your own content. Edit files on the host or through Synclet, and both see the same thing. Leave at any time and your folder is exactly as you want it.

## Quickstart

```bash
cp deploy/.env.example deploy/.env
# edit deploy/.env: set SYNCLET_DATA (your files folder), SYNCLET_META, PUID/PGID, POSTGRES_PASSWORD
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
```

Open `http://localhost:8080` (or your `SYNCLET_PORT`) and complete the setup wizard. The username you choose is the folder name below `SYNCLET_DATA`; an existing folder with that name is adopted and its files appear immediately.

`SYNCLET_META` is required: the folder must exist, be writable by `PUID:PGID` and live outside `SYNCLET_DATA`. `POSTGRES_PASSWORD` is required too and must contain only URL-safe characters (`[A-Za-z0-9._~-]`); generate one with `openssl rand -hex 24`.

## What is written where

| Location | Content |
| --- | --- |
| `SYNCLET_DATA` (`/data`) | Only your files, plus transient `.synclet-tmp-*` upload files that are cleaned up at startup. No hidden dirs, no xattrs, no metadata files. |
| `SYNCLET_META` (`/meta`) | Trash (`/meta/trash/<id>/`); later thumbnails and versions. |
| PostgreSQL | File index, sync journal, users, devices. |

## Linux notes

- inotify: on large folders raise `fs.inotify.max_user_watches` (for example `sysctl fs.inotify.max_user_watches=524288`).
- NFS/SMB sources do not deliver change events reliably: set `SYNCLET_WATCH=off` to scan periodically instead (every 2 minutes). Item IDs may change when files are moved externally on such mounts.

## Leaving Synclet

`docker compose -f deploy/compose.yml --env-file deploy/.env down -v` removes the containers and the Postgres/Caddy volumes. Your `SYNCLET_DATA` folder is untouched (trash in `SYNCLET_META` stays too).

## Architecture

Three containers: `postgres` (index and journal), `server` (NestJS/Fastify API, indexer, file access) and `caddy` (reverse proxy for `/api/*` plus the static web app). The spec lists the web app as a separate service; it is served from the Caddy image instead, which is leaner and equivalent. For automatic Let's Encrypt certificates set `SYNCLET_SITE_ADDRESS=<your domain>`, `SYNCLET_PORT=80` and `SYNCLET_TLS_PORT=443` (all three are required, plus public DNS and reachable ports 80/443). With the defaults (`:80`, ports 8080/8443) no certificates are issued; use that behind an existing reverse proxy.

## Development

```bash
pnpm install
pnpm dev:db                      # Postgres on localhost:5434
cd apps/server && pnpm prisma generate
# create a test database once:
docker compose -f deploy/compose.dev.yml exec postgres psql -U synclet -c 'CREATE DATABASE synclet_test'
pnpm test
```

## Roadmap

See the design spec: [docs/superpowers/specs/2026-10-15-synclet-design.md](docs/superpowers/specs/2026-10-15-synclet-design.md).

## License

TBD by the maintainer before the first public release.
