# Synclet Sync API v1

Binding contract between the Synclet server (`apps/server/src/sync/`, `uploads/`, `auth/`) and its
native clients (macOS File Provider, Windows Cloud Files, iOS File Provider, Android
DocumentsProvider, Linux). All clients build on this document; change it only by agreement.

- **Origin:** a port of Buro's `docs/sync/SYNC_API.md` (Sync API v1). Request and response shapes
  are kept compatible so Buro's clients (`BuroFileProviderKit`, `Buro.Sync.*`) can be ported with
  the changes listed in [§13](#13-differences-from-buro-sync_api-v1-porting-checklist).
- **Machine-readable form:** [`packages/sync-contract/openapi.yaml`](../../packages/sync-contract/openapi.yaml)
  (OpenAPI 3.1). This prose document is normative; where the two disagree, the OpenAPI file is wrong.
- **Executable form:** the conformance suite in [`packages/sync-contract`](../../packages/sync-contract)
  runs against a live server and validates every response against the OpenAPI schemas ([§14](#14-conformance-suite)).
- **Keywords:** *must*, *must not*, *should*, *may* as in RFC 2119.

---

## 1. Basics

- **Base URL:** `<origin>/api/sync/v1`, e.g. `https://files.example.com/api/sync/v1`
  (local: `http://localhost:8080/api/sync/v1`). There is no tenant and no subdomain: one server, one
  set of users; the account is determined by the token alone. Other routes in this document live
  under `<origin>/api` (`/api/auth/…`, `/api/setup…`, `/api/trash…`).
- **Spaces (Phase 4):** every user owns a **personal space**, the folder `/data/<username>/` on the
  server. Administrators can additionally grant users (directly or through groups) `read` or
  `write` access to **team folders** (`/teams/<name>`) and **external storages**
  (`/storage/<name>`). Each space is a separate tree with its own root, its own change cursor and
  its own trash (§3, §5). A user never sees items of a space they have no access to (`404`, the
  existence is never revealed); administrators have no implicit access either.
- **JSON** in UTF-8. Timestamps are ISO 8601 in UTC with milliseconds (`2026-10-15T07:08:09.123Z`).
  Large or opaque numbers (cursors) are **strings**. Sizes are JSON numbers (exact up to 2^53).
- **Unknown fields:** clients **must** ignore response fields they do not know. Within v1 the server
  may add optional fields, new error codes are only added together with a new feature. (The
  conformance suite is strict by default and fails on fields `openapi.yaml` does not document, to
  catch drift in this repository; `SYNCLET_CONTRACT_LENIENT=1` allows additional fields, §14.)
- **Error format** (every Sync API error):
  `{ "statusCode": 412, "message": "…", "code": "conflict", "item"?: SyncItem }`.
  `code` is the stable machine-readable value; `message` is English diagnostics and may change.
  Clients **must** branch on `code` (and the HTTP status), never on `message`.
  Exceptions: an unknown route answers the framework's `404 {statusCode, message, error}` without
  `code`, and so does `415` for a wrong `Content-Type` on routes that are not raw-upload routes.
  tus protocol errors (§7) have plain-text bodies.

| code | Status | Meaning |
|---|---|---|
| `unauthorized` | 401 | Token missing, invalid or expired; user disabled; download token bound to another item |
| `device_revoked` | 401 | The device token was revoked → the client signs out (drops its token and local state) |
| `forbidden` | 403 | Action not allowed on this item (a space root), with this kind of token, or a write in a space the user can only read |
| `not_found` | 404 | Item or space does not exist (any more), is in the trash, or the user has no access to its space; versions disabled (§10) |
| `name_conflict` | 409 | Name taken in the target folder (`item` = the existing sibling, when indexed) |
| `invalid_move` | 400 | Move not possible (folder into itself or into its own subtree) |
| `invalid_name` | 400 | Name violates the naming rules (§4.3) |
| `invalid_request` | 400 | Anything else malformed: parameters, body, ids, content type. `415` for `preview-text` of an unsupported type (§9.2) |
| `cursor_expired` | 410 | Cursor older than the journal retention or ahead of the server → full re-enumeration |
| `conflict` | 412 | `If-Match` does not match (`item` = current server state). Status 409 on trash routes (§8.4) |
| `precondition_required` | 428 | `If-Match` missing on `PUT /items/:id/content` |
| `too_large` | 413 | Body above `maxUploadBytes` (a 413 from a reverse proxy with the same limit may have no JSON body; treat any 413 as too large) |
| `range_not_satisfiable` | 416 | `Range` outside the file (`Content-Range: bytes */<size>`) |
| `insufficient_storage` | 507 | The server's disk (or the user's quota) is full; see below. Retry later and show the problem to the user |
| `space_unavailable` | 503 | The item's space is unavailable: its storage is not mounted (`status: "missing"` in `/account`, §3). Nothing was changed; retry later and show the space as unavailable |
| `rate_limited` | 429 | Too many attempts on a public auth route; wait `Retry-After` seconds |
| `password_login_disabled` | 403 | Password login is disabled for non-admin users (SSO only) → use the browser login (§2.1) |
| `setup_done` | 409 | `POST /api/setup` after the first user exists |
| `sso_not_allowed`, `office_disabled`, `share_*`, `upload_not_allowed` | – | Web-only routes (SSO, Office, public shares); never returned by the routes in this document |

### Insufficient storage (`507`)

Every route that writes file content (upload, replace, tus completion, version restore, trash
restore, office save) answers `507 { code: "insufficient_storage", message }` when the server's file
system reports a full disk or an exceeded disk quota (`ENOSPC` / `EDQUOT`). Nothing was changed: no
item, version or journal entry exists for the failed write and no temporary file is left behind. A
tus upload whose completion hits `507` stays resumable: the uploaded bytes are kept, and an empty
`PATCH` at the final offset retries the publish once space is free. Clients treat `507` as
retryable with backoff, do not mark the item as failed for good, and tell the user that the server
is out of space.

Codes Buro had and Synclet never returns: `feature_disabled` (no modules).

---

## 2. Authentication

Token kinds:

| Token | Format | Lifetime | Use |
|---|---|---|---|
| Device token | `syd_` + 43 base64url chars | No expiry; revocable | All Sync API calls of a native client |
| Access token | JWT | 15 minutes | Web app; native apps only to register their device |
| Refresh token | `syr_` + 43 base64url chars | 30 days, rotating, single use | Native: `POST /api/auth/app/refresh`; web: httpOnly cookie |
| Download token | JWT in `?dt=` | 60 s (`download`) / 6 h (`preview`) | One item's content/thumbnail URL without `Authorization` (§6.2) |

All authenticated requests send `Authorization: Bearer <token>`. The server stores only SHA-256
hashes of device and refresh tokens; the plaintext is returned exactly once. User status is checked
on every request: a disabled user gets `401 unauthorized` for every token kind.

### 2.1 Browser login for native apps (OAuth 2.0 authorization code + PKCE, RFC 8252)

The app never asks for the password; this also works when the server uses single sign-on (OIDC or
forward-auth), because the web page handles the login.

1. Create a `code_verifier` (43–128 characters of `[A-Za-z0-9._~-]`),
   `code_challenge = BASE64URL(SHA256(code_verifier))` without padding (exactly 43 characters),
   and a random `state`.
2. Open the system browser (`ASWebAuthenticationSession`, Custom Tabs, default browser):
   `<origin>/app-login?client_id=<id>&redirect_uri=<uri>&code_challenge=<c>&code_challenge_method=S256&state=<s>`
   (optional `&login_hint=<username or email>`). The page validates the client
   (`GET /api/auth/app/client?clientId=&redirectUri=` → `{ id, name }` or `400`), signs the user in
   (password → `POST /api/auth/app/authorize`; existing web session or SSO →
   `POST /api/auth/app/authorize/session`) and never redirects to an unvalidated URI.
3. The browser returns to `<redirect_uri>?code=<code>&state=<s>`. The app **must** check `state`.
4. `POST <origin>/api/auth/app/token` with JSON `{ code, codeVerifier, clientId, redirectUri }`
   → `200 { accessToken, refreshToken, user: PublicUser }`. The code is valid for **60 s** and only
   **once**; a wrong verifier, client or redirect URI, an expired or used code → `400 invalid_request`
   (a wrong verifier does not consume the code). A disabled user → `401`.
5. Continue with the device registration (§2.2) using `accessToken`. The device token is the
   long-lived credential; the access token expires after 15 minutes. An app that does not need the
   refresh token afterwards should end that session with `POST /api/auth/logout` and the header
   `Cookie: synclet_refresh=<refreshToken>` (`204`), so no unused session stays active for 30 days.

| `client_id` | `redirect_uri` (exact match) |
|---|---|
| `ios`, `android`, `macos` | `synclet://oauth` |
| `windows`, `linux` | `http://127.0.0.1:<port>/callback` (loopback, any port 1–65535) |

Other routes of the flow (used by the web page, listed for completeness):
- `POST /api/auth/app/authorize` `{ login, password, clientId, redirectUri, codeChallenge, codeChallengeMethod: "S256" }`
  → `{ code }`. `401 unauthorized` for wrong credentials, `403 password_login_disabled` for a
  non-admin when the admin disabled password login.
- `POST /api/auth/app/authorize/session` (Bearer **web access token**) `{ clientId, redirectUri, codeChallenge, codeChallengeMethod }`
  → `{ code }`. A device token is refused with `403 forbidden` (a device token can never be turned
  into a session).
- `POST /api/auth/app/refresh` `{ refreshToken }` → same body as `/token`, with a **new** refresh
  token. Refresh tokens rotate: re-using a spent one is treated as theft and revokes **all**
  sessions of the user (`401`).

All `/api/auth/app/*` routes are rate-limited per client IP (`429 rate_limited` with `Retry-After`);
password attempts additionally per IP + login name.

Password login (`POST /api/auth/login` `{ login, password }` → `{ accessToken, user }`, refresh token
as httpOnly cookie) is meant for the web app. A client may offer it as a fallback; it must then
handle `403 password_login_disabled` by switching to the browser login.

### 2.2 Device registration

`POST /sync/v1/devices` (any valid token)
Body `{ "name": "Jens's MacBook", "platform": "ios"|"android"|"macos"|"windows"|"linux"|"web", "appVersion": "1.0.0", "installationId"?: "<string ≤ 128>" }`
(`name` 1–100, `appVersion` 1–40 characters) → `201 { device: SyncDevice, token: "syd_…", account: SyncAccount }`.

- The token is shown **only once**. Store it in the keychain / credential store.
- `installationId`: a stable, hashed identifier of the installation (iOS: identifierForVendor,
  macOS: hardware UUID, Windows: MachineGuid, Android: ANDROID_ID, Linux: `/etc/machine-id` – each
  SHA-256). Registering again for the same user and platform **revokes** the older, non-revoked
  devices with the same `installationId` (without one: with the same `name` and no
  `installationId`) instead of piling up entries.
- `lastSeenAt` is updated at most once per minute.

```ts
SyncDevice = { id: string /* uuid */, name, platform, appVersion, createdAt: string,
               lastSeenAt: string | null,
               current?: boolean }  // in GET /devices on every entry: true for the calling device token
```

- `GET /sync/v1/devices` → `SyncDevice[]` (own, not revoked, oldest first).
- `DELETE /sync/v1/devices/current` (device token only, else `400 invalid_request`) → `204`. Sign-out.
- `DELETE /sync/v1/devices/:id` → `204`; `404 not_found` for unknown, revoked, foreign or
  malformed ids.
- `PUT /sync/v1/devices/current/push` `{ "token": "<hex>", "environment": "sandbox"|"production" }`
  → `204`. Accepted and ignored until APNs support arrives (Phase 3); clients may already send it.

A revoked device token answers `401 device_revoked` on every route: the client drops the token,
removes its sync root / domain and asks the user to sign in again.

### 2.3 First-run setup

`GET /api/setup/status` → `{ needsSetup: boolean }`. On a fresh instance the web wizard calls
`POST /api/setup` `{ username, displayName, email?, password (10–200) }` → `201 { accessToken, user }`
(first administrator). Clients do not use these; the conformance suite can (`SYNCLET_SETUP=1`).

---

## 3. Account and capabilities

`GET /sync/v1/account` →

```ts
SyncAccount = {
  userId: string, email: string | null, displayName: string,
  organizationId: string,      // "<serverId>:<userId>" – stable sync-root / domain identifier
  organizationName: "Synclet",
  slug: string,                // the username (= the user's folder name on the server)
  canWrite: true,
  spaces: SyncSpace[],         // top-level spaces the user can read, see below
  areas: { personal: true, shared: false, customers: false, projects: false },
  quotaBytes: number,          // 0 = no quota
  usedBytes: number,           // sum of the sizes of the live files of the personal space
  maxUploadBytes: number,      // per file (upload, replace, tus)
  cursor: string               // current change cursor of the personal space
}

SyncSpace = {
  id: string,                  // API space id: "personal" for the user's own files, else the space uuid
  kind: "personal" | "shared" | "external",   // shared = team folder, external = external storage
  name: string,                // personal: "Meine Dateien" (the server has no UI language – localize by `kind`);
                               // others: the folder name on the server
  rootId: string,              // the space's root folder id; use as `parentId` / `children` id
                               // ("root" for personal, "r_<uuid>" otherwise)
  canWrite: boolean,           // false with read access only, on a read-only mount, or while missing
  status?: "available" | "missing"  // missing: storage not mounted (content → 503); absent = available
}
```

Spaces (Phase 4):

- `spaces` lists every space the user can read, in this order: the personal space, then team
  folders (`shared`), then external storages, each group by name. Example:
  ```json
  [{ "id": "personal", "kind": "personal", "name": "Meine Dateien", "rootId": "root", "canWrite": true, "status": "available" },
   { "id": "6f1c…", "kind": "shared", "name": "Familie", "rootId": "r_6f1c…", "canWrite": true, "status": "available" },
   { "id": "93ab…", "kind": "external", "name": "NAS", "rootId": "r_93ab…", "canWrite": false, "status": "missing" }]
  ```
  Phase 2 servers return exactly the personal space (without `status`).
- **Space ids** are stable: `personal` always means the caller's own space; other spaces use their
  uuid. The same id appears as `?space=` (§5), `SyncItem.spaceId` (§4) and in SSE events (§5a).
- **Roles:** `write` (everything `canWrite` allows) or `read` (list, download, previews, versions,
  search – every write answers `403 forbidden`). The highest role from direct and group membership
  counts; a read-only mount limits it to `read`.
- **Missing spaces** (`status: "missing"`, the storage is not mounted) stay in the list with
  `canWrite: false`; every content route of the space (items, children, changes, downloads,
  uploads) answers `503 space_unavailable` until it is back. The server keeps its index: no
  deletes are reported for a missing space. Clients show it as unavailable and retry later.
- **The list changes** when an administrator grants or revokes access, renames a team folder,
  removes or restores a space, or a storage goes missing or comes back. Open event streams receive
  `account` (§5a); reload `/account` then. A space that disappeared from the list is gone for this
  user (its ids answer `404`): drop its local state. A new space starts with its own enumeration
  (`children` of its `rootId`, §4.6) and cursor.
- The virtual top level that lists the spaces is client-side and read-only: a client never creates, moves or
  renames anything into or out of it, only inside a space (moves *between* spaces are allowed, §8.2).
- A client that meets an unknown `kind` shows the space as an ordinary folder.
- Clients store sync state (cursor, pins) per space.
- `areas` stays for Buro compatibility; new clients use `spaces`.

- The client's domain / sync-root identifier is `organizationId`. `serverId` is generated once per
  installation, so two Synclet servers (or a reinstalled one) never share a domain.
- Display the account as `displayName` (`slug`) at `<origin>`.

`GET /sync/v1/capabilities` (Phase 1c) →
`{ versions: boolean, office: { enabled: boolean, url: string | null } }`.
A server that answers `404` on this route (no `code`) predates Phase 1c: treat it as
`{ versions: false, office: { enabled: false, url: null } }`. Clients hide version UI when
`versions` is false. `office` concerns the web editor only; `enabled` is true only when the
Document Server URL and its shared secret are both configured (`url` is `null` otherwise).

---

## 4. Items

```ts
SyncItem = {
  id: string,                // "root" | "r_<uuid>" (space root) | "d_<uuid>" (folder) | "f_<uuid>" (file)
  parentId: string | null,   // null only for space roots; top-level items: their space's rootId
  type: "folder" | "file",
  kind: "root" | "folder" | "file",
  name: string,              // display name (§4.3), unique per parent
  size: number,              // bytes; folders 0
  mime: string | null,       // from the file extension; null for folders
  version: number | null,    // content version (files, starts at 1); null for folders
  sha256: string | null,     // hex; null for folders and for files not hashed yet
  etag: string,              // for If-Match on PATCH (opaque, §4.4)
  contentEtag: string | null,// "v<version>" for files; null for folders
  createdAt: string,         // when Synclet first indexed the item
  modifiedAt: string,        // content mtime on disk (files); folders: mtime when indexed/moved
  documentId: string | null, // files: equal to id (Buro compatibility); null for folders
  capabilities: { read: true, write: boolean, rename: boolean, move: boolean,
                  delete: boolean, addChildren: boolean },
  preview?: { kind: "image"|"pdf"|"text"|"markdown"|"code"|"video"|"audio"|"none",
              thumbnail: boolean, language?: string },  // files only (§9)
  spaceId?: string           // API id of the item's space ("personal" or the space uuid);
                             // absent from older servers = personal
}
```

### 4.1 Identifiers

| id | kind | Meaning | parentId |
|---|---|---|---|
| `root` | root | Root of the personal space (the user's folder); `name` = username; `etag` = `t0`, `createdAt`/`modifiedAt` = epoch | `null` |
| `r_<uuid>` | root | Root of the team folder or external storage `<uuid>` (= its space id); `name` = space name; never renamed, moved or deleted; `addChildren` only with write access | `null` |
| `d_<uuid>` | folder | A directory below a space root | `root`, `r_…` or `d_…` |
| `f_<uuid>` | file | A regular file | `root`, `r_…` or `d_…` |

- `<uuid>` is lowercase, canonical form. Ids are **stable**: renames and moves through the API keep
  them; so do renames/moves made directly on the server's disk when the server can pair them
  (same path, or same inode within a short window). Otherwise a host-side move appears as delete
  + create (new id). Restoring from the trash brings the original ids back.
- Item ids are unique across spaces and stay the same when an item is moved to another space (§8.2).
- A malformed id (anything but `root`, `r_<uuid>`, `d_<uuid>`, `f_<uuid>`) → `400 invalid_request`.
  A well-formed id of the wrong type (`d_` of a file, `f_` of a folder) → `404`.
- Symlinks, sockets and other special entries on disk are never items.

### 4.2 Paths

Items carry **no path**. Clients derive an item's path from the chain of `parentId`s (child path =
parent path + `/` + `name`). A folder rename or move therefore changes the paths of its whole
subtree while only the folder itself is reported (§5).

### 4.3 Names

**Validation** (folder creation, uploads, renames; else `400 invalid_name`): not empty, not `.` or
`..`; none of `< > : " / \ | ? *` or control characters U+0000–U+001F; no trailing space or dot;
not a Windows reserved name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, also with an
extension, case-insensitive); at most 255 bytes UTF-8 after NFC normalization; not an ignored name
(`.DS_Store`, `.Spotlight-V100`, `.Trashes`, `.fseventsd`, `.TemporaryItems`, `.localized`,
`Thumbs.db`, `desktop.ini`, `$RECYCLE.BIN`, `@eaDir`, `#recycle`, `lost+found`, `._*`, `~$*`,
`~WRL*.tmp`, `.~lock.*#`, `.synclet-tmp-*`, `.synclet-trash-*`). New names are stored in **NFC**.

Clients **must not** upload ignored names and should skip them locally (they are never synced).
Files created on the server's disk may have names that are invalid for Windows clients; the
Windows client maps such names reversibly on its side (the server never renames anything on disk).

**Name key:** `NFC(name).toLowerCase()`. Two siblings collide when their name keys are equal.
Files and folders share one namespace.

**Display names.** Through the API no two siblings can get the same name key, but the disk can
contain them (a case-sensitive file system with `a.txt` and `A.txt`, or NFC and NFD variants).
`name` is therefore a **display name**, unique per parent:

1. Rank the live siblings: folders before files; within a group older `createdAt` first, then id.
2. In that order every item keeps its stored name while its name key is still free in the parent.
3. The remaining items get, in rank order, the first free suffixed name:
   files `"<base> (n).<ext>"`, folders `"<name> (n)"`, n = 2, 3, … (`<base>`/`<ext>` = split at the
   last dot that is not at position 0, so `.env` → `.env (2)`, `a.tar.gz` → `a.tar (2).gz`).

- Deterministic: depends only on the set of siblings, not on paging or request order; identical in
  `GET /items/:id`, `children`, `changes`, `search` and `recent`.
- The display name is not stored. When a create, rename, move or delete changes the display name of
  a sibling with the same name key, that sibling is reported as an `upsert` in `/changes`.
  *Known limitation:* a sibling whose display name changes only because a newly created name equals
  its **suffixed** display name (e.g. creating `A (2).txt` next to the disk pair `a.txt`/`A.txt`) is
  not reported until it changes otherwise. Clients must accept a different `name` for a known id in
  any later upsert.
- `PATCH` with `name` equal to the current display name keeps the stored name (§8.2).
- Collision checks of the API (§6.4, §8) compare against the stored names' keys.

### 4.4 ETags

- **Files:** `etag = contentEtag = "v<version>"`. `version` increases by one with every content
  change: replace via the API, a version restore, an Office save, and edits made directly on the
  server's disk (detected by a size or modification-time change). Renames and moves do not change it.
- **Folders:** `etag` is opaque (`t` + 16 hex characters, root: `t0`). It changes when the folder
  itself is renamed or moved or its display name changes – each such change is also reported in
  `/changes` – and not when descendants or ancestors change. Clients compare etags only for
  equality.
- **HTTP ETags** of content responses are the quoted `contentEtag` (`"v3"`).

### 4.5 Capabilities

Capabilities follow the user's role in the item's space (§3):

- **write:** `root` → `write: true, addChildren: true, rename/move/delete: false`; `r_…` →
  `addChildren: true`, everything else `false` except `read`; folders → all `true`; files → all
  `true` except `addChildren: false`.
- **read:** everything `false` except `read` (roots, folders and files alike).

Clients **must** honor the flags: a write the flags do not allow answers `403 forbidden`.

### 4.6 Endpoints

- `GET /sync/v1/items/:id` → `SyncItem`. `404` when unknown, trashed or in a space without access;
  `503 space_unavailable` while its space is missing.
- `GET /sync/v1/items/:id/children?pageToken=&limit=` → `{ items: SyncItem[], nextPageToken: string | null, cursor: string }`
  - `limit`: `floor(limit)`; missing, non-numeric or `0` (also `0.x`) → the default 500; then
    clamped to 1..1000 (negative → 1, above 1000 → 1000).
  - Order: all folders, then all files; within each group by id. `pageToken` is an opaque keyset
    marker (not an offset): items created or deleted between pages never cause duplicates or
    skipped survivors. `nextPageToken` is `null` on the last page.
  - `cursor` is the change cursor of the folder's **space** **before** the first page was read: start
    `/changes?space=<that space>` from it after the enumeration and nothing is missed (use the
    cursor of the first page).
  - Children of a file, a malformed `pageToken` → `400 invalid_request`; unknown folder → `404`.

---

## 5. Changes

- `GET /sync/v1/cursor?space=<id>` → `{ cursor: string }` (current head of that space).
- `GET /sync/v1/changes?space=<id>&cursor=<c>&limit=<n>` →
  ```ts
  { changes: ({ op: "upsert", item: SyncItem } | { op: "delete", id: string })[],
    cursor: string, hasMore: boolean }
  ```
  `limit`: same rule as for `children` (missing, non-numeric or `0` → 500; then clamped to 1..1000).

**Spaces.** Every space has its own journal and cursor. `space` is an API space id from
`/account` (`personal` or the space uuid) and defaults to `personal`, so clients without space
support keep working unchanged. A space without access (or a malformed id) → `404 not_found`;
a missing space → `503 space_unavailable`. A cursor is only valid for the space it came from.

**Cursor.** Opaque string. Clients store it (per space) and send it back; they must not parse it,
compare it by order or compute with it. A cursor is per space, not per device.

**Semantics.**
- The page contains every item of the space that changed after `<c>`, **coalesced**: each id at most
  once, ordered by the time of its latest change. Every `upsert` carries the item's state at the
  time of the request (not the state of the change); an item that no longer exists is a `delete`.
  An item created and deleted after `<c>` is reported as `delete` – clients must ignore deletes of
  unknown ids.
- While `hasMore` is `true`, call again with the returned `cursor` immediately. When `hasMore` is
  `false`, the returned `cursor` is the head; store it after the page has been applied.
- **Ordering across items is not causal.** An upsert may reference a `parentId` that appears later
  in the same page or a later page (e.g. a folder renamed after a file was created inside it).
  Apply all pages of one drain as a whole; if a parent is still unknown afterwards, fetch it with
  `GET /items/:id`.
- What is reported:
  - create, rename, move, content replace, version restore → `upsert` of the item;
  - folder rename/move → only the folder (children keep their ids and are not listed; their paths
    change implicitly, §4.2);
  - delete (to the trash, §8.3) → `delete` for the item **and every descendant**;
  - restore from the trash → `upsert` for every restored item, with the original ids;
  - move to another space (§8.2) → `delete` for the item and every descendant in the **old**
    space, `upsert` for each of them (same ids) in the **new** space. Apply the delete only after
    draining the new space too, or match by id, if you want to keep local content;
  - siblings whose display name changes (§4.3) → `upsert`;
  - changes made directly on the server's disk, once the server noticed them (file watcher, best
    effort, plus a periodic rescan, by default every 15 minutes): create/delete/rename/move as above,
    content edits as `upsert` with `version + 1` (and `sha256: null` until re-hashed).
- What is **not** reported (clients see it on the next read of the item): `sha256` becoming known
  after hashing, `preview.thumbnail` becoming `true`.
- `410 cursor_expired` when `<c>` is older than the journal retention (`SYNCLET_JOURNAL_RETENTION_DAYS`,
  default 30) or ahead of the server's head (e.g. after a server restore). The client then
  re-enumerates the space from its `rootId` (keeping ids it already knows: ids are stable) and
  continues with the enumeration's cursor. (A space an administrator removed and restored is
  re-indexed with new ids; clients dropped its state when it left `/account`, §3, and start over.)
- Missing or malformed `cursor` (anything but 1–19 decimal digits) → `400 invalid_request`.

**Recommended client loop:** per space, on first sync take the first `children` page's cursor of
its `rootId` (for the personal space also `account.cursor`), enumerate, then poll `/changes?space=` (File Provider: on `enumerateChanges`; Windows: on a timer,
e.g. every 30 s, and after local writes). To learn about remote changes without delay, keep the
event stream open (§5a) and drain `/changes` on each event; poll only while it is disconnected.
APNs pushes follow in Phase 3.

---

## 5a. Events

`GET /sync/v1/events` is a long-lived [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
stream that tells a client **that** the journal of one of its spaces advanced, or that its space
list changed. It never carries the changes themselves.

- **Authentication:** device token (`Authorization: Bearer syd_…`) or web access token.
  `401 unauthorized` / `401 device_revoked` as for every other route.
- **Response:** `200`, `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`,
  `X-Accel-Buffering: no`. UTF-8, one event per block, blocks separated by a blank line:

  ```
  event: hello
  data: {"cursor":"1234","cursors":{"personal":"1234","6f1c…":"87"}}

  event: changes
  data: {"space":"personal","cursor":"1240"}

  event: changes
  data: {"space":"6f1c…","cursor":"90"}

  event: account
  data: {}

  : ping

  event: bye
  data: {"reason":"too_many_streams"}
  ```

| Event | `data` | Meaning |
|---|---|---|
| `hello` | `{ cursor, cursors }` | First event of every stream. `cursor` is the personal space's head (as in `GET /account`); `cursors` maps the API id of every readable space to its head (`personal` included). |
| `changes` | `{ space, cursor }` | New journal entries of the space `space` (its API id: `personal` or the uuid) were committed; `cursor` is that space's head at the time of the event. Bursts are coalesced per space: at most one event per 250 ms. |
| `account` | `{}` | The user's space list or rights changed (access granted or revoked, directly or through a group; a space renamed, created, removed, restored, gone missing or back). Reload `GET /account` (§3). The stream already follows the new set of spaces: `changes` arrive for added spaces and stop for removed ones. The `data` line is always `{}`; ignore its content. |
| `bye` | `{ reason }` | The server ends the stream right after this event. `too_many_streams`: the user opened another stream (see limits). `unauthorized`: the token is no longer valid (device revoked, user disabled, access token expired); reconnecting returns the matching `401`. `server_shutdown`: the server is stopping; reconnect after a short delay (with backoff). Clients must accept unknown reasons. |

- **Ping:** a comment line `: ping` every 25 s (`SYNCLET_EVENTS_PING_SECONDS` on the server).
  Before each ping the server re-checks the token; a revoked device or disabled user's stream ends
  at the latest at the next ping. It also compares each space's cursor with the last one it sent on
  the stream and sends `changes` first if they differ, and sends `account` when the set of readable
  spaces changed, so a notification lost inside the server is signalled at the latest with the
  next ping. A client that has seen nothing (no event, no ping) for about
  60 s should treat the connection as dead and reconnect.
- **Wake-up only.** An event is a hint, never data: on `hello` drain every space, on `changes`
  drain `GET /sync/v1/changes?space=<space>&cursor=<stored cursor of that space>` as usual (§5) and
  store the resulting cursor; on `account` reload `/account` and start or drop spaces accordingly. The
  event's `cursor` may only be used to skip a drain when it equals the stored cursor. Events can be
  lost (proxy restarts, server restarts, network changes); because the client drains once after
  every (re)connect, a lost event only delays a change, it never loses one. Changes made directly
  on the server's disk are signalled once the server's indexer has noticed them (§5).
- **Reconnect:** on any disconnect, reconnect with exponential backoff from 1 s up to 60 s (with
  jitter), reset after a stream stayed open for a while. Honour a `retry:` field if the server ever
  sends one. Do not reconnect on `401` (sign-in required) and back off to the maximum on
  `404` (server without events), `429` or a response that is not `text/event-stream` (e.g. an HTML
  page from a misconfigured proxy); keep polling `/changes` meanwhile.
- **Limits:** at most 10 open streams per user (per server); opening an 11th closes the oldest
  with `bye` `too_many_streams`. At most 30 stream opens per user per minute; more yield
  `429 rate_limited` with `Retry-After`. One stream per signed-in account and device is enough.
- **Proxies:** the stream must not be buffered or compressed. The bundled Caddy flushes
  immediately and does not compress `/api/*`. Outer reverse proxies work unchanged as long as their
  upstream read timeout exceeds 25 s (see README, "Behind another reverse proxy").

---

## 6. Content

### 6.1 Download

`GET /sync/v1/items/:id/content` (files only; a folder → `400 invalid_request`)

- Response headers: `ETag: "v<version>"`, `Content-Length`, `Content-Type` (from the extension,
  `application/octet-stream` if unknown), `Accept-Ranges: bytes`, `Last-Modified` (content mtime,
  HTTP date with second precision), `Cache-Control: private, no-store`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and, except for PDFs, a
  sandboxing `Content-Security-Policy`.
- `?download=1` adds `Content-Disposition: attachment; filename="<ASCII fallback>"; filename*=UTF-8''<name>`.
- `Range`: exactly one range `bytes=a-b`, `bytes=a-` or `bytes=-n` → `206` with
  `Content-Range: bytes a-b/<size>`. `b` beyond the end is clamped. Other forms (several ranges,
  other units) are ignored → `200` with the whole file. A range starting at or after the end, `-0`,
  or `a > b` → `416 range_not_satisfiable` with `Content-Range: bytes */<size>` (and a JSON error body).
  Every range on an empty file is unsatisfiable.
- `If-None-Match` containing the current tag (`"v3"`, `W/"v3"`, in a list) or `*` → `304`.
- `If-Range`: the range is honored only if the validator is the current **strong** tag (`"v3"`) and
  the file on disk is still exactly the indexed one, or an HTTP date equal to the current
  `Last-Modified`; otherwise the full file comes back with `200` (never spliced bytes). Resuming
  downloads **should** send `If-Range: "v<version>"`.
- The bytes always come from disk: if the file was edited on the server's disk and not indexed yet,
  `Content-Length` and content describe the new bytes while `ETag` still names the old version.
  Clients verifying `sha256` must therefore treat a mismatch as "changed, refetch metadata".

### 6.2 Download tokens (URLs without `Authorization`)

`POST /sync/v1/items/:id/download-token?purpose=download|preview` (files only) →
`201 { url, token, expiresAt }`.

- `download` (default): valid 60 s; `url = /api/sync/v1/items/<id>/content?download=1&dt=<token>`
  (attachment). For handing a download to a system downloader or browser.
- `preview`: valid 6 h; `url = /api/sync/v1/items/<id>/content?dt=<token>` (inline).
- Either kind of token is accepted by `GET /items/<id>/content`, `GET /items/<id>/thumbnail` and
  the version content route (§10) of the **same** item; the purpose only sets the lifetime and the
  `url` form (the server does not check the purpose on these routes).
- The token is bound to the item id; for any other item it answers `401 unauthorized`. It is only
  accepted on those content/thumbnail/version-content routes. `url` is path-only: prefix it with the origin.
- A folder → `400 invalid_request`; an unknown `purpose` → `400`.

### 6.3 Replace

`PUT /sync/v1/items/:id/content` (files only) – **raw bytes in the body** (no multipart)

- Headers: `If-Match: "v<version>"` (**required**; quoted or bare; `W/` is stripped) or `If-Match: *`,
  `Content-Type: application/octet-stream` (**always**; anything else → `400 invalid_request`),
  `Content-Length` (above `maxUploadBytes` → `413 too_large` before any byte is read), optional
  `X-Synclet-Modified-At: <ISO 8601>` (alias `X-Buro-Modified-At`; `X-Synclet-…` wins; invalid
  values are ignored). Empty bodies (0 bytes) are allowed.
- Missing `If-Match` → `428 precondition_required`.
- Success → `200 SyncItem` with `version + 1`, new `contentEtag`, `size`, `sha256`, and
  `modifiedAt` = the given modification time (else the server's write time). With versions enabled
  (§10) the previous content becomes a version.
- `If-Match` not matching the current version (also an unknown etag format) →
  `412 { code: "conflict", item }` with the current server state. Nothing is written.
- `If-Match: *` replaces whatever version is current – **except** a change on the server's disk that
  was not indexed yet: the server records that edit as a new version first and answers `412` with it.
  Host edits are never silently overwritten.
- The write is atomic (temp file on the same file system, then rename over the target); readers
  see either the old or the new content.

**Conflict handling (client):** on `412` the client keeps its local content as a **conflict copy**
uploaded with `POST /items/upload?onConflict=rename` into the same folder, named
`"<base> (Conflict <device name> <YYYY-MM-DD HH-mm>).<ext>"` (localized clients may translate
"Conflict"; Buro used "Konflikt"), and then downloads the server state for the original item.

### 6.4 Upload (new file)

`POST /sync/v1/items/upload?parentId=<id>&name=<urlencoded>&onConflict=fail|rename`

- Raw body; headers as for `PUT` without `If-Match`. `parentId` defaults to `root`.
- → `201 SyncItem` (version 1).
- Collision (same name key as an existing sibling, file or folder): `onConflict=fail` (default) →
  `409 name_conflict` with `item` = the existing sibling; `rename` → the first free
  `"<base> (2).<ext>"`, `(3)`, … (folders: `"<name> (2)"`, §4.3).
- Unknown parent → `404`; a file as parent → `400 invalid_request`; invalid name → `400 invalid_name`;
  invalid `onConflict` → `400 invalid_request`.
- Large files should use tus (§7); this route is fine for small files and is not resumable.

---

## 7. Resumable uploads (tus 1.0)

Endpoint: `<origin>/api/sync/v1/uploads` – tus 1.0.0 core protocol with the `creation`,
`creation-with-upload`, `termination` and `expiration` extensions (`OPTIONS` also advertises
`creation-defer-length`; clients should always send `Upload-Length`, deferred lengths are not
covered by this contract). Authentication: `Authorization: Bearer`
(device or access token) on every request except `OPTIONS`.

1. `POST /sync/v1/uploads` with `Tus-Resumable: 1.0.0`, `Upload-Length: <bytes>` and
   `Upload-Metadata` (tus encoding: `key base64(value)` pairs separated by commas):
   - `name` (required, validated as §4.3 → `400 invalid_name`),
   - `parentId` (default `root`; unknown → `404 not_found`, malformed or a file → `400`),
   - `onConflict`: `rename` (**default for tus**) or `fail`,
   - `modifiedAt`: ISO 8601 (invalid → `400`).

   **Replace an existing file** (resumable `PUT /items/:id/content`, for large files): send
   `itemId` (a file id `f_…`) and `ifMatch` (the file's content etag `v<n>`) instead of
   `name`/`parentId`/`onConflict`; `modifiedAt` is optional.
   - `name`, `parentId` or `onConflict` together with `itemId` → `400 invalid_request`; `ifMatch`
     without `itemId` → `400 invalid_request`; a malformed or non-file `itemId` (folder, `root`) → `400`.
   - `itemId` without `ifMatch` → `428 precondition_required`.
   - Unknown, trashed or foreign item → `404 not_found`. No upload is created for any of these errors.
   - `ifMatch` not matching the current version (also an unknown etag format) already at creation →
     `412 { code: "conflict", item }`.
   - At completion the server checks `ifMatch` again under the same rules as §6.3 (including the
     unindexed host edit rule). Mismatch → `412 { code: "conflict", item }`, the staged upload is
     dropped (`HEAD` → `404`) and the file is untouched: the client takes the conflict path of §6.3.
     Match → the content replaces the file atomically (`version + 1`, new `contentEtag`, journal
     upsert, previous content becomes a version when enabled, §10).
   - The completing request answers like a create (step 4) with the updated `SyncItem` (same
     `id`; `X-Synclet-Item` = that id). `507` at completion keeps the upload resumable (below).
   - `Tus-Max-Size` applies as for creates.
   - `ifMatch: *` is not supported for tus: only `v<n>` (anything else → `412`).
   → `201` with a path-only `Location: /api/sync/v1/uploads/<uploadId>`. `Upload-Length` above
   `Tus-Max-Size` (= `maxUploadBytes`) → `413`.
2. `PATCH <Location>` with `Upload-Offset: <current offset>` and
   `Content-Type: application/offset+octet-stream` → `204` with the new `Upload-Offset`.
   A wrong offset → `409` (plain-text tus error, nothing appended).
3. After an interruption: `HEAD <Location>` → `200` with `Upload-Offset` and `Upload-Length`
   (`Cache-Control: no-store`); continue with `PATCH` from that offset. Bytes received before a
   connection drop are kept.
4. The request that completes the upload (the final `PATCH`, or the `POST` itself for empty files and
   creation-with-upload of all bytes) publishes the file atomically and answers with the new
   `SyncItem` as JSON body and `X-Synclet-Item: <id>`: `200` for a `PATCH`, `201` (with `Location`)
   for a `POST`. Nothing appears in the user's folder before that moment.
5. A conflict at completion with `onConflict=fail` → `409` JSON `name_conflict` (with `item`); other
   publish errors also answer in the Sync error format. Client errors (conflict, parent gone) drop
   the upload (`HEAD` → `404`); a server-side failure keeps it, and an empty `PATCH` at the final
   offset retries the publish.

- `DELETE <Location>` → `204` terminates an unfinished upload.
- `PATCH` and `DELETE` answer `423` while the upload is being published (by a concurrent
  completing request): wait and check with `HEAD` (which is not blocked).
- Unfinished uploads expire after 24 h (`410`). Uploads of other users are indistinguishable from
  unknown ones (`404`). Upload ids are opaque.

---

## 8. Structure changes

### 8.1 Create a folder

`POST /sync/v1/items` `{ "parentId": "<id>", "type": "folder", "name": "…", "onConflict"?: "fail"|"rename" }`
→ `201 SyncItem`. Collisions as in §6.4 (`rename` → `"<name> (2)"`, …). `type` other than `folder`
→ `400 invalid_request`.

### 8.2 Rename / move

`PATCH /sync/v1/items/:id` `{ "name"?: "…", "parentId"?: "<folder id or root>" }`, optional
`If-Match: "<etag>"` (or `*`) → `200 SyncItem`.

- Files and folders can be renamed and moved anywhere within their space. Moving a folder into
  itself or its own subtree → `400 invalid_move`. A file as target → `400 invalid_request`; unknown
  target (or one in a space without access) → `404`.
- **Moving to another space:** a `parentId` in another space (a folder there or its root, e.g.
  `r_<uuid>` or `root`) moves the item with its whole subtree into that space. It needs write
  access to **both** spaces (`403 forbidden` otherwise) and both must be available (`503`). The
  server moves the entry on disk (a rename, or copy + delete when the spaces are on different file
  systems); the item and every descendant **keep their ids**, versions and share links move along.
  The response carries the new `spaceId`. `/changes` reports `delete` for the subtree in the old
  space and `upsert` for it in the new one (§5). Copying is not offered by the API.
- `If-Match` is compared with the item's `etag` as served (§4.4); mismatch → `412 conflict` with
  `item`.
- Name collision at the target (name key equal to a sibling other than the item itself) →
  `409 name_conflict` with `item`; there is no `rename` mode. Case-only renames are allowed.
- `name` equal to the current **display** name (§4.3), or absent: the stored name stays; without a
  move this is a no-op (`200` with the unchanged item). On a move the stored name is replaced by
  the display name only if the stored name is taken at the target and the display name is free.
  Any other `name` is set as given.
- Space roots (`root`, `r_…`) → `403 forbidden`.

### 8.3 Delete

`DELETE /sync/v1/items/:id` → `204`. Files and folders (with their subtree) move to the **trash of
their space**; `/changes` reports a `delete` for each of them. `root` → `403 forbidden`; unknown or
already deleted → `404`; read access only → `403`. Deletions made directly on the server's disk do
not go to the trash.

### 8.4 Trash (`/api/trash`)

Not needed for syncing; offered for clients with a trash UI. Same tokens as the Sync API.

- `GET /api/trash` → `TrashEntry[]` of every space the user can **write**, most recently deleted
  first: `{ id (uuid), itemId (sync id of the deleted item), type, name, originalPath, size,
  deletedAt, expiresAt | null, itemCount, spaceId?, deletedBy? }`. `originalPath` is relative to
  the root of the entry's space `spaceId` (API id; absent = personal); `deletedBy` is the user id of
  whoever deleted it (`null` when unknown, e.g. deleted on the server's disk). Entries expire after
  `SYNCLET_TRASH_RETENTION_DAYS` (default 30).
- `POST /api/trash/:id/restore` → `200 { item: SyncItem, restoredTo: string, renamed: boolean }` –
  back to the original folder of its space (or the space root if it is gone), under a free name if
  the original is taken, with the original ids. Needs write access to the space.
- `DELETE /api/trash/:id` → `204` (delete forever, including versions; needs write access).
  `DELETE /api/trash?space=<id>` → `200 { removed: number }` empties the trash of one space
  (default `personal`; any other space needs write access).
- `409 conflict` while an entry is being processed (e.g. right after the delete, while its content
  is still being moved into the trash store): retry after a moment.

---

## 9. Previews

### 9.1 Thumbnails

`GET /sync/v1/items/:id/thumbnail?size=256|1024` (default 256; other values → `400 invalid_request`;
folders → `400`) – accepts a download token of the same item (`?dt=`, either purpose, §6.2).

- `200 image/webp` (always re-encoded, never the original bytes), `ETag: "<sha256>-<size>"`,
  `Cache-Control: private, max-age=31536000, immutable`; `If-None-Match` → `304`. A given URL's
  bytes never change; a new content version has a new `sha256`.
- `404 not_found` until the background worker produced the thumbnail – and forever for types
  without thumbnails. Thumbnails exist for images (jpg, jpeg, png, gif, webp, avif, heic, heif, tif,
  tiff, bmp, svg), PDFs and videos (mp4, m4v, mov, webm, mkv), when the server has the needed tools.
- `preview.thumbnail` in a `SyncItem` tells whether a thumbnail existed when the item was
  serialized. It turning `true` is not journaled: clients that want a thumbnail poll this route
  with backoff (e.g. after 2 s, 5 s, 15 s, then on the next metadata read).

### 9.2 Text preview

`GET /sync/v1/items/:id/preview-text` (files of preview kind `text`, `markdown` or `code`) →
`{ text: string, truncated: boolean, encoding: "utf-8" | "latin1" }`: the first 256 KiB, decoded
as UTF-8 or, if that fails, Latin-1; NUL characters removed; `Cache-Control: no-store`. Other kinds
→ **`415`** with `code: "invalid_request"`.

`preview.kind` is derived from the extension (fallback: MIME type); `preview.language` is the
highlight.js language for `kind = "code"`.

---

## 10. Versions (Phase 1c, optional)

Versions exist in every space; listing and downloading need read access, restoring needs write.

Only when `GET /capabilities` reports `versions: true` (server setting `SYNCLET_VERSIONS=on`, off by
default). When off, every route below answers `404 { code: "not_found", message: "versions disabled" }`
for a well-formed file id, and no versions are created. Id validation comes first: a malformed id or
a folder id is `400 invalid_request` whether versions are on or off.

- A version is created when the server replaces content: `PUT /content`, Office saves and version
  restores. Edits made directly on the server's disk create no versions. The server thins out old
  versions (newest kept densely, older ones per hour/day/week) and may cap the bytes per user.
- `GET /sync/v1/items/:id/versions` → `Version[]`, newest first:
  ```ts
  Version = { id: string /* uuid */, version: number /* item version while it was current */,
              size: number, sha256: string,
              modifiedAt: string /* content mtime while current */,
              createdAt: string  /* when it was superseded */,
              source: "api" | "office" | "restore",
              createdBy: { id: string, displayName: string } | null }
  ```
- `GET /sync/v1/items/:id/versions/:versionId/content` – always an attachment named
  `"<base> (v<n>).<ext>"`, `ETag: "v<n>"`, same Range/If-None-Match/If-Range rules as §6.1; accepts
  the item's download token (`?dt=`).
- `POST /sync/v1/items/:id/versions/:versionId/restore` → `200 SyncItem`: the current content
  becomes a version (`source: "restore"`), the version's bytes become current with `version + 1`
  and the same id; reported as `upsert` in `/changes`. The restored version stays in the list.
- Versions follow the item id through renames, moves and the trash; deleting forever (or trash
  expiry) removes them.
- Folder ids → `400 invalid_request`; unknown file or version → `404`.

---

## 11. Search and recent files

- `GET /sync/v1/search?q=<1..200 chars>&limit=<1..50, default 20>&offset=<0..10000>&folder=<folder id>&space=<id>`
  → `{ hits: { item: SyncItem, path: string, snippet: string | null, matched: "name"|"content"|"both" }[], total: number }`.
  Names (case- and accent-insensitive, typo-tolerant) and extracted text (full text) of the live
  items of every space the user can read. `item.spaceId` names the hit's space; `path` is the
  parent folder path relative to that space's root (`""` = top level). `snippet` highlights
  matches with `«…»`. `folder` restricts to a subtree, `space` to one space (no access → `404`).
  Empty `q` → `400`.
- `GET /sync/v1/recent?limit=<1..200, default 50>&space=<id>` → `SyncItem[]`: live files of every
  readable space (or of `space`), newest `modifiedAt` first.

---

## 11a. Share links (/api/shares)

Public links to a file or folder. These are the **owner-side** routes (device token or web token,
paths relative to `/api`); the public side (`/api/public/shares`, the `/s/<token>` page) is a web
route and not part of this contract. Item ids are Sync ids (`d_<uuid>` / `f_<uuid>`).

`ShareLink`:

```json
{ "id": "<uuid>", "itemId": "d_…", "itemName": "Photos", "itemType": "folder",
  "url": "/s/<token>", "hasPassword": true, "expiresAt": "2026-10-17T08:00:00.000Z",
  "allowDownload": true, "allowUpload": false, "createdAt": "…", "revokedAt": null,
  "hits": 0, "itemTrashed": false, "spaceId": "personal" }
```

- `spaceId` is the API id of the shared item's space (absent from older servers = personal).
  Creating a link needs write access to the space. A link only works while its creator is enabled
  and still has write access there; otherwise it answers `404` publicly like a revoked link.

- `url` is relative (`/s/<token>`, resolve it against the server origin) unless the server has
  `SYNCLET_PUBLIC_URL` set, in which case it is absolute. It is always present for the owner and
  changes on rotate.
- `itemTrashed`: the item is in the trash; the link answers 404 publicly until the item is
  restored. Only revoking is possible meanwhile.
- `allowUpload` is only ever `true` for folders.

Routes:

- `POST /shares` `{ itemId, password?: string|null, expiresAt?: string|null, allowDownload?: boolean
  (default true), allowUpload?: boolean (default false) }` → `201 ShareLink`. `password` is 1..1024
  characters; `expiresAt` is ISO 8601 with offset and must be in the future. Unknown fields,
  `allowUpload` on a file, an invalid `itemId` or a past `expiresAt` → `400 invalid_request`;
  unknown or trashed item → `404 not_found`.
- `GET /shares?itemId=<id>` → `ShareLink[]`, newest first: the user's links that are not revoked
  (`revokedAt` is therefore always `null`), including links of trashed items. `itemId` filters.
- `PATCH /shares/:id` `{ password?, expiresAt?, allowDownload?, allowUpload? }` (same rules; omitted
  = unchanged, `null` removes password / expiry) → `200 ShareLink`. Unknown, foreign or revoked id,
  or a trashed item → `404 not_found`.
- `POST /shares/:id/rotate` → `200 ShareLink` with a new `url`; the old link stops working at once.
- `DELETE /shares/:id` → `204`, idempotent. The link is revoked: it disappears from the list and
  from then on `PATCH`/rotate answer `404`. Unknown or foreign id → `404 not_found`.

---

## 12. Not part of this contract (yet)

- APNs pushes – Phase 3 (`PUT /devices/current/push` is already accepted).
- Office editing (`GET /sync/v1/items/:id/office`, `POST /sync/v1/items/new-office`), public share
  routes (`/api/public/shares`; the owner side is §11a), admin routes (`/api/admin/*`) and SSO (`/api/auth/oidc/*`,
  `/api/auth/forward`) are web-app routes and may change without notice to native clients.
- Pinning ("always keep offline") is purely client-side.
- Administration of groups, team folders and external storages (`/api/admin/groups`,
  `/api/admin/spaces`) is a web-app route; native clients only see its effects (`/account`, `account` events).

---

## 13. Differences from Buro SYNC_API v1 (porting checklist)

| Topic | Buro | Synclet |
|---|---|---|
| Base URL | `https://<slug>.<BASE_DOMAIN>/api/sync/v1`, tenant from subdomain/token | `<origin>/api/sync/v1`, no tenant |
| Module/permission checks | `files.storage`, `documents:read/write`, `403 feature_disabled` | per space: role `read`/`write` (capabilities, `SyncSpace.canWrite`); account `canWrite` always true |
| Login | `POST /api/auth/login {email, password, subdomain?}`; app token response has `slug`, `organizationName` | `{login, password}`; app token response `{accessToken, refreshToken, user}`, then register the device against the same origin |
| App login redirect | `buroapp://oauth`; windows loopback | `synclet://oauth` (`ios`, `android`, `macos`); loopback for `windows` **and** `linux`; `code_challenge_method=S256` must be sent |
| Device token prefix | `bsd_` | `syd_` |
| Device platforms | ios, android, macos, windows | + `linux`, `web` |
| Account | real organization, areas by module | `organizationId = "<serverId>:<userId>"`, `organizationName = "Synclet"`, `slug` = username, only `personal` area, `quotaBytes = 0`; top-level `spaces` (personal, team folders as `shared`, `external`) with `status` |
| Ids / kinds | `root`, areas (`personal`, `shared`, …), `c_`, `p_`, `o_`, `d_`, `f_`, `l_` | only `root`, `r_<uuid>` (space roots), `d_<uuid>`, `f_<uuid>`; `kind` ∈ root, folder, file; top-level items have their space's `rootId` as `parentId`; `SyncItem.spaceId` |
| Spaces | areas, one journal per organization | one journal and cursor per space: `?space=` on `/cursor` and `/changes`, `hello.cursors`, `changes.space`, SSE `account`; moves between spaces keep ids; `503 space_unavailable` for unmounted storages |
| Links | `l_…` items | none; share links are separate objects, §11a |
| Folder etag | `t<updatedAtMs>` | opaque `t…`, stable across ancestor moves |
| Version counting | API writes only | also counts edits made on the server's disk |
| Modified-at header | `X-Buro-Modified-At` accepted, not evaluated | `X-Synclet-Modified-At` (alias `X-Buro-Modified-At`) **sets** the file's mtime / `modifiedAt` |
| `If-Match: *` on PUT | – | allowed (never overwrites an unindexed host edit) |
| Resumable upload | – | tus 1.0 at `/api/sync/v1/uploads` |
| Thumbnails, text previews, download tokens | – | §6.2, §9; `SyncItem.preview` |
| Versions, capabilities | – | §10, §3 |
| Search, recent | – | §11 |
| Share links | – | §11a |
| Changes | trigger-based journal, BIGSERIAL cursor | journal written in the same transaction as the change; per-space sequence; same `410` semantics |
| Subtree delete in `/changes` | folder only | folder **and** every descendant |
| Name validation | Buro rules | Windows-safe rules of §4.3 (reserved names, trailing dot/space, 255 bytes), ignored names |
| Error codes | – | adds `rate_limited`, `password_login_disabled`, `setup_done`, `insufficient_storage` (507), `space_unavailable` (503) and web-only codes; drops `feature_disabled` |
| Conflict copy name | `(Konflikt <device> …)` | `(Conflict <device> …)` (translatable) |

---

## 14. Conformance suite

`packages/sync-contract` contains `openapi.yaml`, a minimal client and a vitest suite that runs
against a **live** server. Every test creates its data below one top-level folder
`contract-<random>`, which the suite deletes at the end (and removes from the trash); the suite
also revokes the device it registered and logs out the sessions it opened. It never touches
anything else of the account, with one exception: with an administrator's web token the spaces test
creates and finally removes a team folder `contract-team-<random>` (the empty folder stays on the
server's disk, see the suite's README).

```bash
# against a running server, with an existing account
SYNCLET_URL=http://localhost:8080 SYNCLET_USER=admin SYNCLET_PASSWORD=… pnpm test:contract
# or with a token (device token or web access token)
SYNCLET_URL=… SYNCLET_TOKEN=syd_… pnpm test:contract
# against a fresh instance: creates the first administrator
SYNCLET_URL=… SYNCLET_SETUP=1 [SYNCLET_USER=… SYNCLET_PASSWORD=…] pnpm test:contract
# against a newer server that adds response fields: allow undocumented fields
SYNCLET_CONTRACT_LENIENT=1 SYNCLET_URL=… SYNCLET_TOKEN=… pnpm test:contract
# lint the OpenAPI description
pnpm --filter @synclet/sync-contract lint:openapi
```

Details (skips, thumbnail worker, rate limits): `packages/sync-contract/README.md`.
