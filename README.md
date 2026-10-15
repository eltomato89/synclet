# Synclet

Synclet is a self-hosted, Dropbox-like file server. Your folder stays a normal folder: Synclet indexes and serves the files you already have on disk, and never stores anything inside them besides your own content. Edit files on the host or through Synclet, and both see the same thing. Leave at any time and your folder is exactly as you want it.

## Features

- Browse, upload, download, move and delete files in the web app; sync clients via the sync API.
- **Trash:** deleting through Synclet moves items to the trash; they are restorable for 30 days (`SYNCLET_TRASH_RETENTION_DAYS`), then removed for good.
- **Shares:** public links to a file or folder, optionally with password and expiry.
- **Previews:** thumbnails and in-browser previews for images (including HEIC), video, PDF, Office documents, text and code.
- **Search:** file names and extracted text content.
- **Resumable uploads:** large uploads (tus) continue after an interrupted connection.

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
| `SYNCLET_DATA` (`/data`) | Only your files, plus the transient entries listed below. No hidden dirs, no xattrs, no metadata files. |
| `SYNCLET_META` (`/meta`) | Trash (`/meta/trash/<id>/`), delete intents (`/meta/staging/`), thumbnails and previews (`/meta/derived/`), resumable upload parts (`/meta/uploads/`). |
| PostgreSQL | File index, sync journal, users, devices, shares, extracted text for search. |

### The worker container

The `worker` service runs the same image in the worker role (`SYNCLET_ROLE=worker`). It generates thumbnails, previews and extracted text in the background using `ffmpeg`, `poppler-utils` (`pdftoppm`, `pdftotext`), `heif-convert` and `unzip`. It **reads** your files (`/data` is mounted read-only), **writes** only to `/meta/derived` and the database, and never runs migrations (only `server` does). On `docker compose stop` it gets up to 150 s to finish a running job (video thumbnails can take up to two minutes).

### Disk usage and privacy

- `/meta/derived` holds thumbnails and previews, typically a few percent of the size of your media. It can be deleted at any time; the worker regenerates it (a thumbnail is requeued as soon as it is requested and found missing, the rest in batches by the daily maintenance run, which also runs at every server start).
- `/meta/uploads` holds partial resumable uploads. Abandoned uploads are removed after 24 hours. Nothing appears in `SYNCLET_DATA` until an upload completes.
- Thumbnails and extracted text (used for search) are stored in `/meta` and in the database. When a file is deleted for good (trash expiry or emptying the trash), its derivatives and extracted text are removed by garbage collection.

### What Synclet may write into your folder

Besides the files you upload, rename, move or delete through Synclet, only two kinds of short-lived entries ever appear in a user folder:

- `.synclet-tmp-<id>`: an upload or replacement in progress. It is renamed onto the final name when complete. Leftovers from a crash are removed at the next start.
- `.synclet-trash-<id>`: an item you just deleted, while it is being moved into the trash in `SYNCLET_META`. It disappears when the move finishes. After a crash, the next start completes the move (or puts the item back if the delete never committed).

Both are ignored by the indexer and never synced. These names are reserved: you cannot create files or folders with these prefixes through the app or the sync API. A file you create yourself on the host named `.synclet-tmp-<letters/digits>` directly in a user folder is treated as a crash leftover and removed at startup.

Other names are never indexed or synced either: `.DS_Store`, `.Spotlight-V100`, `.Trashes`, `.fseventsd`, `.TemporaryItems`, `.localized`, `Thumbs.db`, `desktop.ini`, `$RECYCLE.BIN`, `@eaDir`, `#recycle`, `lost+found`, AppleDouble files (`._*`), Office lock and temp files (`~$*`, `~WRL*.tmp`, `.~lock.*#`). Symlinks are never followed, including a user folder that is itself a symlink.

### Deleting needs disk space in `SYNCLET_META`

`SYNCLET_DATA` and `SYNCLET_META` are separate mounts, so deleting through Synclet **copies** the item into `SYNCLET_META` and then removes the original. You need free space there equal to the size of what you delete. Trashed items are removed for good after `SYNCLET_TRASH_RETENTION_DAYS` (default 30). The delete itself is answered at once, and the copy runs in the background (you see the `.synclet-trash-<id>` entry in the meantime).

## Configuration

All settings go into `deploy/.env` (read by `docker compose --env-file deploy/.env`). Leave a value empty to use the default. Changes take effect after `docker compose ... up -d` (which recreates the server and worker containers).

| Variable | Default | Meaning |
| --- | --- | --- |
| `SYNCLET_DATA` | (required) | Host folder with your files. Each user gets a subfolder named like the username. |
| `SYNCLET_META` | (required) | Host folder for trash and other metadata. Must exist, be writable by `PUID:PGID` and live outside `SYNCLET_DATA`. |
| `POSTGRES_PASSWORD` | (required) | Database password; URL-safe characters only (`openssl rand -hex 24`). |
| `PUID` / `PGID` | `1000` / `1000` | User and group the server runs as; must own your files (`id -u` / `id -g`). |
| `SYNCLET_PORT` | `8080` | Host port for HTTP. |
| `SYNCLET_TLS_PORT` | `8443` | Host port for HTTPS. |
| `SYNCLET_SITE_ADDRESS` | `:80` | Caddy site address. Set to your domain (with ports 80/443) for automatic Let's Encrypt certificates. |
| `SYNCLET_PUBLIC_URL` | (empty) | Public URL, e.g. `https://files.example.com`. Currently only decides the default of `SYNCLET_SECURE_COOKIES`. |
| `SYNCLET_SECURE_COOKIES` | on if `SYNCLET_PUBLIC_URL` starts with `https://` | Forces the `Secure` flag of the login cookie on (`on`) or off (`off`). |
| `SYNCLET_TRUSTED_PROXIES` | (empty = trust none) | Proxies in front of Caddy whose `X-Forwarded-For` Caddy accepts, e.g. `private_ranges` or `192.168.1.10/32 10.0.0.0/8`. Set it when Synclet runs behind another reverse proxy; see [Behind another reverse proxy](#behind-another-reverse-proxy). |
| `SYNCLET_TRUST_PROXY` | `off` (`true` in the shipped compose file, not configurable there) | Server setting: use `X-Forwarded-For` as the client IP (rate limiting). The shipped compose file enables it because only Caddy reaches the server and Caddy always sets the header to the client IP it determined. Only enable it elsewhere behind a proxy that does the same, otherwise clients can spoof their IP. |
| `SYNCLET_TRASH_RETENTION_DAYS` | `30` | Days items stay in the trash before being removed for good (`0` = keep forever). |
| `SYNCLET_SEARCH_LANGUAGE` | `simple` | Postgres text search configuration for search: `simple`, `german`, `english`, ... (invalid values fall back to `simple` with a warning). `simple` does no stemming. Used by server and worker. Changing it later does **not** re-index already extracted text: existing documents keep their old stemming until their content changes. |
| `SYNCLET_WORKER_CONCURRENCY` | `2` | Number of preview jobs the worker runs in parallel. |
| `SYNCLET_PREVIEW_MAX_BYTES` | `2147483648` (2 GiB) | Files larger than this get no thumbnail, preview or text extraction. |
| `SYNCLET_WATCH` | `on` | `off` disables the file watcher and relies on periodic scans (NFS/SMB). |
| `SYNCLET_SCAN_INTERVAL` | `900` (`120` with `SYNCLET_WATCH=off`) | Seconds between full scans of all user folders. |
| `SYNCLET_MAX_UPLOAD_BYTES` | `53687091200` (50 GiB) | Largest accepted upload. |
| `SYNCLET_MASS_DELETE_THRESHOLD` | `25` | Safety guard: if a user folder suddenly looks empty while more than this many top-level items are indexed, Synclet refuses to delete them from the index (and from every client) and logs an error. `0` turns the guard off. If you really emptied the folder, set it to `0`, restart the server, then set it back. An unmounted data volume is always refused. |
| `SYNCLET_TOMBSTONE_WINDOW` | `3600` | Seconds within which an item that vanished and reappears elsewhere is still recognised as a move (keeps its ID). |
| `SYNCLET_JOURNAL_RETENTION_DAYS` | `30` | Days of change history kept for sync clients. A client offline for longer does a full resync. |

### Behind another reverse proxy

The rate limits for login, setup and public share links count requests per client IP. Caddy only uses the client IP from `X-Forwarded-For` when the request comes from a proxy listed in `SYNCLET_TRUSTED_PROXIES`; otherwise it uses the address of the connecting peer. If you run Synclet behind another reverse proxy (nginx, Traefik, a router) and leave `SYNCLET_TRUSTED_PROXIES` empty, every client appears with the proxy's IP and they **all share one rate-limit bucket**, so one misbehaving client can lock everybody out of logging in. Set `SYNCLET_TRUSTED_PROXIES` to the address of that proxy, or to `private_ranges` if it runs in your LAN or on the same Docker host. Caddy reads the header right to left and stops at the first untrusted address, so a client cannot spoof its IP through a proxy that appends to `X-Forwarded-For`. Only trust addresses that really are proxies: anyone connecting directly from a trusted range can claim any IP.

## Known limitations

- **macOS (Docker Desktop):** renames and moves made in Finder or other host apps show up inside the container with new inode numbers. Synclet then sees a delete plus a create instead of a move: the item gets a new ID and clients download it again. Linux hosts keep IDs across host-side renames and moves.
- **NFS/SMB sources** do not deliver change events reliably: set `SYNCLET_WATCH=off` to scan periodically instead (every 2 minutes). Inode numbers may not be stable there either, so item IDs may change when files are moved externally.
- **Deletes on the host bypass the trash.** Only deletes made through Synclet go to the trash in `SYNCLET_META`. A file you delete on the host is gone, and the delete is synced to all clients.
- inotify: on large folders raise `fs.inotify.max_user_watches` (for example `sysctl fs.inotify.max_user_watches=524288`).

## Security notes

- Resetting a user's password (or disabling the user) in the admin API signs out all of that user's **web sessions**. **Sync devices are not revoked** by a password reset, by design: devices are revoked explicitly in the device list (`DELETE /api/sync/v1/devices/<id>`). If you suspect a device token was stolen, revoke the device as well. Disabling a user blocks all of their device tokens.

- **Share links follow their item into the trash and back.** Moving a shared item (or a folder containing it) to the trash does not revoke its links: they answer "not found" while the item is in the trash, and **restoring the item re-activates them** with all their settings (password, expiry, uploads). The Shared page lists these links with an "In trash" badge so you can revoke them. Links of items deleted for good stop working permanently.

## Leaving Synclet

`docker compose -f deploy/compose.yml --env-file deploy/.env down -v` removes the containers and the Postgres/Caddy volumes. Your `SYNCLET_DATA` folder is untouched (trash in `SYNCLET_META` stays too).

## Architecture

Four containers: `postgres` (index and journal), `server` (NestJS/Fastify API, indexer, file access), `worker` (same image; thumbnails, previews, text extraction) and `caddy` (reverse proxy for `/api/*` plus the static web app). The spec lists the web app as a separate service; it is served from the Caddy image instead, which is leaner and equivalent. For automatic Let's Encrypt certificates set `SYNCLET_SITE_ADDRESS=<your domain>`, `SYNCLET_PORT=80` and `SYNCLET_TLS_PORT=443` (all three are required, plus public DNS and reachable ports 80/443). With the defaults (`:80`, ports 8080/8443) no certificates are issued; use that behind an existing reverse proxy.

## Development

```bash
pnpm install
pnpm dev:db                      # Postgres on localhost:5434
cd apps/server && pnpm prisma generate
# create a test database once:
docker compose -f deploy/compose.dev.yml exec postgres psql -U synclet -c 'CREATE DATABASE synclet_test'
pnpm test
```

**Database schema changes.** Some database objects exist only as raw SQL in the migrations, because Prisma cannot express them: the `pg_trgm`/`unaccent` extensions, the `synclet_unaccent()` function and the partial or expression indexes `Item_name_trgm_idx`, `Item_owner_mtime_idx`, `Item_contentHash_idx` and `Item_owner_path_live_key` (the list is repeated at the top of `apps/server/prisma/schema.prisma`). Create new migrations with `pnpm prisma migrate dev --create-only --name <name>` and check the generated SQL for `DROP` statements touching these objects before applying it. The server test `test/schema-drift.spec.ts` runs `prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --exit-code` against a shadow database (`<test database>_shadow` on the same Postgres, created on demand; override with `SCHEMA_DRIFT_SHADOW_URL`) and fails if the schema and the migrations disagree. It is skipped with a warning when the Prisma CLI or the shadow database is not available.

## Roadmap

See the design spec: [docs/superpowers/specs/2026-10-15-synclet-design.md](docs/superpowers/specs/2026-10-15-synclet-design.md).

## License

TBD by the maintainer before the first public release.
