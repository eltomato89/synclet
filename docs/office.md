# Office (Euro-Office editing)

Optional. Edit `docx`, `xlsx`, `pptx`, `odt`, `ods` and `odp` files in the browser with the [Euro-Office](https://github.com/euro-office) Document Server (AGPL-3.0, an OnlyOffice fork). It runs as an extra container (`office`, part of `compose.yml` behind the compose profile `office`) and is served by the bundled Caddy below **`/documentserver`** on the Synclet domain, e.g. `https://files.example.com/documentserver/`. No second DNS name or certificate is needed.

**Requirements**

- About **4 GB of free RAM** for the Document Server (the first start takes a minute or two).
- `SYNCLET_PUBLIC_URL` set to the browser-facing URL of Synclet (the editor URL is derived from it). With `OFFICE_JWT_SECRET` set but `SYNCLET_PUBLIC_URL` (and `SYNCLET_OFFICE_PUBLIC_URL`) empty, the server does not start and logs why.

**Setup**

1. Add to `.env` (`COMPOSE_PROFILES` makes every `docker compose` command, including `pull`, `logs` and `down -v`, include the office container):

   ```
   COMPOSE_PROFILES=office
   OFFICE_JWT_SECRET=<openssl rand -hex 32>
   ```

2. Start the stack:

   ```bash
   docker compose up -d
   ```

   From a checkout with source builds: `docker compose -f deploy/compose.yml -f deploy/compose.build.yml --env-file deploy/.env up -d --build` (the profile comes from `deploy/.env` as well).

3. Open a document in the web app with "Open in Office" (new documents can be created there as well). The admin status page shows whether the Document Server is reachable.

Both settings are needed: `OFFICE_JWT_SECRET` turns office editing on in Synclet and the `/documentserver` route in Caddy (without it, `/documentserver` answers 404), the profile starts the container. `COMPOSE_PROFILES=office` without a secret starts a Document Server that nothing uses (it still takes its RAM). The server uses `OFFICE_URL=${SYNCLET_PUBLIC_URL}/documentserver`; set `SYNCLET_OFFICE_PUBLIC_URL` to override it. The Document Server's welcome, example and admin pages (`/documentserver/welcome/`, `/documentserver/example/`, `/documentserver/admin/`) are not needed and answer 404; `SYNCLET_OFFICE_WELCOME=on` serves them anyway (e.g. to check the installation).

**Saving.** The Document Server keeps edits in its editing session and writes them to the file when the last editor closes (about 10 seconds later), when someone clicks Save, and, while the document stays open, every 5 minutes if it has unsaved edits. So other devices and the sync clients see edits at most a few minutes late. Change the interval with `OFFICE_AUTOSAVE_INTERVAL` (e.g. `1m`, `30m`); `OFFICE_AUTOSAVE=false` turns the periodic save off.

**Behind an outer reverse proxy** (nginx, Traefik, Nginx Proxy Manager) that terminates TLS, the proxy must, for the Synclet host:

- pass **WebSocket** upgrades (Nginx Proxy Manager: "Websockets Support"),
- use **long or no read timeouts** (the editor keeps a WebSocket open for the whole session; nginx: `proxy_read_timeout 3600s` or more) and no response buffering,
- accept **large request bodies** (`client_max_body_size 0`, already needed for uploads),
- forward the original `Host` (with the port, if it is not the default one).

Put the proxy into `SYNCLET_TRUSTED_PROXIES`, otherwise Caddy tells the Document Server the request was plain `http` and it generates `http://` and `ws://` URLs (mixed content; the editor does not load).

Use the address the proxy **arrives with at Caddy**, which is not always the proxy's own IP. If the proxy reaches Synclet through a published port (e.g. `8080:80`) on a host with Docker's userland proxy, every connection arrives from the gateway of Synclet's Docker network (often `172.x.0.1`), and that gateway address is what belongs in `SYNCLET_TRUSTED_PROXIES`. To see the address while a page is open, list Caddy's connections:

```sh
docker compose exec caddy netstat -tn | grep ':80 '
```

The remote addresses in the last column are what Caddy sees. Symptom of a wrong value: the editor shows "Download failed" right after opening a document.

**Alternative: Document Server on its own subdomain.** In the default setup the Document Server's pages share Synclet's origin. That is simpler (one hostname, the Content-Security-Policy stays at `'self'`), but it means an XSS vulnerability in the Document Server could act as the signed-in Synclet user (read the web app's state, call the API with the session). On a separate subdomain the browser isolates the two. To use it:

1. Download the override next to `compose.yml` (in a checkout it is `deploy/compose.office.yml`):

   ```bash
   curl -fsSLO https://raw.githubusercontent.com/eltomato89/synclet/main/deploy/compose.office.yml
   ```

2. Add to `.env` (`COMPOSE_PROFILES` is not needed: the override always starts the office container):

   ```
   COMPOSE_FILE=compose.yml:compose.office.yml
   SYNCLET_OFFICE_SITE_ADDRESS=office.example.com
   SYNCLET_OFFICE_PUBLIC_URL=https://office.example.com
   OFFICE_JWT_SECRET=<openssl rand -hex 32>
   ```

3. `docker compose up -d`. From a checkout with source builds, leave out `COMPOSE_FILE` and pass the files instead: `docker compose -f deploy/compose.yml -f deploy/compose.build.yml -f deploy/compose.office.yml --env-file deploy/.env up -d --build`. Every later `docker compose` command (`down`, `logs`, ...) needs the same `-f` options. The override needs Docker Compose 2.24 or newer.

It needs a second DNS name pointing at the same host. Both sites share Caddy's ports and are told apart by the `Host` header; `/documentserver` on the Synclet site stays 404.

- *Caddy terminates TLS:* `SYNCLET_OFFICE_SITE_ADDRESS` is the domain; Caddy fetches a Let's Encrypt certificate for it (same prerequisites as for the main site: public DNS, ports 80/443 reachable, see [Architecture](../README.md#architecture)).
- *Behind an outer reverse proxy that terminates TLS:* set `SYNCLET_OFFICE_SITE_ADDRESS=http://office.example.com`, route both hostnames to Caddy and forward the original `Host`. The same proxy requirements as above apply (WebSockets, long timeouts, large bodies, `SYNCLET_TRUSTED_PROXIES`).

`SYNCLET_OFFICE_PUBLIC_URL` is the browser-facing `https://` URL of that site, without trailing slash. Caddy adds exactly this origin to `script-src`, `frame-src` and `connect-src` (https and wss) of the Content-Security-Policy of the Synclet site.

**Upgrading from the subdomain-only setup.** Before, the office container was defined in `compose.office.yml` only. Download the new `compose.yml` *and* `compose.office.yml`: with your existing `.env` (`COMPOSE_FILE=compose.yml:compose.office.yml`, `SYNCLET_OFFICE_SITE_ADDRESS`, `SYNCLET_OFFICE_PUBLIC_URL`) everything keeps working on the subdomain, with the same volumes. To move to `/documentserver` instead: remove `COMPOSE_FILE`, `SYNCLET_OFFICE_SITE_ADDRESS` and `SYNCLET_OFFICE_PUBLIC_URL` from `.env`, add `COMPOSE_PROFILES=office`, run `docker compose up -d --remove-orphans`, and drop the office hostname from DNS and your outer proxy. Editor sessions open during the switch are lost (save before), files are not affected.

**Security.** `OFFICE_JWT_SECRET` is shared between Synclet and the Document Server (JWT on every request in both directions). Keep it secret and set it to a random value. The Document Server fetches and saves files from Synclet over the internal Docker network (`http://server:3000/api`) with short-lived, file-bound tokens; only Caddy publishes ports. Pin `OFFICE_TAG` to a specific image tag in production. For an **internet-facing** installation we recommend the [subdomain setup](#office-euro-office-editing) (`compose.office.yml`): with the default `/documentserver` the Document Server shares Synclet's origin, so a vulnerability in it could act as the signed-in user.

**Size limits.** The Document Server has its own limit, `FileConverter.converter.maxDownloadBytes`, **500 MB** by default (`/etc/euro-office/documentserver/default.json` in the `office` container; override it with a `local.json`). Larger documents do not open. `SYNCLET_MAX_UPLOAD_BYTES` does not apply to it.

**Concurrent edits.** If a file was changed by a sync client or on the host while an editing session was open, the editor's save does not overwrite it: it is written as a conflict copy next to the file.
