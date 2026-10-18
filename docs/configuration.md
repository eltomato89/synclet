# Configuration

## Configuration

All settings go into `.env` next to `compose.yml` (in a checkout: `deploy/.env`, read by `docker compose --env-file deploy/.env`). Leave a value empty to use the default. Changes take effect after `docker compose ... up -d` (which recreates the server and worker containers).

| Variable | Default | Meaning |
| --- | --- | --- |
| `SYNCLET_VERSION` | `latest` | Image tag of `synclet-server` and `synclet-web`: a release such as `1.2.3` (recommended), `1.2`, `latest` or `edge`; see [Updating](installation.md#updating). Not used by source builds. |
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
| `SYNCLET_FORWARD_AUTH_PROXIES` | (empty = always strip) | Forward-auth only: the exact address of the authenticating proxy, e.g. `192.168.1.10/32`. Only this direct peer may send the identity headers (`Remote-*`); Caddy strips them from everyone else. **Never** `private_ranges` or a whole subnet; see [Forward-auth](single-sign-on.md#forward-auth-authelia-authentik-). |
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
| `SYNCLET_VERSIONS` | `off` | `on` keeps previous contents of files overwritten through Synclet; see [Versions](versions.md#versions). |
| `SYNCLET_VERSIONS_MAX_BYTES` | `0` (unlimited) | Per-user cap for stored version bytes; the oldest versions are evicted first. |
| `SYNCLET_SSO_EMERGENCY` | (empty) | `1` (or `true`, `on`, `yes`) ignores OIDC and forward-auth and allows password login for everyone; see [Locked out?](single-sign-on.md#locked-out-emergency-recovery). |
| `SYNCLET_SSO_ALLOW_HTTP_ISSUER` | (empty) | `1` accepts an `http://` OIDC issuer on a loopback/private host (lab setups only; otherwise `https://` is required). |
| `SYNCLET_UPDATE_CHECK` | `on` | The server asks `api.github.com` for the latest release (at most every 12 hours, only while an admin uses the web app). GitHub sees the server's public IP address and the installed version (in the User-Agent); nothing else is sent. The admin area then shows when an update is available. `off` makes no outbound request at all. Development builds (`edge`, source builds) are never checked. |
| `SYNCLET_UPDATE_REPO` | `eltomato89/synclet` | Repository (`owner/repo`) whose GitHub releases the update check compares against, for forks. |
| `COMPOSE_PROFILES` | (empty) | `office` starts the Euro-Office Document Server container; see [Office](office.md#office-euro-office-editing). |
| `OFFICE_JWT_SECRET` | (empty) | Shared JWT secret with the Document Server (`openssl rand -hex 32`). Set = office editing on (and `/documentserver` routed by Caddy); empty = off. |
| `OFFICE_TAG` | `latest` | Image tag of `ghcr.io/euro-office/documentserver`; pin it in production. |
| `SYNCLET_OFFICE_WELCOME` | (empty) | `on` serves the Document Server's welcome, example and admin pages below `/documentserver` (404 by default). |
| `SYNCLET_OFFICE_PUBLIC_URL` | `${SYNCLET_PUBLIC_URL}/documentserver` | Browser-facing URL of the Document Server, without trailing slash. Whenever set, Caddy also adds its origin to the Synclet site's CSP (not needed for the same-origin default). With `compose.office.yml`: the `https://` URL of the office subdomain (required there). |
| `SYNCLET_OFFICE_SITE_ADDRESS` | (empty) | `compose.office.yml` only: Caddy site address of the office subdomain (domain, or `http://...` behind a TLS-terminating proxy). Required there. |

### PostgreSQL extensions

Search needs the Postgres extensions `pg_trgm` and `unaccent`; the first migration creates them (`CREATE EXTENSION IF NOT EXISTS`). The bundled `postgres:16-alpine` image ships both, and its `synclet` user may create them. With an **external PostgreSQL** the database user either needs the right to create extensions (superuser, or a trusted extension on Postgres 13+), or an administrator creates both in the Synclet database beforehand (`CREATE EXTENSION pg_trgm; CREATE EXTENSION unaccent;`). Otherwise the server's migration fails at startup.

### PostgreSQL connection for live change notifications

The server keeps one extra connection per server process open with `LISTEN` to learn about committed changes and tell sync clients over `/api/sync/v1/events`. It uses `DATABASE_URL` with the same meaning Prisma gives it: `sslmode=require`/`prefer` encrypt without verifying the certificate (as in libpq), `sslmode=verify-full` or `sslaccept=strict` verify it. The connection is checked every 30 s and re-established automatically.

- `DATABASE_URL` must reach PostgreSQL directly or through a pooler in **session** mode. A **transaction-pooling** pgbouncer (Prisma's `pgbouncer=true`) accepts `LISTEN` but never delivers notifications; the server logs a warning at startup. Sync still works, because the server re-checks every open event stream at each keep-alive ping: clients then learn about remote changes up to 25 s late instead of at once.

### Behind another reverse proxy

The rate limits for login, setup and public share links count requests per client IP. Caddy only uses the client IP from `X-Forwarded-For` when the request comes from a proxy listed in `SYNCLET_TRUSTED_PROXIES`; otherwise it uses the address of the connecting peer. If you run Synclet behind another reverse proxy (nginx, Traefik, a router) and leave `SYNCLET_TRUSTED_PROXIES` empty, every client appears with the proxy's IP and they **all share one rate-limit bucket**, so one misbehaving client can lock everybody out of logging in. Set `SYNCLET_TRUSTED_PROXIES` to the address of that proxy (for example `192.168.1.10/32`, or its address on a Docker network shared with Caddy). Avoid broad values such as `private_ranges`: with Docker's userland proxy even outside clients can appear with a private gateway address. Caddy reads the header right to left and stops at the first untrusted address, so a client cannot spoof its IP through a proxy that appends to `X-Forwarded-For`. Only trust addresses that really are proxies: anyone connecting directly from a trusted range can claim any IP.

**Live change notifications (SSE).** Sync clients keep one long-lived connection open to `/api/sync/v1/events` (Server-Sent Events, `text/event-stream`) to learn about changes immediately. The bundled Caddy passes it through unbuffered and uncompressed. An outer proxy needs no special settings as long as its read/idle timeout for upstream responses is **longer than 25 s** (the server sends a keep-alive comment every 25 s). Nginx Proxy Manager, Traefik and Caddy work with their defaults; with plain nginx keep `proxy_read_timeout` at its default (60 s) or higher, and buffering is already off because the server sends `X-Accel-Buffering: no`. If the stream is cut anyway, clients reconnect and fall back to polling, so nothing is lost, only delayed.
