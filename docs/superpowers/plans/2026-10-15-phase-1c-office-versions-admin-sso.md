# Synclet Phase 1c – Euro-Office, Versions, Admin UI, SSO, App Login, Sync Contract

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 1 with Office editing in the browser (Euro-Office), optional file versions with Nextcloud-style retention, a full admin area (users, status, devices & sessions, share oversight, SSO configuration), single sign-on (OIDC and forward-auth) configurable at runtime, the PKCE browser login that native clients need, and a written + executable Sync API contract.

**Architecture:** Same NestJS/Prisma/Postgres server and React web app. Office uses the Buro integration pattern (JWT-signed editor config, short-lived file tokens, callback saves with conflict copies) against an optional `office` compose service on its own subdomain. Versions are stored outside the user folder under `/meta/versions` and pruned by time buckets. SSO settings live in the database (secrets encrypted with a key derived from `ServerConfig.jwtSecret`) and are edited in the admin UI; an env flag provides an emergency override. The native-app login is OAuth 2.0 Authorization Code + PKCE (`/app-login` page + `/api/auth/app/*`), which can itself use OIDC.

**Tech Stack (additions):** `openid-client@^6` (ESM-only → same dynamic-import helper as `@tus/server`), Euro-Office Document Server (`ghcr.io/euro-office/documentserver`, AGPL, separate container, compose profile `office`), Buro office templates (`new.docx|xlsx|pptx|odt|ods|odp|txt|csv`), a mock OIDC provider for tests (`ghcr.io/navikt/mock-oauth2-server` in e2e; an in-process fake for unit tests).

**Spec:** `docs/superpowers/specs/2026-10-15-synclet-design.md` (§6 versions, §7 Euro-Office, §8 Auth, roadmap 1c). Buro reference implementation: `/Volumes/Daten/Privat/SaaS/BuroApp/buro` (`apps/api/src/files/office.service.ts`, `office.controller.ts`, `apps/api/src/auth/app-login.service.ts`, `app-clients.ts`, `apps/web/src/pages/OfficeEditorPage.tsx`, `AppLoginPage.tsx`, `docs/sync/SYNC_API.md`). Follow-ups: `docs/superpowers/followups/2026-10-15-phase-1{a,b}-followups.md`.

**User decisions (2026-10-15):** versions retention **tiered like Nextcloud**; admin UI = **users, system status, devices & sessions, share oversight, SSO (OIDC or forward-auth: enable/disable/configure)**; Euro-Office **like Buro on its own subdomain**; SSO users are **auto-provisioned** (optional allowed-group gate, admin-group → admin role); local password login **stays on by default, can be disabled for non-admins, admins always keep a password fallback**; SSO kinds: **OIDC and forward-auth**.

## Global Constraints

- Everything from Phase 1a/1b Global Constraints holds (versions, English code, de+en UI strings, `journal.lockUser` + `TX_OPTS` for mutations, nothing but user content + transient ignored names in `/data`, commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` followed by `Claude-Session: https://claude.ai/code/session_012XgXSgUMDR71rtNA64nYDi`).
- Branch `phase-1c` (stacked on `phase-1b`, whose PR #1 is open). Lands on `main` only via a GitHub PR. Task branches `phase1c/task-N`, merged into `phase-1c` by the controller.
- Server tests: `cd apps/server && TEST_DATABASE_URL=postgresql://synclet:synclet@localhost:5434/synclet_test_1c_tN pnpm test [path]`; never `migrate reset`; new tables go into `resetDb`. Only Task 1 creates a migration; `test/schema-drift.spec.ts` must stay green (model every new DB object in `schema.prisma`, or list raw-SQL ones in the header comment).
- **Secrets at rest** (OIDC client secret): AES-256-GCM via a shared `SecretBox` (extracted from `shares/share-auth.ts` into `common/secret-box.ts`, key = HKDF-SHA256(jwtSecret, info), AAD = purpose string). Secrets are never returned by any API (write-only fields; responses show `hasClientSecret: boolean`).
- ESM-only libraries (`openid-client`) are loaded through the existing dynamic-import helper (extract from `uploads/tus.ts` into `common/import-esm.ts`).
- Every new admin route: `@UseGuards(AuthGuard) @AdminOnly()`. Every new public route (office callbacks, OIDC callback, forward-auth, app login): rate-limited per `ipKey()`.
- Versions are **off by default** (`SYNCLET_VERSIONS=off`); when off, no version rows/files are created and version endpoints return `404 not_found` with `message: 'versions disabled'`; the web hides version UI (server capability flag).

## Review Focus

1. **Office callback from an attacker** – a forged callback (wrong/absent JWT, wrong file token, foreign `url` origin, other user's file id) must never write a file; SSRF only to the configured Document Server origins. Tests in Task 3.
2. **Office save racing a sync client edit** – callback with a stale `document.key` writes a conflict copy next to the file, never overwrites; repeated forcesaves of the same session overwrite each other. Tests in Task 3.
3. **SSO account takeover** – an OIDC login must not attach to an existing local account just because the email matches unless the IdP marks the email verified *and* the admin enabled linking; forward-auth headers from an untrusted peer are ignored; usernames from claims are sanitized (no path traversal, no reserved names) and collisions get suffixes. Tests in Task 5.
4. **Admin lockout** – disabling SSO-only login, demoting/disabling the last admin, or a broken OIDC config must never leave the instance without a working admin login (`SYNCLET_SSO_EMERGENCY=1` restores password login for admins). Tests in Tasks 5 and 6.
5. **Versions never touch `/data` and never lose the current file** – versioning a 0-byte file, a file replaced twice within a second, restoring a version (current becomes a version first), versions of a file moved/renamed/trashed/restored keep following the item id; "delete forever" and trash expiry remove versions. Tests in Task 2.

---

## Parallel execution waves (max 5 concurrent subagents)

| Wave | Tasks | Depends on |
|---|---|---|
| 0 | T1 Foundation (schema, config, shared types, SecretBox/import-esm extraction) | – |
| 1 | T2 Versions backend · T3 Office backend · T4 App login (PKCE) backend · T5 SSO backend · T6 Admin backend | T1 |
| 2 | T7 Web Office · T8 Web Versions · T9 Web Admin · T10 Web login/SSO/app-login · T11 Sync contract (OpenAPI + conformance + SYNC_API.md) | wave 1 (T7←T3, T8←T2, T9←T5+T6, T10←T4+T5, T11←T4) |
| 3 | T12 Docker/Caddy/README | T3, T5 |
| 4 | T13 End-to-end | all |

---

### Task 1: Foundation

**Files:** `apps/server/prisma/schema.prisma` + migration `phase_1c_core`, `apps/server/src/config.ts` (+spec), `apps/server/test/context.ts` (resetDb), `packages/shared/src/index.ts`, `apps/server/src/common/{secret-box.ts, import-esm.ts}` (+specs; update `shares/share-auth.ts` and `uploads/tus.ts` to use them, behavior unchanged), `apps/server/package.json` (dep `openid-client@^6`), `apps/server/assets/office-templates/*` (copy the 8 `new.*` files + README from Buro, keep the AGPL attribution note).

**Interfaces – Prisma (add):**

```prisma
enum VersionSource {
  api
  office
  restore
}

/// Superseded content of a file (only when SYNCLET_VERSIONS=on). Follows the item id across moves.
model FileVersion {
  id         String        @id @default(uuid()) @db.Uuid
  itemId     String        @db.Uuid
  ownerId    String        @db.Uuid
  /// Item.version this content had while it was current.
  version    Int
  sha        String
  size       BigInt
  /// mtime of the content while it was current.
  mtime      DateTime
  /// When it was superseded (= version timestamp used by retention buckets).
  createdAt  DateTime      @default(now())
  createdBy  String?       @db.Uuid
  source     VersionSource
  /// Absolute path under <meta>/versions.
  storePath  String

  @@index([itemId, createdAt])
  @@index([ownerId])
  @@index([sha])
}

/// One-time PKCE authorization codes for native app login (hash only).
model AppAuthCode {
  id            String    @id @default(uuid()) @db.Uuid
  codeHash      String    @unique
  userId        String    @db.Uuid
  clientId      String
  redirectUri   String
  codeChallenge String
  expiresAt     DateTime
  usedAt        DateTime?
  createdAt     DateTime  @default(now())

  @@index([expiresAt])
}

/// Singleton (id = 1): runtime auth settings edited in the admin UI.
model AuthSettings {
  id                  Int      @id @default(1)
  /// Disable password login for non-admin users (admins always keep it).
  passwordLoginForUsers Boolean @default(true)
  oidcEnabled         Boolean  @default(false)
  oidcIssuer          String?
  oidcClientId        String?
  /// SecretBox ciphertext (purpose "oidc-client-secret").
  oidcClientSecretEnc String?
  oidcScopes          String   @default("openid profile email")
  oidcButtonLabel     String   @default("Single Sign-on")
  oidcUsernameClaim   String   @default("preferred_username")
  oidcGroupsClaim     String   @default("groups")
  oidcAllowedGroups   String[] @default([])
  oidcAdminGroups     String[] @default([])
  /// Attach an OIDC login to an existing account with the same verified email.
  oidcLinkByEmail     Boolean  @default(false)
  forwardAuthEnabled  Boolean  @default(false)
  forwardAuthUserHeader   String @default("Remote-User")
  forwardAuthEmailHeader  String @default("Remote-Email")
  forwardAuthNameHeader   String @default("Remote-Name")
  forwardAuthGroupsHeader String @default("Remote-Groups")
  /// CIDRs of proxies allowed to set forward-auth headers (direct socket peer of the server).
  forwardAuthTrustedProxies String[] @default([])
  forwardAuthAdminGroups  String[] @default([])
  forwardAuthAllowedGroups String[] @default([])
  updatedAt           DateTime @updatedAt
  updatedBy           String?  @db.Uuid
}
```
Also: `Item.officeKey String?` (Buro pattern: key of the last office session that saved). Add `"FileVersion","AppAuthCode","AuthSettings"` to `resetDb`.

**Config (env, all optional):** `SYNCLET_VERSIONS` (`on|off`, default off), `SYNCLET_VERSIONS_MAX_BYTES` (per user, default 0 = unlimited), `OFFICE_URL` (browser-facing Document Server URL, e.g. `https://office.example.com`), `OFFICE_JWT_SECRET`, `OFFICE_API_URL` (server as seen by the Document Server, default `http://server:3000/api`), `OFFICE_INTERNAL_URL` (Document Server as seen by the server, default `http://office`), `SYNCLET_SSO_EMERGENCY` (`1` → OIDC/forward-auth ignored and password login enabled for everyone, admin UI shows a banner).

**Shared types (add, exact):**

```ts
export interface ServerCapabilities { versions: boolean; office: { enabled: boolean; url: string | null }; }
export interface VersionWire {
  id: string; version: number; size: number; sha256: string;
  modifiedAt: string;   // content mtime while current
  createdAt: string;    // superseded at
  source: 'api' | 'office' | 'restore'; createdBy: { id: string; displayName: string } | null;
}
export interface OfficeEditorConfig { documentServerUrl: string; editable: boolean; config: Record<string, unknown> }
export type OfficeNewFormat = 'docx' | 'xlsx' | 'pptx' | 'odt' | 'ods' | 'odp' | 'txt' | 'csv';

export interface LoginMethods {
  password: boolean;           // shown for everyone (admins can always use /login?local=1)
  oidc: { enabled: boolean; label: string };
  forwardAuth: boolean;
  emergency: boolean;
}
export interface SsoSettingsWire {
  passwordLoginForUsers: boolean;
  oidc: { enabled: boolean; issuer: string | null; clientId: string | null; hasClientSecret: boolean; scopes: string;
          buttonLabel: string; usernameClaim: string; groupsClaim: string; allowedGroups: string[]; adminGroups: string[];
          linkByEmail: boolean; redirectUri: string };
  forwardAuth: { enabled: boolean; userHeader: string; emailHeader: string; nameHeader: string; groupsHeader: string;
                 trustedProxies: string[]; allowedGroups: string[]; adminGroups: string[] };
  emergency: boolean;
}
export type SsoSettingsInput = Partial<Omit<SsoSettingsWire, 'emergency' | 'oidc' | 'forwardAuth'>> & {
  oidc?: Partial<Omit<SsoSettingsWire['oidc'], 'hasClientSecret' | 'redirectUri'>> & { clientSecret?: string | null };
  forwardAuth?: Partial<SsoSettingsWire['forwardAuth']>;
};

export interface AdminUserWire extends PublicUser {
  disabled: boolean; createdAt: string; lastLoginAt: string | null;
  identities: { provider: string; subject: string }[]; usedBytes: number; devices: number;
}
export interface AdminSessionWire { id: string; userAgent: string | null; createdAt: string; expiresAt: string }
export interface AdminDeviceWire extends SyncDevice { userId: string }
export interface AdminShareWire extends ShareLinkWire { owner: { id: string; username: string } }
export interface AdminStatusWire {
  version: string; uptimeSec: number;
  watch: 'active' | 'scan-only' | 'off'; lastFullScanAt: string | null;
  users: { total: number; disabled: number };
  disk: { data: DiskUsage; meta: DiskUsage };
  meta: { derivedBytes: number; trashBytes: number; versionsBytes: number; uploadsBytes: number };
  jobs: Record<'thumb' | 'text', Record<'pending' | 'running' | 'done' | 'failed' | 'unsupported', number>>;
  office: { enabled: boolean; reachable: boolean | null };
  versions: boolean;
}
export interface DiskUsage { totalBytes: number; freeBytes: number }
export interface UnassignedFolder { name: string }
export interface AppTokenResponse extends AuthResponse { refreshToken: string }
```
`SyncErrorCode` gains `'office_disabled' | 'sso_not_allowed' | 'password_login_disabled'` (STATUS map: 503, 403, 403) — added here in Task 1 so parallel tasks don't collide in `common/sync-error.ts`.
`User` gains `lastLoginAt DateTime?` (schema) — set on every successful login (password, OIDC, forward-auth, app login).

Commit; full server suite + drift test + web typecheck green.

---

### Task 2: Versions backend

**Files:** `apps/server/src/versions/{versions.service.ts, retention.ts, versions.controller.ts, versions.module.ts, *.spec.ts}`; modify `files/files.service.ts` (hook), `trash/trash.service.ts` (delete forever/expire remove versions), `derivatives/derivatives-gc.ts` (version shas are live), `indexer/scheduler.service.ts` (maintenance prune), `sync/sync.controller.ts` (capabilities route), `app.module.ts`.

**Interfaces:**
- `retention.ts` – `selectVersionsToKeep(versions: { id: string; createdAt: Date }[], now: Date): Set<string>` implementing Nextcloud's buckets, newest first: within 10 s keep 1 per 2 s; within 1 min keep 1 per 10 s; within 1 h keep 1 per minute; within 24 h keep 1 per hour; within 30 days keep 1 per day; older keep 1 per week. Pure function, exhaustively unit-tested with fixed timestamps.
- `VersionsService.capture(tx, user, item: Item, absCurrent: string, source: VersionSource, by?: string): Promise<void>` – called **inside** `FilesService` before the current content is replaced (replaceContent, office save, version restore): copies (same-FS: hardlink; else copy to `<meta>/versions/.tmp-*` then rename) the current file to `<meta>/versions/<ownerId>/<itemId>/<version>-<sha|nohash>` and inserts the row; skips silently when versions are off. The current file must never be moved/modified by capture. If capture fails, the replace fails (no silent loss of history) with 500 and the temp is removed.
- `VersionsService.list(user, itemId): Promise<VersionWire[]>`, `openRead(user, itemId, versionId)` (stream for download, `Content-Disposition` with `<base> (v<n>).<ext>`), `restore(user, itemId, versionId): Promise<Item>` (captures current with source `restore`, then replaces content with the version via the same atomic path as replaceContent, version+1, journal upsert), `deleteForItems(ownerId, itemIds: string[])`, `prune(now)` (retention buckets per item + `SYNCLET_VERSIONS_MAX_BYTES` per user evicting oldest beyond the newest version per item).
- Routes (AuthGuard): `GET /api/sync/v1/items/:id/versions` → `VersionWire[]`; `GET /api/sync/v1/items/:id/versions/:versionId/content` (`@AllowDownloadToken`); `POST /api/sync/v1/items/:id/versions/:versionId/restore` → `SyncItem`; `GET /api/sync/v1/capabilities` → `ServerCapabilities`.
- Item lifecycle: versions follow the item id (moves/renames need nothing). Trash: versions stay while the item is in the trash and are deleted by deleteForever/empty/expire (use the manifest ids). Restore from trash keeps them (ids preserved). GC: shas referenced by `FileVersion` are live.

**Tests (min):** retention table (≥ 15 cases incl. boundaries); capture on PUT content creates exactly one version with the previous bytes and nothing new in `/data`; two PUTs within 1 s both captured, prune keeps per buckets; restore round-trip (current becomes a version, restored bytes current, item id unchanged, version+1, journal upsert); 0-byte file; versions off → no rows, routes 404; other user → 404; trash delete-forever removes version files + rows, trash restore keeps them; max-bytes eviction keeps the newest per item; GC doesn't delete thumbnails of a sha only referenced by a version; capture failure (read-only versions dir) aborts the replace and leaves the current file untouched.

---

### Task 3: Office backend (Euro-Office)

**Files:** `apps/server/src/office/{office.service.ts, office.controller.ts, office-public.controller.ts, office.module.ts, *.spec.ts}`; modify `files/files.service.ts` (add `saveOfficeContent` using the same atomic replace path + version capture, and `createFromTemplate`), `app.module.ts`.

**Port Buro's design** (read Buro `office.service.ts` and `office.controller.ts` first), adapted:
- Enabled iff `OFFICE_URL` and `OFFICE_JWT_SECRET` set; otherwise all office routes → `503 {code:'office_disabled'}` (code added in Task 1) and `capabilities.office.enabled=false`.
- `GET /api/sync/v1/items/:id/office` (AuthGuard) → `OfficeEditorConfig`: `document.key = <itemId>-<version>`, `fileType`, `title` (display name), `url = ${OFFICE_API_URL}/office/files/<syncId>/content?t=<contentToken>`, `permissions {edit, download:true, print:true, comment:edit}`; `editorConfig {mode, lang: user's UI language ('de'|'en' from `?lang=`), callbackUrl: ${OFFICE_API_URL}/office/files/<syncId>/callback?t=<callbackToken>, user {id, name: displayName}, customization {forcesave: true}}`; whole config signed HS256 with `OFFICE_JWT_SECRET` into `token`. File tokens: JWT `{i: itemId, u: userId, p: 'content'|'callback'}` signed with `OFFICE_JWT_SECRET`, TTL 1 d / 7 d. Editable extensions = Buro `EDITABLE`; view-only = Buro view-only; others → `415 invalid_request`.
- Public routes (no AuthGuard, rate-limited): `GET /api/office/files/:id/content?t=` (verifies token purpose/item, owner still owns a live item; streams via `sendFile` without download disposition), `POST /api/office/files/:id/callback?t=` (verifies file token **and** the Document Server JWT from body `token` or `Authorization: Bearer`; handles statuses 2 and 6 only; downloads `data.url` only if its origin equals `OFFICE_URL`'s or `OFFICE_INTERNAL_URL`'s origin (rewrite public → internal origin), streaming into `FilesService.saveOfficeContent(user, itemId, stream, { key, baseVersion })` with the Buro conflict rule: `if item.version !== baseVersion && item.officeKey !== key` → create sibling `"<Base> (Konflikt Office <YYYY-MM-DD HH-mm>).<ext>"` via `upload(..., onConflict:'rename')`, else replace (version capture source `office`, set `officeKey = key`). Respond `{error:0}`; on internal error `{error:1}` (Document Server retries). Download size limited by `maxUploadBytes`, timeout 120 s.
- `POST /api/sync/v1/items/new-office` `{ parentId, name, format: OfficeNewFormat }` (AuthGuard) → 201 `SyncItem` created from `assets/office-templates/new.<format>` via `upload(..., onConflict:'rename')` (works even when office is disabled — just a template copy).
- Office user = the item owner (Synclet has no shared folders yet); `editorConfig.user` = requesting user.

**Tests (min) – with a fake Document Server (tiny HTTP server in the test serving the "edited" bytes):** config shape + JWT verifiable with the secret; disabled → 503; content route rejects wrong purpose/expired/other item token; callback: missing/invalid Document Server JWT → no write; foreign `url` origin → no fetch, `{error:1}`; status 2 save replaces content (version+1, officeKey set, journal upsert, version captured when versions on); stale key from another session → conflict copy with exact name pattern, original untouched; two forcesaves (status 6) with the same key overwrite without conflict copies; trashed item → save discarded `{error:0}`; new-office creates each format with rename on conflict.

---

### Task 4: App login (PKCE) backend

**Files:** `apps/server/src/auth/{app-login.service.ts, app-clients.ts, app-login.controller.ts, *.spec.ts}`.

Port Buro `app-login.service.ts` + `app-clients.ts` (single-tenant: no workspaces/slug):
- Clients: `ios`, `android`, `macos` → `synclet://oauth`; `windows`, `linux` → loopback `^http://127\.0\.0\.1:(\d{1,5})/callback$`. Exact validation via `resolveAppClient(clientId, redirectUri)`.
- `GET /api/auth/app/client?clientId&redirectUri` → `{ id, name }` | 400.
- `POST /api/auth/app/authorize` `{ login, password, clientId, redirectUri, codeChallenge, codeChallengeMethod: 'S256' }` → `{ code }` (password path; respects the same rate limits and `passwordLoginForUsers` rule as `/auth/login`).
- `POST /api/auth/app/authorize/session` (AuthGuard with a normal web access token) `{ clientId, redirectUri, codeChallenge, codeChallengeMethod }` → `{ code }` – used by the web app-login page after an OIDC/forward-auth/web login, so SSO works for native apps.
- `POST /api/auth/app/token` `{ code, codeVerifier, clientId, redirectUri }` → `AppTokenResponse` (refresh token in the JSON body – apps have no cookie jar) — code TTL 60 s, single use (`updateMany where usedAt null`), S256 only, hash-only storage, expired codes purged on authorize; user disabled → 401.
- Native refresh: `POST /api/auth/app/refresh` `{ refreshToken }` → same rotation semantics as the cookie refresh.

**Tests (min):** happy path (authorize → token → access works → device registration with it); wrong verifier; reused code; expired code; redirect/client mismatch; loopback port variants; disabled user; password login disabled for users → authorize 403 for non-admin, admin ok; session-based authorize with a web token.

---

### Task 5: SSO backend (OIDC + forward-auth)

**Files:** `apps/server/src/sso/{sso-settings.service.ts, oidc.service.ts, forward-auth.service.ts, provisioning.service.ts, sso.controller.ts, admin-sso.controller.ts, sso.module.ts, *.spec.ts}`; modify `auth/auth.service.ts` (`issue()` reused; `lastLoginAt`), `auth/auth.controller.ts` (password login honors `passwordLoginForUsers`/emergency), `auth/users.service.ts` (provisioning helper).

**Interfaces / behavior (normative):**
- `SsoSettingsService.get(): Promise<SsoSettingsWire>`, `update(input: SsoSettingsInput, by: string)` (validates: issuer https URL (http allowed only for `localhost`/private hosts with a warning flag), clientId required when enabling OIDC, CIDR syntax, header names `^[A-Za-z0-9-]+$`; when enabling OIDC runs discovery once and returns `400 invalid_request` with the IdP error if it fails), `effective()` (applies `SYNCLET_SSO_EMERGENCY`). Cached in memory, invalidated on update.
- `GET /api/auth/methods` → `LoginMethods` (public).
- OIDC (`openid-client` v6, PKCE + state + nonce, `response_type=code`): `GET /api/auth/oidc/start?return=<path>` → 302 to IdP (state/nonce/verifier in a short-lived signed httpOnly cookie, path `/api/auth/oidc`); `GET /api/auth/oidc/callback` → validates, then provisioning, then `auth.issue()` sets the refresh cookie and 302 to `return` (only same-origin relative paths, default `/files`); errors → 302 `/login?sso_error=<code>`. Redirect URI = `${SYNCLET_PUBLIC_URL}/api/auth/oidc/callback` (OIDC requires `SYNCLET_PUBLIC_URL`; settings update refuses enabling without it).
- Provisioning (`ProvisioningService.resolve({ provider, subject, email, emailVerified, preferredUsername, name, groups })`): find `Identity(provider, subject)` → user; else if `linkByEmail` and `emailVerified` and a user with that email exists → link; else **create** (if allowed-groups configured, require intersection → else `403 sso_not_allowed`): username = sanitized claim (NFC, lowercase allowed? keep case, replace forbidden chars with `-`, strip leading dots, reject reserved via `validateName`, ≤ 64 chars) with collision suffix `-2`, `-3`… (case-insensitive); create user + folder via `UsersService.create` (random unusable password: no local identity), role `admin` iff groups ∩ adminGroups; on every login sync role from groups when admin groups are configured (never demote the last admin – log instead); disabled users → `401 unauthorized`.
- Forward-auth: `POST /api/auth/forward` (public): if enabled and the **socket peer address** (`req.socket.remoteAddress`, not `req.ip`) is within `trustedProxies` CIDRs and the user header is present → provisioning with `provider = 'forward'`, `subject = header value` → `auth.issue()` → `AuthResponse` + cookie; else 401. The web calls it on load when `methods.forwardAuth` is true.
- Password login rules: if `passwordLoginForUsers=false` and not emergency → non-admin password login (web + app authorize) → `403 {code:'password_login_disabled'}`; admins always allowed (`/login?local=1` in the web).
- Admin: `GET /api/admin/sso` → `SsoSettingsWire`; `PUT /api/admin/sso` (`SsoSettingsInput`) → `SsoSettingsWire`; `POST /api/admin/sso/test` → `{ ok: boolean; issuer?: string; error?: string }` (OIDC discovery test without saving).

**Tests (min):** settings validation + secret never returned + encrypted at rest; discovery failure blocks enabling; OIDC full flow against an in-process fake IdP (implement a tiny OIDC provider in the test with `jose` — discovery, JWKS, token endpoint, signed id_token) incl. state mismatch, nonce mismatch, wrong issuer; provisioning: new user created with folder, username sanitization (`../evil`, `CON`, `.hidden`, `Jens Köhler`), collision suffix, allowed-groups gate, admin group → admin, link-by-email only when verified + enabled (Review Focus 3); returning user by subject; disabled user; forward-auth from trusted vs untrusted peer (inject with `remoteAddress`), spoofed header from untrusted peer ignored; password login disabled for users but admin still works; emergency env restores password login and disables SSO; never demote the last admin via groups.

---

### Task 6: Admin backend

**Files:** `apps/server/src/admin/{admin-users.controller.ts (move/extend existing from auth/), admin-sessions.controller.ts, admin-shares.controller.ts, admin-status.controller.ts (replace indexer/status.controller.ts, keep the route), admin.module.ts, *.spec.ts}`; modify `auth/users.service.ts`.

**Routes (all `@AdminOnly()`):**
- Users: `GET /api/admin/users` → `AdminUserWire[]` (usedBytes from live items sum, devices count, identities, lastLoginAt); `POST /api/admin/users` (existing + optional `adoptExistingFolder: true` which requires the folder to already exist and not be assigned); `PATCH /api/admin/users/:id` (displayName, email, role, disabled, password) with **last-admin protection** (can't demote/disable the last enabled admin → `409 {code:'conflict', message:'last admin'}`; can't disable yourself); `DELETE /api/admin/users/:id` → disables + revokes sessions/devices/shares, **never deletes the folder** (204); `GET /api/admin/folders/unassigned` → `UnassignedFolder[]` (top-level dirs in dataRoot without a user; excludes ignored/temp names).
- Sessions & devices: `GET /api/admin/users/:id/sessions` → `AdminSessionWire[]` (active only); `DELETE /api/admin/users/:id/sessions/:sessionId`; `DELETE /api/admin/users/:id/sessions` (all); `GET /api/admin/users/:id/devices` → `AdminDeviceWire[]`; `DELETE /api/admin/users/:id/devices/:deviceId`.
- Shares: `GET /api/admin/shares?userId=&status=active|expired|all` → `AdminShareWire[]` (`url` is the real link only for the admin's own links and `''` for other users' links, so admins can revoke but not silently reuse links); `DELETE /api/admin/shares/:id` (revoke any).
- Status: `GET /api/admin/status` → `AdminStatusWire` (package version from apps/server/package.json; `statfs` for `/data` and `/meta`; directory sizes of `/meta/derived|trash|versions|uploads` computed asynchronously and cached for 10 min; job counts grouped by kind/status; office reachability = `GET ${OFFICE_INTERNAL_URL}/healthcheck` with 2 s timeout, cached 1 min).

**Tests (min):** non-admin 403 on every route; last-admin protection (demote, disable, delete, self-disable); delete user keeps folder and revokes everything; unassigned folders listing + adopt; sessions/devices list/revoke for another user; admin share listing across users without leaking other users' URLs; status shape with jobs/disk numbers (statfs mocked if needed).

---

### Task 7: Web – Office

**REQUIRED SUB-SKILL:** `frontend-design:frontend-design`.

**Files:** `apps/web/src/features/office/{OfficeEditorPage.tsx, queries.ts, office.ts, *.test.ts}`, router (`/office/:itemId` inside AuthRoot + RequireAuth, **without** AppShell – full-screen editor), `features/files/FileActions.tsx` ("In Office öffnen" for office-editable/viewable extensions when `capabilities.office.enabled`), "Neu" menu (`Dokument`, `Tabelle`, `Präsentation`, plus "Weitere…" submenu for odt/ods/odp/txt/csv) which calls `new-office` and, if office is enabled, opens the editor in a new tab; QuickLook header gets "In Office öffnen"; locales.

**Requirements:** load `${documentServerUrl}/web-apps/apps/api/documents/api.js` once, create `DocsAPI.DocEditor` with the server config (+ `width/height 100%`, `type` mobile ≤ 700 px), set `document.title`, destroy on unmount, show an error panel with retry/close when api.js fails to load or the server returns 503; open via `window.open('/office/<id>', '_blank', 'noopener')`. Capabilities via a `useCapabilities()` hook (`GET /sync/v1/capabilities`, cached). Tests: action visibility by extension/capability, script loader idempotence, error states.

---

### Task 8: Web – Versions

**Files:** `apps/web/src/features/versions/{VersionsPanel.tsx, queries.ts, *.test.ts}`, FileActions ("Versionen…" when `capabilities.versions`), QuickLook header button, locales.

**Requirements:** side sheet listing versions (relative time + absolute tooltip, size, source badge Office/Wiederhergestellt, author), actions: download (download token for the version route), preview in QuickLook for previewable kinds (version content URL), "Wiederherstellen" with confirm ("Die aktuelle Fassung wird dabei als Version gesichert"), empty state, invalidates folder/item/version queries after restore. Tests: visibility by capability, restore flow, download URL construction.

---

### Task 9: Web – Admin area

**REQUIRED SUB-SKILL:** `frontend-design:frontend-design` (dense but calm admin look, consistent with the app).

**Files:** `apps/web/src/features/admin/{AdminLayout.tsx, UsersPage.tsx, UserDetailPage.tsx, StatusPage.tsx, SharesPage.tsx, SsoPage.tsx, queries.ts, *.test.tsx}`, router `/admin/*` (RequireAuth + admin-only guard → 404 page for non-admins), sidebar/user-menu entry "Administration" for admins, locales.

**Requirements:**
- Users: table (name, username, email, role, status, storage used, devices, last login, SSO identities), create dialog (with "bestehenden Ordner übernehmen" picker from `/admin/folders/unassigned`), edit (role, display name, email, reset password, disable/enable), delete (= disable + revoke, explains folder stays), last-admin errors shown inline.
- User detail: sessions (user agent, created, expires; revoke one/all) and devices (name, platform, app version, last seen; revoke).
- Status: cards for watcher mode, last scan, disk usage /data and /meta (bars), meta breakdown (derived/trash/versions/uploads), job queue counts (thumb/text by status), office reachability, versions on/off, server version; auto-refresh 30 s.
- Shares: all links with owner, item, created, expiry, hits, flags; filter by user/status; revoke.
- SSO: form for passwordLoginForUsers, OIDC (issuer, client id, client secret write-only with "gesetzt" indicator + replace, scopes, button label, claims, allowed/admin groups as tag inputs, link-by-email with warning text), "Verbindung testen" (`/admin/sso/test`), shows the redirect URI to register at the IdP with copy button (reuse Task 8/1b copy helper), forward-auth section (headers, trusted proxy CIDRs, groups) with a prominent warning that it must only be enabled behind a proxy that strips these headers from clients; emergency banner when `emergency=true`; save with validation errors mapped inline.
- Tests: admin guard (non-admin gets 404 page), forms validation, secret field write-only semantics, last-admin error display.

---

### Task 10: Web – login, SSO and app login pages

**Files:** `apps/web/src/pages/LoginPage.tsx` (extend), `apps/web/src/features/auth/{AppLoginPage.tsx, sso.ts, *.test.tsx}`, `lib/auth.tsx` (forward-auth bootstrap), router (`/app-login` inside AuthRoot but outside RequireAuth), locales.

**Requirements:**
- Login page reads `GET /auth/methods`: OIDC button (label from settings) → `/api/auth/oidc/start?return=<next>`; password form shown when `password` (or `?local=1` for admins); `sso_error` query → friendly message per code; forward-auth: on app load, if `methods.forwardAuth`, call `POST /auth/forward` once before the normal refresh probe; success → logged in.
- App login page `/app-login?client_id&redirect_uri&code_challenge&code_challenge_method=S256&state[&login_hint]`: validates client via `/auth/app/client` (shows "Anmelden bei Synclet für <Client-Name>"), offers password form (→ `/auth/app/authorize`) and, if OIDC enabled, the SSO button (→ OIDC start with `return=/app-login?...` so after SSO the page calls `/auth/app/authorize/session` with the fresh web session), and "Mit aktuellem Konto fortfahren" if already logged in; on success `window.location.replace(redirect_uri?code&state)`; invalid parameters → error page, never redirect to an unvalidated URI.
- Tests: methods-driven rendering, app-login parameter validation, redirect construction (state passthrough, URL-encoding), no redirect on invalid client.

---

### Task 11: Sync contract – documentation, OpenAPI, conformance suite

**Files:** `docs/sync/SYNC_API.md` (Synclet's contract: port Buro's document with Synclet deltas from spec §4 and Phases 1a–1c: ids `root`/`d_`/`f_`, opaque folder etags, tus uploads, thumbnails, preview tokens, versions, capabilities, app login §2a with Synclet client ids/redirects, error codes incl. new ones, display-name rules, clients derive child paths from parents), `packages/sync-contract/{package.json, openapi.yaml, src/client.ts, tests/*.test.ts, README.md}` (vitest; runs against `SYNCLET_URL` with an admin created via setup or `SYNCLET_TOKEN`; covers devices, account, cursor/changes semantics, children paging, content Range/ETag/If-Range/304/416, PUT If-Match 428/412, upload conflicts 409/rename, PATCH/DELETE, thumbnail 404→200 (poll), tus resume, versions when enabled, app-login PKCE), root script `pnpm test:contract`.

**Requirements:** the suite must be self-contained (creates its own folder `contract-<random>` and cleans it up via DELETE + trash empty), idempotent, and pass against a stack started by `scripts/e2e-fresh.sh`-style helper (Task 13 runs it). OpenAPI 3.1 validated with a linter (`@redocly/cli lint` as devDependency).

---

### Task 12: Docker, Caddy, README

**Files:** `deploy/compose.yml` (service `office` with `profiles: ["office"]`, image `ghcr.io/euro-office/documentserver:${OFFICE_TAG:-latest}`, env `JWT_ENABLED=true`, `JWT_SECRET=${OFFICE_JWT_SECRET:?}` only when profile active (use a separate `compose.office.yml` override if `:?` interpolation would break non-office starts), `ALLOW_PRIVATE_IP_ADDRESS=true`, volumes for data/lib/logs, `mem_limit` note; server env `OFFICE_URL`, `OFFICE_JWT_SECRET`, `OFFICE_API_URL=http://server:3000/api`, `OFFICE_INTERNAL_URL=http://office`, `SYNCLET_VERSIONS`, `SYNCLET_VERSIONS_MAX_BYTES`, `SYNCLET_SSO_EMERGENCY`), `deploy/Caddyfile` (site block for `{$SYNCLET_OFFICE_SITE_ADDRESS}` → `office:80` with `header_up X-Forwarded-Proto {scheme}` and `X-Forwarded-Host {host}`; SPA CSP extended with `script-src 'self' {$OFFICE_URL}`, `frame-src 'self' blob: {$OFFICE_URL}`, `connect-src 'self' {$OFFICE_URL}`; strip forward-auth headers (`Remote-User`, `Remote-Email`, `Remote-Name`, `Remote-Groups`) from requests whose direct peer is not in `{$SYNCLET_TRUSTED_PROXIES}`), `deploy/.env.example`, `README.md` (Office setup incl. DNS/TLS for the office subdomain and RAM needs; versions explanation + retention table; SSO setup guides: Authentik, Keycloak, Authelia (OIDC) and Authelia/Authentik forward-auth via outer proxy or Caddy `forward_auth`; emergency recovery; app login; admin area).

**Verify:** `docker compose … config` with and without the office profile; `caddy validate`; bring up the stack **with** the office profile on a free port set (needs ~4 GB RAM – if the machine can't, verify without office and document); with office: open the editor config route and fetch `${OFFICE_URL}/healthcheck` through Caddy.

---

### Task 13: End-to-end

**Files:** `scripts/throwaway-test.sh` (versions on: replace content twice via PUT → `/meta/versions` has 2 files, `/data` unchanged except the current file; restore a version; final fidelity check unchanged), `scripts/e2e-fresh.sh` (adds a mock OIDC provider container `ghcr.io/navikt/mock-oauth2-server` to the e2e stack and configures SSO via the admin API), `e2e/tests/{admin,sso,versions,office,app-login}.spec.ts`, `scripts/server-tests-linux.sh` unchanged except new tests, root `test:contract` run against the e2e stack.

**Requirements:** Playwright: admin (create user, adopt folder, disable, last-admin error, revoke session, status page shows numbers, revoke another user's share), SSO (configure OIDC against the mock provider via admin UI, log out, log in via SSO → new user provisioned with folder on disk; admin group → admin), forward-auth (configured with the e2e network CIDR; request with header via the trusted path logs in; spoofed header from the browser is ignored), versions (enable via env in the e2e stack; edit/replace a text file via upload, restore older version via UI), app-login (simulate a native client: open `/app-login` with PKCE params, log in, capture redirect to a loopback URL served by Playwright, exchange code at `/auth/app/token`, register a device with the access token), office (only if `E2E_OFFICE=1`: create a document, editor iframe loads; callback path covered by server tests); contract suite green against the stack. Linux server suite green with no skips.

---

## Out of scope for Phase 1c

Shared folders between users (Phase 5), SSE `/events` and APNs (Phase 2/3), native clients (Phase 2+), SAML/LDAP, per-user quotas, audit log UI.
