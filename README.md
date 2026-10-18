# Synclet

**A cloud drive for your own server that leaves your files exactly as they are.**

[![Website](https://img.shields.io/badge/website-eltomato89.github.io%2Fsynclet-0f7c8a)](https://eltomato89.github.io/synclet/)
[![Download for macOS](https://img.shields.io/badge/download-macOS%20(.dmg)-0f7c8a)](https://github.com/eltomato89/synclet/releases/latest/download/Synclet.dmg)
[![iPhone & iPad beta on TestFlight](https://img.shields.io/badge/iPhone%20%26%20iPad-TestFlight%20beta-0f7c8a)](https://testflight.apple.com/join/NA3Aphqe)
[![Download for Android](https://img.shields.io/badge/download-Android%20(.apk)-0f7c8a)](https://github.com/eltomato89/synclet/releases/latest/download/Synclet.apk)
[![Install](https://img.shields.io/badge/install-docker%20compose-0f7c8a)](#get-started)
[![License: MIT](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/readme-hero-dark.gif">
  <img src="docs/assets/readme-hero-light.gif" alt="Animation: the same Photos folder in Synclet's web app in a browser and in the iPhone app. Both scroll through the photos and open one in the preview (sample data)." width="100%">
</picture>

Synclet turns a folder on your server into a cloud drive you can use from the browser, your Mac, your iPhone and your Android phone. Underneath it's still just a folder: no blobs in a database, no metadata files in your folders. Stop using Synclet tomorrow and your files are exactly where you left them.
## Why Synclet?

- **Plain files, always.** Synclet works with the files already on your disk. Change something over SMB or in a shell and Synclet picks it up. Rename it in the app and it's renamed on disk.
- **Apps that feel at home.** Your files show up in Finder, in the iOS Files app and in Android's file picker, and download only when you open them.
- **Made for sharing at home.** Shared folders for the family and the NAS shares you already have, with read or write access per person or group.
- **One small stack.** Server, worker, PostgreSQL and Caddy in one Docker Compose file. Updates are a version bump.
## What you get

- **Web app:** upload, browse and search, including the text inside your documents. Previews for photos (HEIC too), videos, PDFs and text. Select many files at once to move, copy or download them as a ZIP.
- **Apps** for Mac, iPhone & iPad and Android.
- **Share links** with an optional password and expiry date.
- **Trash** for 30 days, and optional file versions.
- **Optional:** edit Office documents in the browser (Euro-Office) and sign in with your identity provider (OIDC or forward-auth).

Everything in detail: [Documentation](docs/README.md).
## Get started

You need a Linux machine or NAS with Docker. Synclet runs from prebuilt images for amd64 and arm64.

**1. Download two files**

```bash
mkdir synclet && cd synclet
curl -fsSLO https://raw.githubusercontent.com/eltomato89/synclet/main/deploy/compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/eltomato89/synclet/main/deploy/.env.example
```

**2. Create the folders and fill in `.env`**

Synclet needs a folder for your files and a separate one for its own data (thumbnails, trash, versions). The second must not be inside the first.

```bash
sudo mkdir -p /srv/files /srv/synclet-meta
sudo chown "$(id -u):$(id -g)" /srv/files /srv/synclet-meta
mkdir -p teams
sed -i.bak -e "s/^PUID=.*/PUID=$(id -u)/" -e "s/^PGID=.*/PGID=$(id -g)/" \
  -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env && rm .env.bak
```

Then check `SYNCLET_DATA` and `SYNCLET_META` in `.env`, and set `SYNCLET_VERSION` to a release (for example `0.1.7`) instead of `latest`.

**3. Start it**

```bash
docker compose up -d
```

Open `http://localhost:8080` and create your account. Your username becomes your folder in `/srv/files`. If a folder with that name already exists, its files show up right away.

Next steps: [put it behind your reverse proxy](docs/configuration.md#behind-another-reverse-proxy), [add shared folders and NAS shares](deploy/README.md#team-folders-and-external-storage), [install the apps](docs/apps.md).

### Updating

Set the new `SYNCLET_VERSION` in `.env`, then run `docker compose pull && docker compose up -d`. Synclet updates its database on start, and you can't go back to an older version afterwards. Back up the database first and read the [release notes](https://github.com/eltomato89/synclet/releases). More in [Installing and updating](docs/installation.md).

## Documentation

- [Installing and updating](docs/installation.md): image tags, updates, building from source
- [Configuration](docs/configuration.md): every setting, PostgreSQL, running behind a reverse proxy
- [Files and storage](docs/storage.md): what Synclet writes where, disk usage, what it may put in your folders
- [Team folders and external storage](deploy/README.md#team-folders-and-external-storage)
- [Office](docs/office.md): editing documents in the browser with Euro-Office
- [Versions](docs/versions.md): keeping earlier versions of your files
- [Single sign-on](docs/single-sign-on.md): OIDC, forward-auth, emergency access
- [Apps](docs/apps.md): signing in from the apps, Mac, Android
- [Admin area](docs/admin.md)
- [Sync API](docs/sync/SYNC_API.md): for client developers

## Known limitations

- **macOS (Docker Desktop):** renames and moves made in Finder or other host apps show up inside the container with new inode numbers. Synclet then sees a delete plus a create instead of a move: the item gets a new ID and clients download it again. Linux hosts keep IDs across host-side renames and moves.
- **NFS/SMB sources** do not deliver change events reliably (inotify on the mount only sees changes made through this host, not on the NAS itself), and setting up the watcher on a big share can take very long: set the space to **Watch for changes: Off (scan only)**, or `SYNCLET_WATCH=off` for all spaces, to scan periodically instead. Inode numbers may not be stable there either, so item IDs may change when files are moved externally.
- **Deletes on the host bypass the trash.** Only deletes made through Synclet go to the trash in `SYNCLET_META`. A file you delete on the host is gone, and the delete is synced to all clients.
- inotify: on large folders raise `fs.inotify.max_user_watches` (for example `sysctl fs.inotify.max_user_watches=524288`).
## Security notes

- Resetting a user's password (or disabling the user) in the admin API signs out all of that user's **web sessions**. **Sync devices are not revoked** by a password reset, by design: devices are revoked explicitly in the device list (`DELETE /api/sync/v1/devices/<id>`). If you suspect a device token was stolen, revoke the device as well. Disabling a user blocks all of their device tokens.
- **Preview tokens.** To show thumbnails, images, video and PDFs in the browser, the web app gets short-lived URLs with a `?dt=` token that is bound to one item and valid for **6 hours** (download links: 60 seconds). These tokens are not tied to a session: they **keep working after logout and after a password reset** until they expire. Disabling the user blocks them immediately.
- **"Allow download" off is not copy protection.** When a share link has downloads disabled, recipients cannot download files or the folder as ZIP, but they can still **view images, video, audio, text and PDFs inline in the browser**, and the browser can save what it displays.
- **Share links follow their item into the trash and back.** Moving a shared item (or a folder containing it) to the trash does not revoke its links: they answer "not found" while the item is in the trash, and **restoring the item re-activates them** with all their settings (password, expiry, uploads). The Shared page lists these links with an "In trash" badge so you can revoke them. Links of items deleted for good stop working permanently.
## Leaving Synclet

`docker compose down -v` (with Office, `COMPOSE_PROFILES` or `COMPOSE_FILE` in `.env` includes the office container) removes the containers and the Postgres/Caddy volumes. Your `SYNCLET_DATA` folder is untouched (trash in `SYNCLET_META` stays too).
## Architecture

Four containers (five with the optional `office` Document Server): `postgres` (index and journal), `server` (NestJS/Fastify API, indexer, file access), `worker` (same image; thumbnails, previews, text extraction) and `caddy` (reverse proxy for `/api/*` plus the static web app). The spec lists the web app as a separate service; it is served from the Caddy image instead, which is leaner and equivalent. `server` and `worker` run the image `ghcr.io/eltomato89/synclet-server` (`deploy/Dockerfile.server`), `caddy` runs `ghcr.io/eltomato89/synclet-web` (`deploy/Dockerfile.caddy`: Caddy, the built web app and the Caddyfiles). Both are built by the `Container images` workflow for every release tag (`X.Y.Z`, `X.Y`, `latest`) and for pushes to `main` that change the code, the Dockerfiles or the Caddyfiles (`edge`, `sha-<commit>`). For automatic Let's Encrypt certificates set `SYNCLET_SITE_ADDRESS=<your domain>`, `SYNCLET_PORT=80` and `SYNCLET_TLS_PORT=443` (all three are required, plus public DNS and reachable ports 80/443). With the defaults (`:80`, ports 8080/8443) no certificates are issued; use that behind an existing reverse proxy.
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

Planned work is tracked in the issue tracker.
## License

[MIT](LICENSE) © 2026 Jens Köhler
## Built with AI assistance

This project was developed with the help of AI coding assistants (Anthropic's Claude) under human direction and review. Contributions and issues are welcome.
