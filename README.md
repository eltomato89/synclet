# Synclet

Synclet is a self-hosted, Dropbox-like file server. Your folder stays a normal folder: Synclet indexes and serves the files you already have on disk, and never stores anything inside them besides your own content. Edit files on the host or through Synclet, and both see the same thing. Leave at any time and your folder is exactly as you want it.

## Features

- Browse, upload, download, move and delete files in the web app; sync clients via the sync API.
- **Trash:** deleting through Synclet moves items to the trash; they are restorable for 30 days (`SYNCLET_TRASH_RETENTION_DAYS`), then removed for good.
- **Shares:** public links to a file or folder, optionally with password and expiry.
- **Previews:** thumbnails and in-browser previews for images (including HEIC), video, PDF, text and code. Office documents (`docx`, `xlsx`, `pptx`, `odt`, `ods`, `odp`) get no visual preview (they can be edited with the optional Office setup); their text is extracted for search only.
- **Search:** file names and extracted text content.
- **Resumable uploads:** large uploads (tus) continue after an interrupted connection.
- **Office editing (optional):** edit Office documents in the browser with Euro-Office, see [Office](#office-euro-office-editing).
- **Versions (optional):** keep previous contents of overwritten files, see [Versions](#versions).
- **Single sign-on (optional):** OIDC (Authentik, Keycloak, Authelia, ...) and forward-auth, see [Single sign-on](#single-sign-on). Native apps sign in through the browser, see [App login](#app-login).
- **Spaces:** shared team folders and external storages (NAS shares, other disks) next to the personal folder, with per-user and per-group read/write access, see [Team-Ordner und externe Speicher](deploy/README.md#team-ordner-und-externe-speicher).
- **Admin area:** users, sessions and devices, shares, SSO settings and server status, see [Admin area](#admin-area).
- **macOS client:** your files in Finder with on-demand download, live updates and offline folders, see [macOS client](#macos-client).

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
| `SYNCLET_META` (`/meta`) | Trash (`/meta/trash/<id>/`), delete intents (`/meta/staging/`), thumbnails and previews (`/meta/derived/`), resumable upload parts (`/meta/uploads/`), file versions when enabled (`/meta/versions/`). |
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
| `SYNCLET_PORT` | `8080` | Host port for HTTP. `127.0.0.1:8080` publishes it on loopback only (recommended behind an outer proxy on the same host). |
| `SYNCLET_TLS_PORT` | `8443` | Host port for HTTPS (`127.0.0.1:8443` = loopback only). |
| `SYNCLET_SITE_ADDRESS` | `:80` | Caddy site address. Set to your domain (with ports 80/443) for automatic Let's Encrypt certificates. |
| `SYNCLET_PUBLIC_URL` | (empty) | Public URL, e.g. `https://files.example.com`. Used to build absolute share-link URLs (without it, links are shown relative to the address you opened the web app with) and decides the default of `SYNCLET_SECURE_COOKIES`. |
| `SYNCLET_SECURE_COOKIES` | on if `SYNCLET_PUBLIC_URL` starts with `https://` | Forces the `Secure` flag of the login cookie on (`on`) or off (`off`). |
| `SYNCLET_TRUSTED_PROXIES` | (empty = trust none) | Proxies in front of Caddy whose `X-Forwarded-For` Caddy accepts (client IP for rate limits), e.g. `192.168.1.10/32`. Set it when Synclet runs behind another reverse proxy; see [Behind another reverse proxy](#behind-another-reverse-proxy). It never lets anyone send forward-auth headers. |
| `SYNCLET_FORWARD_AUTH_PROXIES` | (empty = always strip) | Forward-auth only: the exact address of the authenticating proxy, e.g. `192.168.1.10/32`. Only this direct peer may send the identity headers (`Remote-*`); Caddy strips them from everyone else. **Never** `private_ranges` or a whole subnet; see [Forward-auth](#forward-auth-authelia-authentik-). |
| `SYNCLET_TRUST_PROXY` | `off` (`true` in the shipped compose file, not configurable there) | Server setting: use `X-Forwarded-For` as the client IP (rate limiting). The shipped compose file enables it because only Caddy reaches the server and Caddy always sets the header to the client IP it determined. Only enable it elsewhere behind a proxy that does the same, otherwise clients can spoof their IP. |
| `SYNCLET_TRASH_RETENTION_DAYS` | `30` | Days items stay in the trash before being removed for good (`0` = keep forever). The expiry date is fixed when an item is deleted: changing the value later does not affect entries already in the trash. |
| `SYNCLET_SEARCH_LANGUAGE` | `simple` | Postgres text search configuration for search: `simple`, `german`, `english`, ... (invalid values fall back to `simple` with a warning). `simple` does no stemming. Used by server and worker. Changing it later does **not** re-index already extracted text: existing documents keep their old stemming until their content changes. |
| `SYNCLET_WORKER_CONCURRENCY` | `2` | Number of preview jobs the worker runs in parallel. |
| `SYNCLET_PREVIEW_MAX_BYTES` | `2147483648` (2 GiB) | Files larger than this get no thumbnail, preview or text extraction. |
| `SYNCLET_WATCH` | `on` | `off` disables the file watcher and relies on periodic scans (NFS/SMB). |
| `SYNCLET_SCAN_INTERVAL` | `900` (`120` with `SYNCLET_WATCH=off`) | Seconds between full scans of all user folders. |
| `SYNCLET_MAX_UPLOAD_BYTES` | `53687091200` (50 GiB) | Largest accepted upload, as a plain number of bytes (digits only; `50G` or `1e9` are refused by both the server and Caddy, which then do not start). Also the request body limit of the bundled Caddy for `/api/*` (larger requests get `413` from the proxy); raise the limit of an outer reverse proxy accordingly. |
| `SYNCLET_MASS_DELETE_THRESHOLD` | `25` | Safety guard: if a user folder suddenly looks empty while more than this many top-level items are indexed, Synclet refuses to delete them from the index (and from every client) and logs an error. `0` turns the guard off. If you really emptied the folder, set it to `0`, restart the server, then set it back. An unmounted data volume is always refused. |
| `SYNCLET_TOMBSTONE_WINDOW` | `3600` | Seconds within which an item that vanished and reappears elsewhere is still recognised as a move (keeps its ID). |
| `SYNCLET_JOURNAL_RETENTION_DAYS` | `30` | Days of change history kept for sync clients. A client offline for longer does a full resync. |
| `SYNCLET_VERSIONS` | `off` | `on` keeps previous contents of files overwritten through Synclet; see [Versions](#versions). |
| `SYNCLET_VERSIONS_MAX_BYTES` | `0` (unlimited) | Per-user cap for stored version bytes; the oldest versions are evicted first. |
| `SYNCLET_SSO_EMERGENCY` | (empty) | `1` (or `true`, `on`, `yes`) ignores OIDC and forward-auth and allows password login for everyone; see [Locked out?](#locked-out-emergency-recovery). |
| `SYNCLET_SSO_ALLOW_HTTP_ISSUER` | (empty) | `1` accepts an `http://` OIDC issuer on a loopback/private host (lab setups only; otherwise `https://` is required). |
| `SYNCLET_OFFICE_SITE_ADDRESS` | (empty) | Office override only: Caddy site address of the Document Server (domain, or `http://...` behind a TLS-terminating proxy). Required with `compose.office.yml`. |
| `SYNCLET_OFFICE_PUBLIC_URL` | (empty) | Office override only: browser-facing `https://` URL of the office site; also added to the Synclet site's CSP. Required with `compose.office.yml`. |
| `OFFICE_JWT_SECRET` | (empty) | Office override only: shared JWT secret with the Document Server (`openssl rand -hex 32`). Required with `compose.office.yml`. |
| `OFFICE_TAG` | `latest` | Office override only: image tag of `ghcr.io/euro-office/documentserver`; pin it in production. |

### PostgreSQL extensions

Search needs the Postgres extensions `pg_trgm` and `unaccent`; the first migration creates them (`CREATE EXTENSION IF NOT EXISTS`). The bundled `postgres:16-alpine` image ships both, and its `synclet` user may create them. With an **external PostgreSQL** the database user either needs the right to create extensions (superuser, or a trusted extension on Postgres 13+), or an administrator creates both in the Synclet database beforehand (`CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent;`). Otherwise the server's migration fails at startup.

### PostgreSQL connection for live change notifications

The server keeps one extra connection per server process open with `LISTEN` to learn about committed changes and tell sync clients over `/api/sync/v1/events`. It uses `DATABASE_URL` with the same meaning Prisma gives it: `sslmode=require`/`prefer` encrypt without verifying the certificate (as in libpq), `sslmode=verify-full` or `sslaccept=strict` verify it. The connection is checked every 30 s and re-established automatically.

- `DATABASE_URL` must reach PostgreSQL directly or through a pooler in **session** mode. A **transaction-pooling** pgbouncer (Prisma's `pgbouncer=true`) accepts `LISTEN` but never delivers notifications; the server logs a warning at startup. Sync still works, because the server re-checks every open event stream at each keep-alive ping: clients then learn about remote changes up to 25 s late instead of at once.

### Behind another reverse proxy

The rate limits for login, setup and public share links count requests per client IP. Caddy only uses the client IP from `X-Forwarded-For` when the request comes from a proxy listed in `SYNCLET_TRUSTED_PROXIES`; otherwise it uses the address of the connecting peer. If you run Synclet behind another reverse proxy (nginx, Traefik, a router) and leave `SYNCLET_TRUSTED_PROXIES` empty, every client appears with the proxy's IP and they **all share one rate-limit bucket**, so one misbehaving client can lock everybody out of logging in. Set `SYNCLET_TRUSTED_PROXIES` to the address of that proxy (for example `192.168.1.10/32`, or its address on a Docker network shared with Caddy). Avoid broad values such as `private_ranges`: with Docker's userland proxy even outside clients can appear with a private gateway address. Caddy reads the header right to left and stops at the first untrusted address, so a client cannot spoof its IP through a proxy that appends to `X-Forwarded-For`. Only trust addresses that really are proxies: anyone connecting directly from a trusted range can claim any IP.

**Live change notifications (SSE).** Sync clients keep one long-lived connection open to `/api/sync/v1/events` (Server-Sent Events, `text/event-stream`) to learn about changes immediately. The bundled Caddy passes it through unbuffered and uncompressed. An outer proxy needs no special settings as long as its read/idle timeout for upstream responses is **longer than 25 s** (the server sends a keep-alive comment every 25 s). Nginx Proxy Manager, Traefik and Caddy work with their defaults; with plain nginx keep `proxy_read_timeout` at its default (60 s) or higher, and buffering is already off because the server sends `X-Accel-Buffering: no`. If the stream is cut anyway, clients reconnect and fall back to polling, so nothing is lost, only delayed.

## Office (Euro-Office editing)

Optional. Edit `docx`, `xlsx`, `pptx`, `odt`, `ods` and `odp` files in the browser with the [Euro-Office](https://github.com/euro-office) Document Server (AGPL-3.0, an OnlyOffice fork). It runs as an extra container on its **own subdomain**, behind the same Caddy.

**Requirements**

- About **4 GB of free RAM** for the Document Server (the first start takes a minute or two).
- A second DNS name for the editor, e.g. `office.example.com`, pointing at the same host as Synclet.

**Setup**

1. Add to `deploy/.env`:

   ```
   SYNCLET_OFFICE_SITE_ADDRESS=office.example.com
   SYNCLET_OFFICE_PUBLIC_URL=https://office.example.com
   OFFICE_JWT_SECRET=<openssl rand -hex 32>
   ```

2. Start the stack with the office override (**`--build` is required**: the Caddy image contains the import of the office site; run it with `--build` once after upgrading an existing installation, too):

   ```bash
   docker compose -f deploy/compose.yml -f deploy/compose.office.yml --env-file deploy/.env up -d --build
   ```

3. Open a document in the web app with "Open in Office" (new documents can be created there as well). The admin status page shows whether the Document Server is reachable.

**DNS and TLS.** Both sites share Caddy's ports and are told apart by the `Host` header.

- *Caddy terminates TLS:* `SYNCLET_OFFICE_SITE_ADDRESS` is the domain; Caddy fetches a Let's Encrypt certificate for it (same prerequisites as for the main site: public DNS, ports 80/443 reachable, see [Architecture](#architecture)).
- *Behind an outer reverse proxy that terminates TLS:* set `SYNCLET_OFFICE_SITE_ADDRESS=http://office.example.com`, route both hostnames to Caddy and forward the original `Host`. Put the proxy into `SYNCLET_TRUSTED_PROXIES`, otherwise Caddy tells the Document Server the request was plain `http` and it generates `http://` URLs (mixed content; the editor does not load). The proxy must support WebSocket upgrades.

`SYNCLET_OFFICE_PUBLIC_URL` is the browser-facing `https://` URL of that site, without trailing slash. With the office override Caddy adds exactly this origin to `script-src`, `frame-src` and `connect-src` (https and wss) of the Content-Security-Policy of the Synclet site; without it the policy stays strict.

**Security.** `OFFICE_JWT_SECRET` is shared between Synclet and the Document Server (JWT on every request in both directions). Keep it secret and set it to a random value. The Document Server fetches and saves files from Synclet over the internal Docker network (`http://server:3000/api`) with short-lived, file-bound tokens; only Caddy publishes ports. Pin `OFFICE_TAG` to a specific image tag in production.

**Size limits.** The Document Server has its own limit, `FileConverter.converter.maxDownloadBytes`, **500 MB** by default (`/etc/euro-office/documentserver/default.json` in the `office` container; override it with a `local.json`). Larger documents do not open. `SYNCLET_MAX_UPLOAD_BYTES` does not apply to it.

**Concurrent edits.** If a file was changed by a sync client or on the host while an editing session was open, the editor's save does not overwrite it: it is written as a conflict copy next to the file.

## Versions

Optional and **off by default** (`SYNCLET_VERSIONS=off`). When on, Synclet keeps the previous content of a file whenever it is overwritten **through Synclet** (web upload/replace, sync clients, Office saves, restoring a version).

**Enable.** Set `SYNCLET_VERSIONS=on` in `deploy/.env` and run `docker compose ... up -d`. The web app then shows a version list per file (download, restore). With versions off the version endpoints answer `404 versions disabled` and the web hides the UI. Optionally cap the space with `SYNCLET_VERSIONS_MAX_BYTES` (per user, default `0` = unlimited).

**Where.** Versions are stored in `SYNCLET_META/versions/<user>/<item>/`, **never in `SYNCLET_DATA`**. They follow the item: moving or renaming a file keeps its versions, they stay while the file is in the trash and are removed with it (delete forever, emptying the trash, expiry). Restoring a version first turns the current content into a version, so nothing is lost.

**Retention.** The daily maintenance run thins versions out like Nextcloud does. The newest version is always kept; going back in time, at most one version is kept per step:

| Age of the version | Kept at most |
| --- | --- |
| up to 10 seconds | one per 2 seconds |
| up to 1 minute | one per 10 seconds |
| up to 1 hour | one per minute |
| up to 24 hours | one per hour |
| up to 30 days | one per day |
| older | one per week (kept until the file is gone or `SYNCLET_VERSIONS_MAX_BYTES` evicts it) |

With `SYNCLET_VERSIONS_MAX_BYTES` set, the oldest versions of a user are deleted first when the cap is exceeded; the newest version of each file is never evicted by the cap.

**Limitations.**

- Only overwrites made through Synclet create versions. Changes made directly on the host (editor, `cp`, ...) are picked up by the indexer but not versioned.
- Versions need disk space in `SYNCLET_META` (the admin status page shows it). On the same file system Synclet uses a hard link when possible, otherwise a copy.
- Switching versions off stops creating new ones; existing versions stay on disk but are neither served nor cleaned up until you switch it on again.

## Single sign-on

Synclet supports two kinds of SSO, configured by an admin in the web app (admin area, "Single sign-on"); the settings are stored in the database (the OIDC client secret is encrypted).

- **OpenID Connect (OIDC):** a "Sign in with ..." button on the login page. Works with Authentik, Keycloak, Authelia and any other standards-compliant IdP.
- **Forward-auth:** a trusted reverse proxy in front of Synclet authenticates users and passes the identity in headers (Authelia, Authentik proxy outpost, ...).

Both can be enabled at the same time as password login.

### OIDC

1. Set `SYNCLET_PUBLIC_URL` (e.g. `https://files.example.com`); OIDC cannot be enabled without it. The **redirect URI** to register at the IdP is:

   ```
   ${SYNCLET_PUBLIC_URL}/api/auth/oidc/callback
   ```

2. Create a **confidential** OIDC client at the IdP (authorization code flow; Synclet always uses PKCE `S256`, `state` and `nonce`) and note the issuer URL, client ID and client secret.
3. In Synclet: admin area > Single sign-on > OIDC: issuer, client ID, client secret, then "Test" (runs OIDC discovery) and enable. The issuer must be `https://` (an `http://` issuer on a loopback/private host only with `SYNCLET_SSO_ALLOW_HTTP_ISSUER=1`, for lab setups).

Settings (defaults in brackets):

| Setting | Meaning |
| --- | --- |
| Scopes (`openid profile email`) | Must include `openid`. Add `groups` if your IdP needs that scope to release the groups claim. |
| Username claim (`preferred_username`) | Claim for the new user's name (dotted paths such as `realm_access.roles` work for nested claims). |
| Groups claim (`groups`) | Claim with the group list (array or single string; dotted paths allowed). |
| Allowed groups | If set, only members of at least one of these groups may sign in (checked on **every** login). Empty = every user the IdP authenticates. |
| Admin groups | If set, members become admins, and the role follows the membership on every login (the last enabled admin with a password is never demoted). Empty = SSO users are regular users, roles are managed in the admin area. |
| Link by email (off) | See below. |
| Button label | Text of the login button. |

Claims are read from the ID token and, if the IdP has a userinfo endpoint, supplemented from there.

**Authentik.** Create an OAuth2/OpenID Provider (client type *Confidential*, redirect URI mode *Strict* with the URI above, a signing key selected) and an Application using it. Issuer: `https://authentik.example.com/application/o/<application-slug>/`. The default `profile` scope mapping already provides `groups`. Create a group such as `synclet-admins` and enter it as admin group.

**Keycloak.** In your realm create a client (*Client authentication* on, *Standard flow* on, valid redirect URI as above). Issuer: `https://keycloak.example.com/realms/<realm>`. Keycloak has no groups claim by default: under *Client scopes* > `<client>-dedicated` > *Add mapper* > *Group Membership*, claim name `groups`, **Full group path off**, add to ID token and userinfo. Alternatively set the groups claim to `realm_access.roles` and use realm roles.

**Authelia.** Add a client to `identity_providers.oidc.clients` in Authelia's configuration (secret as digest, plain secret in Synclet):

```yaml
- client_id: synclet
  client_name: Synclet
  client_secret: '$pbkdf2-sha512$...'   # authelia crypto hash generate pbkdf2
  public: false
  authorization_policy: two_factor
  require_pkce: true
  pkce_challenge_method: S256
  redirect_uris:
    - https://files.example.com/api/auth/oidc/callback
  scopes: [openid, profile, email, groups]
  token_endpoint_auth_method: client_secret_basic
```

Issuer: the Authelia root URL, e.g. `https://auth.example.com`. Put `groups` into the scopes in Synclet as well (`openid profile email groups`). Synclet reads the ID token and also the userinfo endpoint (ID-token claims win, userinfo fills what is missing), so groups released only via userinfo work too. Authelia 4.39 and later releases some claims only through a `claims_policy` on the client; if groups don't arrive, add a policy that includes `groups` (and `email`) for the ID token.

### Accounts created and linked by SSO

- **Auto-provisioning.** The first login of an unknown identity creates a user (no setup by an admin). The username comes from the username claim and is sanitized to a safe folder name (forbidden characters become `-`, at most 64 characters, reserved names and empty results become `user`). If the name is taken (case-insensitive) or a folder of that name already exists in `SYNCLET_DATA`, a suffix is added (`alice-2`, `alice-3`, ...): an SSO login **never adopts an existing folder**. A verified email address is stored when nobody else uses it.
- **Link by email (off by default).** Without this option an OIDC login never attaches to an existing local account, even if the email address matches. When an admin turns it on, an unknown identity is linked to the existing user with the same email address **only if the IdP marks the email as verified** (`email_verified: true`). Only enable it if your IdP verifies email addresses (a user who can set an arbitrary unverified email at the IdP could otherwise take over accounts). Forward-auth never links by email.
- **Disabled users** cannot sign in via SSO either.
- **Password login for regular users** can be turned off in the SSO settings. **Admins can always use their password**, so a broken IdP never locks out the instance.

### Forward-auth (Authelia, Authentik, ...)

The proxy authenticates the visitor and forwards identity headers; the web app then signs the user in automatically (`POST /api/auth/forward`). Default header names (changeable in the admin area): `Remote-User` (username), `Remote-Email`, `Remote-Name`, `Remote-Groups` (comma or `|` separated). Authelia sends exactly these; for Authentik's outpost set the names to `X-authentik-username`, `X-authentik-email`, `X-authentik-name` and `X-authentik-groups`. Allowed/admin groups and provisioning work as for OIDC (but never link by email).

Two layers decide who may assert an identity, and **both must be configured**:

1. **Caddy** removes the identity headers from every `/api/*` request whose direct peer is not in `SYNCLET_FORWARD_AUTH_PROXIES`. Set it to the **exact address of your authenticating proxy** only, e.g. `192.168.1.10/32` (or its fixed address on a Docker network shared with Caddy). **Never use `private_ranges` or a whole subnet:** every host in it (any device in your LAN, any container on the host, and with Docker's userland proxy even outside clients that appear as the gateway address) could then send `Remote-User: <admin>` and sign in as that user. Empty (the default) means nothing is trusted and the headers are always stripped. This variable is independent of `SYNCLET_TRUSTED_PROXIES`, which only governs `X-Forwarded-For`. **If you configure custom header names, add them to the `request_header @untrusted_auth_headers -<Name>` lines in `deploy/Caddyfile`** (they are not stripped otherwise) and rebuild the Caddy image (`up -d --build`).
2. **The Synclet server** accepts the headers only if its direct TCP peer is inside the *trusted proxies* of the forward-auth settings. In the shipped setup that peer is the Caddy container. Enter **only Caddy's address** there, not the whole Docker network of the stack (that network also holds the worker and the Document Server, which fetches URLs on users' behalf). Give Caddy a fixed address in a `compose.override.yml`, for example:

   ```yaml
   networks:
     default:
       ipam:
         config: [{ subnet: 172.30.0.0/24 }]
   services:
     caddy:
       networks:
         default:
           ipv4_address: 172.30.0.10
   ```

   and enter `172.30.0.10/32` as the forward-auth trusted proxy. Never put the address of any untrusted network there; `X-Forwarded-For` is never used for this decision.
3. **Make the proxy the only way in.** Clients must not be able to reach Caddy directly, bypassing the gate. Publish Caddy's ports on loopback only (`SYNCLET_PORT=127.0.0.1:8080`, `SYNCLET_TLS_PORT=127.0.0.1:8443`) when the outer proxy runs on the same host, reach it only over a Docker network shared with the outer proxy, or block the ports with a firewall.

Outer proxy example with Caddy and Authelia:

```
files.example.com {
	# Everything that authenticates itself (Synclet tokens, share links) or carries no secret
	# (the SPA's static files) bypasses the SSO gate.
	@open path /api/sync/* /api/auth/app/* /api/public/* /s/* /assets/* /favicon.svg /index.html
	handle @open {
		reverse_proxy synclet-caddy:80
	}
	handle {
		forward_auth authelia:9091 {
			uri /api/authz/forward-auth
			copy_headers Remote-User Remote-Groups Remote-Email Remote-Name
		}
		reverse_proxy synclet-caddy:80
	}
}
```

For Authentik use its outpost instead: add `handle /outpost.goauthentik.io/* { reverse_proxy authentik-outpost:9000 }` before the other blocks, and `forward_auth authentik-outpost:9000 { uri /outpost.goauthentik.io/auth/caddy; copy_headers X-authentik-username X-authentik-email X-authentik-name X-authentik-groups }` (with the matching header names in the Synclet settings and in `deploy/Caddyfile`).

Why these paths bypass: `/s/<token>` is a route of the single-page app, so anonymous visitors of a public share link get the app shell (`index.html`, `/assets/*`, `/favicon.svg`) and then call `/api/public/*`; without the static files the share page does not load. Native apps and sync clients send Synclet tokens to `/api/sync/*` and sign in through `/api/auth/app/*`. **Tradeoff:** the bypass of `/api/auth/app/*` exposes the (rate-limited) password authorize endpoint outside the SSO gate. If you don't want password sign-in reachable that way, turn off password login for users in the SSO settings (admins keep it, by design); the apps then sign in through the browser with an existing SSO session. The `Remote-*` headers are only needed on the web login entry: what must stay behind the gate is `/`, `/login` and `/api/auth/forward`, not the API (the web app also calls `/api/sync/v1/*` with Synclet tokens, which authenticate themselves). The gate must **not** wrap the office subdomain: the Document Server loads in an iframe, uses WebSockets and fetches files from Synclet with its own tokens.

nginx and Traefik work the same way with `auth_request` / the `forwardAuth` middleware; copy the four headers to the upstream request. Put the proxy's exact address into `SYNCLET_FORWARD_AUTH_PROXIES` (and `SYNCLET_TRUSTED_PROXIES` for the client IP), enter Caddy's address in the forward-auth trusted proxies as described, and keep the bypass list above.

### Locked out? Emergency recovery

- Set `SYNCLET_SSO_EMERGENCY=1` in `deploy/.env` and run `docker compose ... up -d`. OIDC and forward-auth are ignored and **password login is allowed for everyone**. Fix the SSO settings, then remove the variable again.
- If no admin has a working password, give one a new password (this also enables the account, makes it admin and signs out its sessions):

  ```bash
  docker compose -f deploy/compose.yml --env-file deploy/.env exec server node dist/cli/reset-admin-password.js <username>
  # or choose the password yourself:
  echo 'a new password' | docker compose -f deploy/compose.yml --env-file deploy/.env exec -T server node dist/cli/reset-admin-password.js <username>
  ```

  Without a password on stdin a random one is generated and printed (10-200 characters otherwise).

## App login

The native Synclet apps (iPhone/iPad, Android, Mac, Windows, Linux) do not ask for your password inside the app. They open the web page `/app-login` of your server in the system browser (OAuth 2.0 authorization code flow with PKCE `S256`, public clients without a secret). There you sign in the way you always do, with your password or, if you are already signed in or use SSO, with the existing session. The server then redirects back to the app with a **one-time code** (valid 60 seconds, stored as a hash only), and the app exchanges it plus its PKCE verifier for an access token and a rotating refresh token. Password login follows the rule from the SSO settings (regular users with password login disabled must use SSO).

Only registered redirect URIs are accepted, matched exactly:

| Client ID | Redirect URI |
| --- | --- |
| `ios`, `android`, `macos` | `synclet://oauth` |
| `windows`, `linux` | `http://127.0.0.1:<any port>/callback` (loopback, per RFC 8252) |

An outer proxy or SSO gate must let `/api/auth/app/*` through (see the forward-auth example). All app-login routes are rate-limited per client IP; this needs a correct client IP, see [Behind another reverse proxy](#behind-another-reverse-proxy).

## macOS client

The Mac app (`apps/macos`, macOS 26 or later) is a menu bar app with a File Provider extension:

- **Finder:** each account appears in Finder under **Locations** as "Synclet – `<user>@<host>`". Inside it is "Meine Dateien" with your files. Files download when you open them.
- **Sign-in:** through the browser ([App login](#app-login)), so SSO works. The app keeps only a device token, which you can revoke in the admin area under "Sessions and devices".
- **Live updates:** changes made on the web or by other devices appear in Finder within seconds over a live event stream (`GET /api/sync/v1/events`, server-sent events). A reverse proxy in front of Synclet must not buffer that response, and its idle timeout must be above 25 s. Otherwise the app falls back to polling every 60 s.
- **Large files:** files over 32 MiB upload resumably (tus), new files and replaced ones alike. When the same file changed on the server meanwhile, your version is kept as a "(Konflikt …)" copy.
- **Offline folders:** choose folders, or a whole space, under Settings → Offline. They stay downloaded, including new files.
- **More:** server thumbnails for files that are not downloaded yet; a status menu with recent problems; several accounts at once.

Build, tests, signing and notarization, plus the manual Finder checklist: [apps/macos/README.md](apps/macos/README.md). Distribution is a notarized DMG (`apps/macos/build_and_notarize.sh`).

## Admin area

Admins get an "Admin" entry in the web app with:

- **Users:** create users, change role (admin/user), disable or delete users, reset passwords, adopt an existing, unassigned folder of `SYNCLET_DATA` as a user's folder. The last enabled admin cannot be demoted, disabled or deleted.
- **Sessions and devices:** per user, list and revoke web sessions and sync devices.
- **Shares:** all share links of all users; revoke any of them.
- **Single sign-on:** the OIDC and forward-auth settings described above, including discovery test and the password-login switch.
- **Folders and storages (Spaces):** create team folders, see external storages, assign users and groups with read or write access, set watch mode and scan interval per space, scan now, hide ("Entfernen") and restore ("Wieder aufnehmen"). Details: [deploy/README.md](deploy/README.md#team-ordner-und-externe-speicher).
- **Groups:** bundle users to grant access to spaces at once.
- **Status:** version and uptime, file watcher state and last full scan, number of users, free and used space of the data and meta volumes, size of derivatives / trash / versions / uploads in `SYNCLET_META`, thumbnail and text-extraction job queues, whether versions are on and whether the Document Server is reachable.

## Known limitations

- **macOS (Docker Desktop):** renames and moves made in Finder or other host apps show up inside the container with new inode numbers. Synclet then sees a delete plus a create instead of a move: the item gets a new ID and clients download it again. Linux hosts keep IDs across host-side renames and moves.
- **NFS/SMB sources** do not deliver change events reliably: set `SYNCLET_WATCH=off` to scan periodically instead (every 2 minutes). Inode numbers may not be stable there either, so item IDs may change when files are moved externally.
- **Deletes on the host bypass the trash.** Only deletes made through Synclet go to the trash in `SYNCLET_META`. A file you delete on the host is gone, and the delete is synced to all clients.
- inotify: on large folders raise `fs.inotify.max_user_watches` (for example `sysctl fs.inotify.max_user_watches=524288`).

## Security notes

- Resetting a user's password (or disabling the user) in the admin API signs out all of that user's **web sessions**. **Sync devices are not revoked** by a password reset, by design: devices are revoked explicitly in the device list (`DELETE /api/sync/v1/devices/<id>`). If you suspect a device token was stolen, revoke the device as well. Disabling a user blocks all of their device tokens.
- **Preview tokens.** To show thumbnails, images, video and PDFs in the browser, the web app gets short-lived URLs with a `?dt=` token that is bound to one item and valid for **6 hours** (download links: 60 seconds). These tokens are not tied to a session: they **keep working after logout and after a password reset** until they expire. Disabling the user blocks them immediately.
- **"Allow download" off is not copy protection.** When a share link has downloads disabled, recipients cannot download files or the folder as ZIP, but they can still **view images, video, audio, text and PDFs inline in the browser**, and the browser can save what it displays.
- **Share links follow their item into the trash and back.** Moving a shared item (or a folder containing it) to the trash does not revoke its links: they answer "not found" while the item is in the trash, and **restoring the item re-activates them** with all their settings (password, expiry, uploads). The Shared page lists these links with an "In trash" badge so you can revoke them. Links of items deleted for good stop working permanently.

## Leaving Synclet

`docker compose -f deploy/compose.yml --env-file deploy/.env down -v` (add `-f deploy/compose.office.yml` if you use Office) removes the containers and the Postgres/Caddy volumes. Your `SYNCLET_DATA` folder is untouched (trash in `SYNCLET_META` stays too).

## Architecture

Four containers (five with the optional `office` Document Server): `postgres` (index and journal), `server` (NestJS/Fastify API, indexer, file access), `worker` (same image; thumbnails, previews, text extraction) and `caddy` (reverse proxy for `/api/*` plus the static web app). The spec lists the web app as a separate service; it is served from the Caddy image instead, which is leaner and equivalent. For automatic Let's Encrypt certificates set `SYNCLET_SITE_ADDRESS=<your domain>`, `SYNCLET_PORT=80` and `SYNCLET_TLS_PORT=443` (all three are required, plus public DNS and reachable ports 80/443). With the defaults (`:80`, ports 8080/8443) no certificates are issued; use that behind an existing reverse proxy.

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
