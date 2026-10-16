# Deployment

Quickstart, configuration and the other server topics are in the [top-level README](../README.md). This page covers what depends on your storage layout.

## Upgrading: Office moved into compose.yml

The Euro-Office `office` service is now part of `compose.yml` (profile `office`) and served below `/documentserver` by default. If you use Office on its own subdomain (`COMPOSE_FILE=compose.yml:compose.office.yml`), download the new `compose.office.yml` **together with** the new `compose.yml`: the new `compose.yml` with the old `compose.office.yml` fails with "depends on undefined service office". The new override keeps your subdomain setup (same variables, same volumes; needs Docker Compose 2.24 or newer). Or switch to `/documentserver`: remove `COMPOSE_FILE`, `SYNCLET_OFFICE_SITE_ADDRESS` and `SYNCLET_OFFICE_PUBLIC_URL` from `.env`, add `COMPOSE_PROFILES=office` and run `docker compose up -d --remove-orphans`. Details: [README, Office](../README.md#office-euro-office-editing).

## Files in this folder

| File | Purpose |
| --- | --- |
| `compose.yml` | The stack. Works on its own (with `.env`): pulls `ghcr.io/eltomato89/synclet-server` and `synclet-web` in the version `SYNCLET_VERSION` (default `latest`). Includes the optional Euro-Office Document Server (profile `office`, served below `/documentserver`). |
| `.env.example` | Template for `.env`, with every setting explained. |
| `compose.office.yml` | Optional: the Euro-Office Document Server on its **own subdomain** instead of the default `/documentserver` path (the `office` service itself is in `compose.yml`, enabled with `COMPOSE_PROFILES=office` and `OFFICE_JWT_SECRET`). Enable the override with `COMPOSE_FILE=compose.yml:compose.office.yml` in `.env`, so that every command (`up`, `pull`, `logs`, `down -v`) includes it. Needs no other files: the office Caddy site is part of the `synclet-web` image. |
| `compose.build.yml` | Builds both images from a repository checkout (local tags `synclet/server:dev`, `synclet/caddy:dev`) instead of pulling them: `-f deploy/compose.yml -f deploy/compose.build.yml ... up -d --build`. |
| `Dockerfile.server`, `server-entrypoint.sh` | Image `synclet-server` (server and worker). |
| `Dockerfile.caddy`, `Caddyfile`, `Caddyfile.office` | Image `synclet-web` (Caddy with the built web app; `/documentserver` is routed when `OFFICE_JWT_SECRET` is set, the office subdomain site is enabled by `compose.office.yml`). |
| `compose.dev.yml` | Postgres for local development (`pnpm dev:db`). |

## Upgrading an existing source-built install

Before the prebuilt images, `compose.yml` built the images itself (`up -d --build`). It now pulls them from GHCR. For an existing installation from a checkout, choose one:

- **Switch to the prebuilt images:** run `docker compose -f deploy/compose.yml --env-file deploy/.env pull`, then the same command with `up -d` (no `--build`). Optionally set `SYNCLET_VERSION` in `deploy/.env` first. Your data, database and volumes stay as they are.
- **Keep building from source:** add `deploy/compose.build.yml` after `compose.yml` and put your own override last: `docker compose -f deploy/compose.yml -f deploy/compose.build.yml -f <your override> --env-file deploy/.env up -d --build`.

With Office, use the new `compose.office.yml` (or switch to the default `/documentserver` setup, see "Upgrading from the subdomain-only setup" in the [README](../README.md#office-euro-office-editing)) and remove any old bind mount of `Caddyfile.office` into `/etc/caddy/conf.d/office.caddy` from your own overrides: the office site is now built into the image and turned on by `compose.office.yml`, and mounting it as well defines the site twice, so Caddy does not start.

## Team folders and external storage

Besides each user's personal folder (`SYNCLET_DATA/<username>`), Synclet has **spaces**: shared team folders and external storage (NAS, other disks). A space is a root folder on disk; people who have access see it as a separate area in the web app and the apps. Synclet writes the same thing into a space as into a personal folder: only the visible structure, no metadata.

### Team folders: the `SYNCLET_TEAMS` volume

Every direct subfolder of `/teams` is a team folder. `SYNCLET_TEAMS` (default `./teams`, i.e. a `teams` folder next to `compose.yml`; in the repository `deploy/teams/` with a tracked `.gitkeep`) is mounted at `/teams`, read-only in the worker.

- The folder must **exist before the first start** and be writable by `PUID:PGID`. If Docker creates it itself, it belongs to `root` and creating team folders fails.
- Team folders are created in the admin area (Spaces) or by creating a folder directly in `SYNCLET_TEAMS`; Synclet finds it on the next scan.
- A new or discovered space is visible to **nobody** until an admin assigns members (users or groups, each with the role "Read" or "Write"). Without an assignment there is no access, not even for admins; they can assign themselves.
- **Groups** bundle users (admin area → Groups). A space can have groups as members; anyone who appears in several entries gets the highest role.

### External storage: `/storage/<name>`

Every folder mounted under `/storage` becomes a space; the name is the folder name. Mount the same path in `server` (read/write) and `worker` (with `:ro`). `compose.yml` contains the examples, commented out; instead of editing it you can put the mounts into a `compose.override.yml` next to it, which `docker compose` picks up automatically when you pass no `-f` option (with `-f`, for example for the office subdomain, add `-f compose.override.yml` as the last file). A newly downloaded `compose.yml` then keeps them:

```yaml
services:
  server:
    volumes:
      # Host folder (bind mount):
      - /mnt/archive:/storage/Archiv
      # Network share (named CIFS volume, see below):
      - nas-fotos:/storage/Fotos
  worker:
    volumes:
      - /mnt/archive:/storage/Archiv:ro
      - nas-fotos:/storage/Fotos:ro

volumes:
  # SMB/CIFS on a NAS, mounted by Docker on the host. The Docker "local" driver mounts
  # without mount.cifs: host names are usually not resolved, so use the IP address in device and addr=.
  nas-fotos:
    driver: local
    driver_opts:
      type: cifs
      device: //192.168.1.20/share
      o: "addr=192.168.1.20,username=…,password=…,uid=${PUID},gid=${PGID},file_mode=0664,dir_mode=0775"
  # NFS accordingly:
  # nas-archiv:
  #   driver: local
  #   driver_opts:
  #     type: nfs
  #     o: "addr=192.168.1.20,rw,nfsvers=4"
  #     device: ":/export/archiv"
```

### Permissions: PUID/PGID

Server and worker run as `PUID:PGID`. This user must be able to read every space and, for writable spaces, also write.

- Bind mounts and NFS: the owner and mode of the source folder must match `PUID:PGID` (`chown`/`chmod` on the host, or an NAS export with a matching mapping).
- CIFS has no per-file Unix permissions. Set `uid=${PUID},gid=${PGID}` (and `file_mode`/`dir_mode`) in the mount options, otherwise all files belong to `root` and Synclet cannot write.

### Mounting read-only

If you mount a storage with `:ro` (or as a read-only share) in the `server` too, the space becomes **read-only**: all members have read access only, and writes are rejected (web, Finder and Files app). Synclet detects this with a write test (`access(W_OK)`) on the root folder; changes to the mount take effect after the next scan of the space.

### Missing mount: "Not available"

If a space's root folder is unreachable (NAS off, mount missing, folder empty although Synclet knows files there), Synclet marks the space as **"Not available"**. **Nothing is deleted**: neither files nor the index, and clients receive no deletions. Content requests answer with 503, and the apps and web app show a notice. Once the mount is back, the space becomes available again on the next scan.

Consequence: a space you empty on purpose counts as "not available" until a file is in it again (or you remove it and add it back). This is intentional and protects against accidental mass deletion caused by an empty mount.

### Network file systems (NFS/SMB)

- Changes from outside are picked up reliably only through **scans**, not through file system events: inotify on a CIFS/NFS mount only sees changes made through this host, not those made on the NAS itself or by other machines. In addition, setting up the watcher walks the whole share first, which can take very long on a big share (the server stays reachable meanwhile, and other spaces' watchers wait until it is done). During such a walk, events of watchers that are already active (including the one for `/data`) are held back too, and events beyond the kernel queue are dropped silently while the status still shows "Watching"; the periodic scan catches up. In the admin area, set **Watch for changes: Off (scan only)** and a **scan interval** per space (minimum 10 s; without its own interval the global one applies: `SYNCLET_SCAN_INTERVAL`, otherwise 900 s if `SYNCLET_WATCH` is on and 120 s if it is globally off. A single space's watch mode does not change this default, so set an interval there as well). The "Scan now" button triggers a scan.
- Inode numbers are often not stable. **A move from outside is therefore detected as delete + create**, the item gets a new ID and clients download it again. Moving through Synclet (web, apps) keeps the ID, even between spaces on the same file system; between different file systems it copies and then removes the original.
- On startup, Synclet cleans up leftover Synclet remnants (`.synclet-tmp-*`) in team folders and external storage only at the top level; the deeper search runs afterwards in the background, so the server is reachable immediately, even with a slow share.

### Removing means hiding

"Remove" in the admin area deletes **nothing**: the folder stays on disk, the space disappears for all members and is not discovered again automatically. In the list of hidden spaces, **"Restore"** brings it back (without members; they have to be assigned again). To really delete a team folder, delete it on the host after removing the space.

### Backup and leaving

Team folders and external storage are ordinary folders; you back them up like `SYNCLET_DATA`. The metadata (trash, versions, previews) still lives in `SYNCLET_META`.

### Update and downgrade

On the first start of a version with spaces, Synclet migrates the database (spaces, groups, members; the personal folders become spaces). **Downgrading to an older version is not supported afterwards.** Back up the database first (e.g. `pg_dump`) if you want to be able to go back.
