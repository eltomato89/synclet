# Synclet Phase 1b – Trash, Shares, Previews, Search, Resumable Uploads

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Phase 1a core into a daily-usable Dropbox-like product: a trash with restore (original IDs) and 30-day auto-empty, public share links for files and folders (password, expiry, optional external upload, folder ZIP), thumbnails and QuickLook previews (images incl. HEIC, PDF, text/markdown/code, video/audio), full-text + name search with a ⌘K palette and a "Recent" view, and resumable (tus) uploads — plus the SHOULD-FIX-SOON hardening items from Phase 1a.

**Architecture:** Same NestJS/Prisma/Postgres server; a second process from the same image (`main.worker.ts`) computes content hashes, thumbnails/previews and extracted text from a table-driven job queue (`DerivativeJob`, claimed with `FOR UPDATE SKIP LOCKED`) and stores derivatives content-addressed under `/meta/derived`. New HTTP areas: `/api/trash`, `/api/shares` (owner), `/api/public/shares/:token` (anonymous), `/api/sync/v1/{search,recent,items/:id/thumbnail,items/:id/preview-text,uploads}`. Web gets Trash, Shared, Recent pages, a share dialog, QuickLook modal, ⌘K search and a public share page at `/s/:token`.

**Tech Stack (additions):** sharp (libvips) for images, `heif-convert` (Debian `libheif-examples`) for HEIC, ffmpeg/ffprobe for video frames, `pdftoppm`/`pdftotext` (poppler-utils) for PDF, `unzip` CLI for OOXML/ODF text, archiver for ZIP, @tus/server + @tus/file-store (server), tus-js-client (web), pdf.js not needed (browser native viewer), highlight.js (core + selected languages, lazy), marked + DOMPurify (lazy).

**Spec:** `docs/superpowers/specs/2026-10-15-synclet-design.md` (§4 deltas tus/thumbnail, §5 derivatives pipeline, §6 trash/versions/shares/search, §10 web design). Follow-ups/rulings from 1a: `docs/superpowers/followups/2026-10-15-phase-1a-followups.md`.

**User decisions for 1b (2026-10-15):** trash auto-empty after **30 days** (env, 0 = never); folder share links: **browse + preview + single download + ZIP + optional "allow uploads"**; QuickLook: **images incl. HEIC, PDF, text/markdown/code, video/audio**.

## Global Constraints

- Everything from Phase 1a's Global Constraints still holds (Node ≥ 24, pnpm 11, NestJS 11, Fastify 5, Prisma 6, Postgres 16, React 19, Tailwind 4; English code/comments; UI strings via i18next de+en; Conventional Commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; every mutation under `journal.lockUser` in `TX_OPTS`).
- **Nothing is ever written inside `/data` except user content** and the transient ignored names `.synclet-tmp-*` / `.synclet-trash-*`. Derivatives, extracted text, tus upload parts, share metadata live in Postgres or under `/meta` (`/meta/derived`, `/meta/uploads`, `/meta/trash`, `/meta/staging`).
- The worker only **reads** `/data` (compose mounts it read-only for the worker) and writes `/meta/derived` + DB rows. It never journals except where a task says so.
- **Work happens on branch `phase-1b`; it lands on `main` only through a GitHub pull request** (repo `eltomato89/synclet`). Task branches `phase1b/task-N` are merged into `phase-1b` locally by the controller.
- Server tests: `cd apps/server && TEST_DATABASE_URL=postgresql://synclet:synclet@localhost:5434/synclet_test_<taskN> pnpm test [path]` (dev Postgres from `deploy/compose.dev.yml`; `migrate deploy` creates the DB; never `migrate reset`, never set `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`). New tables must be added to `resetDb` in `apps/server/test/context.ts`.
- New Prisma migrations are created with `pnpm prisma migrate dev --create-only --name <name>` against the dev DB (`…/synclet`), edited if raw SQL is needed, then applied with `pnpm prisma migrate dev`. Only Task 1 creates a migration unless a task says otherwise.
- Public (anonymous) routes never reveal whether a token exists for revoked/expired links beyond `404 not_found`; password-protected shares return `401 {code:'share_password_required'}` until unlocked.
- Folder etags are opaque (`t` + 16 hex, Phase 1a ruling); file etags `v<version>`.
- Web: no external CDNs; heavy viewers (highlight.js, marked, DOMPurify) are lazy-loaded chunks; all new visible strings in `de.json` + `en.json`.
- External tools are invoked with `execFile` (never a shell), argument arrays, a timeout (default 60 s, ffmpeg 120 s) and `maxBuffer`; inputs are absolute paths validated with `realpathInside`.

## Review Focus

1. **Restoring a trashed folder whose original location is now occupied or gone** – expected: restored next to it with a free name (`Name (2)`) or at the root if the parent no longer exists; never overwrites; IDs of the restored subtree are the original IDs unless such an ID is currently live (then a new ID). Test in Task 3.
2. **Share link scope escape** – a public token for folder `A` must never serve anything outside `A` (by id, by `..`, by symlink, after `A` is moved — the share follows the item id). Tests in Task 4.
3. **Previews of hostile files** – an uploaded SVG/HTML must never execute script on the app origin through the preview or thumbnail path; a decompression-bomb image or a 10 GB video must not exhaust the worker (pixel limit, size limits, timeouts). Tests in Tasks 5 and 6.
4. **Interrupted resumable upload** – tus upload interrupted at 60 % resumes from the server offset; abandoned uploads are cleaned from `/meta/uploads` after 24 h; nothing appears in `/data` before completion. Test in Task 7.
5. **Search leaks** – search must only return the caller's live items (never other users', never trashed), including results from extracted text of files in folders the user still owns. Test in Task 6.

---

## Parallel execution waves (max 5 concurrent subagents)

| Wave | Tasks | Depends on |
|---|---|---|
| 0 | T1 Schema, shared types, config, worker skeleton, BusyPaths removal | – |
| 1 | T2 Hardening · T3 Trash backend · T4 Share backend · T5 Derivatives worker (hash + thumbnails) · T7 tus uploads | T1 |
| 2 | T6 Text extraction + search + recent · T8 Web: Trash + Shared + share dialog · T9 Web: thumbnails + QuickLook | T5 (T6), T3+T4 (T8), T5 (T9) |
| 3 | T10 Web: search palette + Recent + tus client · T11 Web: public share page · T12 Docker/worker/README | T6+T7 (T10), T4 (T11), T5 (T12) |
| 4 | T13 End-to-end | all |

## File map (new or substantially changed)

```
apps/server/prisma/schema.prisma (+ migration 1b_core)
apps/server/src/config.ts                       (+ trashRetentionDays, searchLanguage, workerConcurrency, derivedRoot helpers)
apps/server/src/main.worker.ts, src/worker.module.ts
apps/server/src/derivatives/{jobs.service.ts, hash.ts, thumbnails.ts, tools.ts, text-extract.ts, derived-store.ts, worker.runner.ts}
apps/server/src/trash/{trash.service.ts, trash.controller.ts, trash.module.ts}
apps/server/src/shares/{shares.service.ts, shares.controller.ts, public-shares.controller.ts, share-auth.ts, zip.ts, shares.module.ts}
apps/server/src/search/{search.service.ts, search.controller.ts, search.module.ts}
apps/server/src/uploads/{tus.ts, uploads.module.ts}
apps/server/src/sync/sync.controller.ts          (+ thumbnail, preview-text, preview token purpose)
apps/server/src/auth/*                           (rate limit, username rules, setup mkdir order)
packages/shared/src/index.ts                     (+ trash/share/search/preview types)
apps/web/src/features/{trash,shares,preview,search,public}/*
deploy/Dockerfile.server, deploy/compose.yml, deploy/Caddyfile, README.md
scripts/throwaway-test.sh, e2e/tests/*.spec.ts
```

---

### Task 1: Foundation – schema, shared types, config, worker skeleton

**Files:**
- Modify: `apps/server/prisma/schema.prisma`; Create migration `<ts>_phase_1b_core`
- Modify: `apps/server/src/config.ts`, `apps/server/src/config.spec.ts`, `apps/server/test/context.ts` (resetDb list), `packages/shared/src/index.ts`
- Create: `apps/server/src/main.worker.ts`, `apps/server/src/worker.module.ts`, `apps/server/src/derivatives/derived-store.ts`, `apps/server/src/derivatives/derived-store.spec.ts`
- Delete: `apps/server/src/journal/busy-paths.ts` (+ spec) and all uses in `indexer.service.ts`/tests (Phase 1a follow-up M7: dead in production)
- Modify: `apps/server/package.json` (scripts `start:worker`, deps for later tasks: `sharp@^0.34`, `archiver@^7`, `@types/archiver`, `@tus/server@^2`, `@tus/file-store@^2`)

**Interfaces:**
- Produces:
  - Prisma models below; enums `DerivativeKind { thumb text }`, `JobStatus { pending running done failed unsupported }`
  - `AppConfig` additions: `trashRetentionDays: number` (env `SYNCLET_TRASH_RETENTION_DAYS`, default 30, 0 = never), `searchLanguage: string` (`SYNCLET_SEARCH_LANGUAGE`, default `simple`), `workerConcurrency: number` (`SYNCLET_WORKER_CONCURRENCY`, default 2), `previewMaxBytes: number` (`SYNCLET_PREVIEW_MAX_BYTES`, default 2 GiB – files above get no derivative), `role: 'server' | 'worker'` (set by entrypoint, not env)
  - `DerivedStore` (`derived-store.ts`): `constructor(metaRoot: string)`, `pathFor(sha: string, kind: 'thumb', size: 256 | 1024): string` → `<metaRoot>/derived/<sha[0:2]>/<sha>/thumb-<size>.webp`, `pathFor(sha, 'poster')` → `…/poster.webp`, `async has(path): Promise<boolean>`, `async writeAtomic(path, data: Buffer): Promise<void>` (tmp + rename inside `/meta/derived`), `async gc(liveShas: (batch: string[]) => Promise<Set<string>>): Promise<number>` (deletes `<sha>` dirs not referenced by any live item, trashed item manifest or versions)
  - `WorkerModule` (Prisma, Core config, Journal not needed); `main.worker.ts` bootstraps `NestFactory.createApplicationContext(WorkerModule.forRoot(config))` and calls `WorkerRunner.run()` (Task 5 implements the runner; T1 ships a runner stub that logs "worker idle" and exits cleanly on SIGTERM)
  - Shared wire types (exact):

```ts
export interface TrashEntryWire {
  id: string; itemId: string; type: 'folder' | 'file'; name: string;
  originalPath: string; size: number; deletedAt: string; expiresAt: string | null;
  itemCount: number;
}
export interface RestoreResult { item: SyncItem; restoredTo: string; renamed: boolean }

export interface ShareLinkWire {
  id: string; itemId: string; itemName: string; itemType: 'folder' | 'file';
  // Full link: absolute if SYNCLET_PUBLIC_URL is set, else "/s/<token>". Always present for the owner
  // (token stored encrypted, see Task 4 ruling 1b-3).
  url: string;
  hasPassword: boolean; expiresAt: string | null; allowDownload: boolean; allowUpload: boolean;
  createdAt: string; revokedAt: string | null; hits: number;
}
export interface CreateShareInput {
  itemId: string; password?: string | null; expiresAt?: string | null;
  allowDownload?: boolean; allowUpload?: boolean;
}
export interface PublicShareInfo {
  name: string; type: 'folder' | 'file'; size: number; mime: string | null;
  ownerDisplayName: string; allowDownload: boolean; allowUpload: boolean; expiresAt: string | null;
}
export interface PublicShareEntry {
  id: string; name: string; type: 'folder' | 'file'; size: number; mime: string | null;
  modifiedAt: string; hasThumbnail: boolean;
}

export interface SearchHit { item: SyncItem; path: string; snippet: string | null; matched: 'name' | 'content' | 'both' }
export interface SearchResponse { hits: SearchHit[]; total: number }

export interface PreviewInfo {
  kind: 'image' | 'pdf' | 'text' | 'markdown' | 'code' | 'video' | 'audio' | 'none';
  thumbnail: boolean;     // a thumbnail exists now
  language?: string;      // highlight.js language for kind === 'code'
}
```
  - `SyncItem` gains optional `preview?: PreviewInfo` (set by the serializer from `DerivativeJob` state; absent = unknown) — add the field to `SyncItem` in shared types.
  - `SyncErrorCode` gains `'share_password_required' | 'share_expired' | 'rate_limited' | 'upload_not_allowed'`.

- [ ] **Step 1: Schema changes**

Add to `schema.prisma` (keep existing models; extend `TrashEntry`):

```prisma
enum DerivativeKind {
  thumb
  text
}

enum JobStatus {
  pending
  running
  done
  failed
  unsupported
}

/// One derivative computation per content hash and kind (content-addressed; shared by copies).
model DerivativeJob {
  sha       String
  kind      DerivativeKind
  status    JobStatus @default(pending)
  attempts  Int       @default(0)
  lastError String?
  /// e.g. { "sizes": [256, 1024], "poster": true, "width": 4032, "height": 3024 }
  meta      Json?
  lockedAt  DateTime?
  updatedAt DateTime  @updatedAt
  createdAt DateTime  @default(now())

  @@id([sha, kind])
  @@index([status, kind])
}

/// Extracted plain text per content hash for full-text search (tsv maintained via raw SQL).
model ItemText {
  sha       String   @id
  /// First 1 MiB of extracted text (snippets); tsv column added in raw SQL migration.
  content   String
  createdAt DateTime @default(now())
}

model ShareLink {
  id            String    @id @default(uuid()) @db.Uuid
  tokenHash     String    @unique
  /// AES-256-GCM encrypted token (base64url iv.ciphertext.tag) so the owner can re-copy the link.
  tokenEnc      String
  itemId        String    @db.Uuid
  ownerId       String    @db.Uuid
  owner         User      @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  passwordHash  String?
  expiresAt     DateTime?
  allowDownload Boolean   @default(true)
  allowUpload   Boolean   @default(false)
  revokedAt     DateTime?
  hits          Int       @default(0)
  createdAt     DateTime  @default(now())

  @@index([ownerId])
  @@index([itemId])
}
```
Add `shareLinks ShareLink[]` to `User`. Extend `TrashEntry` with `expiresAt DateTime?` and `@@index([expiresAt])`. Change the documented manifest shape (comment only) to `[{ id, type, path, name, mtime, size, contentHash }]` – Task 3 writes the richer shape for new entries and tolerates the old one.

Run: `cd apps/server && DATABASE_URL=postgresql://synclet:synclet@localhost:5434/synclet pnpm prisma migrate dev --create-only --name phase_1b_core`

Append to the generated `migration.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- unaccent() is STABLE; an IMMUTABLE wrapper is required for index expressions.
CREATE OR REPLACE FUNCTION synclet_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

ALTER TABLE "ItemText" ADD COLUMN tsv tsvector;
CREATE INDEX "ItemText_tsv_idx" ON "ItemText" USING GIN (tsv);
CREATE INDEX "Item_name_trgm_idx" ON "Item" USING GIN (synclet_unaccent(lower(name)) gin_trgm_ops) WHERE "deletedAt" IS NULL;
CREATE INDEX "Item_owner_mtime_idx" ON "Item" ("ownerId", mtime DESC) WHERE "deletedAt" IS NULL AND type = 'file';
CREATE INDEX "Item_contentHash_idx" ON "Item" ("contentHash") WHERE "deletedAt" IS NULL;
```
Then `DATABASE_URL=… pnpm prisma migrate dev`. Expected: applied.

- [ ] **Step 2: Config + tests** – add the fields above to `AppConfig`/`loadConfig` with the `int()`/empty-means-default helpers already in `config.ts`; extend `config.spec.ts` with defaults and overrides for each new env var.

- [ ] **Step 3: DerivedStore with tests**

`derived-store.spec.ts` must cover: `pathFor` layout for sizes 256/1024 and `poster`; `writeAtomic` leaves no temp files on success and none on failure (simulate by making the target dir read-only); `gc` removes only sha dirs whose sha is absent from the callback's returned set and returns the count; `pathFor` rejects a non-hex sha (`/^[0-9a-f]{64}$/`).

- [ ] **Step 4: Worker skeleton** – `main.worker.ts`, `worker.module.ts`, stub runner; `package.json` script `"start:worker": "node dist/main.worker.js"`; a test that `WorkerModule.forRoot(config)` compiles and the stub runner resolves after `stop()`.

- [ ] **Step 5: Remove BusyPaths** – delete the file and spec, drop it from `JournalModule` providers/exports and from `IndexerService` (5 call sites) and indexer specs; behavior is unchanged because nothing registers busy paths in production. Run the full server suite.

- [ ] **Step 6: Shared types + resetDb** – add the wire types; add `"DerivativeJob","ItemText","ShareLink"` to the TRUNCATE list in `test/context.ts`.

- [ ] **Step 7: Verify + commit** – `pnpm test && pnpm typecheck && pnpm build` (server), `pnpm --filter @synclet/shared build`, `pnpm --filter @synclet/web typecheck`. Commit `feat(server): phase 1b schema, config, worker skeleton; remove BusyPaths`.

---

### Task 2: Hardening from Phase 1a follow-ups

**Files:** `apps/server/src/auth/{users.service.ts, auth.service.ts, auth.controller.ts, setup.controller.ts, rate-limit.ts}`, `apps/server/src/indexer/{scheduler.service.ts, indexer.service.ts}`, `apps/server/src/sync/sync.controller.ts`, `apps/web/src/features/files/uploads.ts`, `deploy/Caddyfile`, tests next to each.

**Interfaces:**
- Produces: `RateLimiter` (`auth/rate-limit.ts`): `new RateLimiter({ capacity: number; refillPerSec: number; maxKeys?: number })`, `.take(key: string): boolean`, `.reset(key)`; in-memory, LRU-bounded (default 10 000 keys).

Items (each with a test):
1. **Login rate limit**: per `ip` (5 burst, 1 per 10 s) and per normalized login (10 burst, 1 per 30 s); exceeding returns `429 {code:'rate_limited'}` with `Retry-After`. Successful login resets the per-login bucket. Apply the same per-IP limiter to `POST /api/setup` and to public share password checks (Task 4 imports it).
2. **Usernames**: reject bidi controls (`‎‏‪-‮⁦-⁩`), zero-width (`​-‍⁠﻿`) and `@` in usernames (`users.service.ts validateUsername`).
3. **Setup mkdir order (M4)**: create/verify the user root (mkdir + write access check via `access(W_OK)`) **before** the DB transaction; on failure return `500 {code:'invalid_request', message:'data folder not writable: …'}` and create no user. Also refuse setup if `dataRoot` itself is not writable.
4. **Temp sweep (M1)**: during the first full scan after boot, the scheduler removes `.synclet-tmp-*` files **and directories** at any depth that are older than 1 h (by mtime) – implement as a separate recursive walk in `SchedulerService.startupCleanup()` limited to names matching `isTempName`, never following symlinks, never touching `.synclet-trash-*`.
5. **Cache-Control (M10)**: `GET items/:id/content` sends `Cache-Control: private, no-store`.
6. **Web upload stuck (M5)**: `uploads.ts` – refresh rejection marks the task `error` (`network`) and pumps; `JSON.parse` of a 2xx body wrapped (→ `error`/`server_error`).
7. **Caddy headers**: `Strict-Transport-Security "max-age=31536000"` only when `SYNCLET_SITE_ADDRESS` is a domain (use a Caddy `@https` matcher on `{scheme} == https`); a CSP for the SPA: `default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; frame-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'` (do not apply to `/api/*`, whose content responses already carry their own CSP).

Commit per logical group; full server + web suites green.

---

### Task 3: Trash backend – list, restore with original IDs, delete forever, auto-empty

**Files:**
- Create: `apps/server/src/trash/{trash.service.ts, trash.controller.ts, trash.module.ts, trash.spec.ts, trash.e2e.spec.ts}`
- Modify: `apps/server/src/files/files.service.ts` (richer manifest on `remove()`; export the no-replace copy helpers it already has if needed), `apps/server/src/indexer/scheduler.service.ts` (maintenance calls `trash.expire()`), `apps/server/src/app.module.ts`

**Interfaces:**
- Consumes: `FilesService` internals (`moveAcrossFs`, `copyThenRemove`, `linkNoReplace`/`moveNoReplace` from `files/fs-ops.ts`, `assertRealDir`), `JournalService.lockUser/record`, `ItemStore`, `freeName`, `nameKey`, `SerializerService.toSyncItems`.
- Produces:
  - `TrashService.list(user): Promise<TrashEntryWire[]>` (newest first; `itemCount` = manifest length; `expiresAt` = deletedAt + retention or null)
  - `TrashService.restore(user, trashId): Promise<RestoreResult>`
  - `TrashService.deleteForever(user, trashId): Promise<void>`
  - `TrashService.empty(user): Promise<number>`
  - `TrashService.expire(now = new Date()): Promise<number>` (all users; entries with `expiresAt < now`)
  - Routes (AuthGuard, JWT or device token): `GET /api/trash`, `POST /api/trash/:id/restore` → 200 `RestoreResult`, `DELETE /api/trash/:id` → 204, `DELETE /api/trash` → `{ removed: number }`
  - `remove()` now writes `expiresAt` and manifest entries `{ id, type, path, name, mtime, size, contentHash }` (path = absolute rel path within the user root at delete time, as today)

**Restore algorithm (normative):**
1. Load entry (owner-scoped; 404 otherwise). If `storePath` doesn't exist (move still pending in the background trash queue) → await `files.pendingTrash()` once, re-check; still missing → `409 {code:'conflict', message:'trash content not available'}`.
2. Target parent: the live folder at `parentRel(originalPath)` (or root if `''`), checked with `assertRealDir`; if absent → root. Target name: `name`, or `freeName(name, liveSiblingKeys, isFolder)` if taken (`renamed: true`).
3. Copy phase (outside the lock, can be long): `copyThenRemove`-style copy of `storePath` into an ignored temp `<targetDir>/.synclet-tmp-<hex>` (same FS as the target → publish is a rename/link later). For same-FS setups use `rename` directly.
4. Commit phase (under `lockUser`, one transaction): re-validate target parent and name (if now taken → pick next free name); publish the temp with a no-replace move; walk the published tree with `lstat` and, for each manifest entry whose relative path exists, upsert the Item row **with its original id**: if a row with that id exists and is tombstoned → revive (set parentId, name, nameKey, path, size, mtime, ino, dev, deletedAt=null, version+1 for files); if the id is currently **live** elsewhere → create a new id; if no row → create with the original id. Entries on disk not in the manifest get new ids (the indexer would find them anyway). Journal `upsert` for every restored row and same-key siblings at the target. Delete the TrashEntry.
5. After commit: remove the now-empty `storePath` parent dir `/meta/trash/<id>`. On any failure before commit: remove the temp copy; the trash entry stays intact.
6. Old-format manifests (`{id,type,path}` only) work the same (name derived from path).

**Tests (trash.spec.ts / trash.e2e.spec.ts) – at minimum:**
- delete a folder with nested files → `GET /api/trash` lists it with `itemCount`, `expiresAt` = +30 d → restore → same item IDs for folder and children (`GET /api/sync/v1/items/<id>` 200), files byte-identical, `/meta/trash/<id>` gone, `/changes` shows upserts with the original ids.
- restore when the original name is taken → `renamed: true`, name `X (2)`, nothing overwritten (Review Focus 1).
- restore when the parent folder no longer exists → restored at root.
- restore after tombstones were purged (`store.purgeTombstones(new Date(Date.now()+1))`) → still original ids.
- restore when one manifest id is live again (simulate by creating a row with that id) → that item gets a new id, others keep theirs.
- deleteForever removes files from `/meta/trash` and the row; `empty` returns the count; another user's trash id → 404 on every route.
- `expire()` removes entries past `expiresAt` (files + rows), keeps younger ones, and with `trashRetentionDays: 0` sets `expiresAt` null and never expires.
- restore leaves no `.synclet-tmp-*` in the user folder (success and injected failure).
- maintenance calls `expire()` (scheduler spec).

Commit `feat(server): trash listing, restore with original IDs, delete forever, auto-empty`.

---

### Task 4: Share links backend (owner + public API, ZIP, external upload)

**Files:**
- Create: `apps/server/src/shares/{shares.service.ts, shares.controller.ts, public-shares.controller.ts, share-auth.ts, zip.ts, shares.module.ts, shares.spec.ts, public-shares.e2e.spec.ts}`
- Modify: `apps/server/src/app.module.ts`, `apps/server/src/bootstrap.ts` (octet-stream parser also for `/api/public/shares/` upload route)

**Interfaces:**
- Consumes: `FilesService.upload/openRead`, `SerializerService`, `RateLimiter` (Task 2 – if not merged yet, depend on the interface; the controller merges), `argon2`, `hashToken/randomToken` from `auth/crypto.ts`, `ServerConfigService` (JWT secret), `AuthGuard`.
- Produces (owner API, AuthGuard):
  - `POST /api/shares` body `CreateShareInput` → 201 `ShareLinkWire`
  - `GET /api/shares?itemId=` → `ShareLinkWire[]`
  - `POST /api/shares/:id/rotate` → `ShareLinkWire` with a new `url` (old token invalid immediately)
  - `PATCH /api/shares/:id` (password/expiry/allowDownload/allowUpload; `password: null` removes it) → `ShareLinkWire`
  - `DELETE /api/shares/:id` → 204 (sets `revokedAt`)
- Produces (public API, no AuthGuard, rate-limited per IP):
  - `GET /api/public/shares/:token` → `PublicShareInfo` | 404 | 401 `share_password_required` | 410 `share_expired`
  - `POST /api/public/shares/:token/unlock` `{password}` → 204 + cookie `synclet_share_<shareId>` (httpOnly, SameSite=Lax, path `/api/public/shares/<token>`, 12 h, signed JWT `{typ:'share', sid}`) | 401 | 429
  - `GET /api/public/shares/:token/items?folder=<itemId>` → `PublicShareEntry[]` (folder must be the shared folder or a live descendant)
  - `GET /api/public/shares/:token/items/:itemId/content?download=1` → file stream (Range, ETag, same nosniff/CSP-sandbox headers as the sync content route); 403 if `allowDownload` false and `download=1` (inline preview still allowed for images/pdf/video/audio/text)
  - `GET /api/public/shares/:token/items/:itemId/thumbnail?size=256|1024` → webp (Task 5's `DerivedStore`; 404 until available)
  - `GET /api/public/shares/:token/zip?folder=<itemId>` → `application/zip` stream of the folder subtree (403 if `!allowDownload`)
  - `POST /api/public/shares/:token/upload?folder=<itemId>&name=` (raw octet-stream) → 201 `PublicShareEntry` (403 `upload_not_allowed` unless `allowUpload` and the share is a folder; always `onConflict=rename`; size ≤ `maxUploadBytes`; per-IP upload rate limit 20/h)
- **Ruling 1b-3 (token storage):** lookup uses `tokenHash`; additionally the token is stored **encrypted** (`tokenEnc`, AES-256-GCM, key = HKDF-SHA256(ServerConfig.jwtSecret, info `synclet-share-v1`), random 12-byte IV, stored as base64url `iv.ciphertext.tag`) so the owner can copy an existing link at any time (`url` is set in every owner response). `rotate` stays for deliberately invalidating a leaked link. Cost if wrong: a DB + secret leak reveals active share tokens (same blast radius as the data itself).

**Scoping rules (normative):** every public request resolves the share by `tokenHash`, rejects revoked (404) and expired (410), checks password unlock cookie when `passwordHash` set, loads the shared Item (live; else 404) and, for any `itemId`/`folder` param, requires the target to be live, owned by the share owner, and `target.id === shared.id || target.path.startsWith(shared.path + '/')` **evaluated on current DB paths** (so moves of the shared folder keep working); disk access goes through `FilesService.openRead` (realpath + O_NOFOLLOW). Hits counter increments once per info request.

**ZIP (`zip.ts`):** `archiver('zip', { zlib: { level: 1 }, store: false })`, entries streamed in path order from a DB walk of live descendants; each file opened with the same safe open as content; names inside the zip are relative to the shared folder; aborted client → archive `abort()` and all streams destroyed; ZIP64 enabled automatically by archiver for > 4 GiB.

**Tests – at minimum:** create/list/patch/revoke/rotate; public info for file and folder; wrong token 404; revoked 404; expired 410; password flow (401 → unlock wrong 401 → right 204 → cookie grants access; cookie for share A rejected for share B); rate limit returns 429 after the burst; **scope escape** (Review Focus 2): item outside the shared folder by id → 404, item in another user's tree → 404, `folder` param = parent of shared folder → 404, shared folder moved → links still work and still scoped, symlinked subfolder on disk → not listed/not served; download blocked when `allowDownload=false` but inline image preview allowed; ZIP contains exactly the subtree (unzip in test with `unzip -l` via execFile or by parsing with `yauzl` dev-dependency); external upload lands in the shared folder (or chosen subfolder) with rename on conflict and appears in the owner's `/changes`; upload refused when `allowUpload=false`.

Commit `feat(server): share links with password, expiry, folder browse, zip and external upload`.

---

### Task 5: Derivatives worker – hashing, thumbnails, posters, preview info

**Files:**
- Create: `apps/server/src/derivatives/{jobs.service.ts, hash.ts, tools.ts, thumbnails.ts, worker.runner.ts, preview-kind.ts, *.spec.ts}`; test fixtures under `apps/server/test/fixtures/` (tiny jpg, png, heic, pdf, mp4, mp3, svg, txt, md, ts — each < 50 KB; generate the binary ones with ffmpeg/ImageMagick/heif-enc locally and commit; document the generation commands in `test/fixtures/README.md`)
- Modify: `apps/server/src/worker.module.ts`, `apps/server/src/sync/{sync.controller.ts, serializer.service.ts}` (thumbnail route + `preview` field), `apps/server/src/indexer/scheduler.service.ts` (maintenance: `DerivedStore.gc`)

**Interfaces:**
- Produces:
  - `previewKind(name: string, mime: string | null): PreviewInfo['kind']` and `codeLanguage(name): string | undefined` (`preview-kind.ts`; table: images jpg/jpeg/png/gif/webp/avif/heic/heif/tif/tiff/bmp → image; svg → **image only via thumbnail, never inline**; pdf; md/markdown → markdown; txt/log/csv/tsv/ini/conf → text; ts/tsx/js/jsx/json/py/go/rs/java/kt/swift/c/h/cpp/cs/rb/php/sh/yml/yaml/toml/xml/html/css/sql → code with language; mp4/m4v/mov/webm/mkv → video; mp3/m4a/aac/wav/flac/ogg/opus → audio)
  - `JobsService.enqueueMissing(limit = 500): Promise<number>` – inserts `DerivativeJob(sha, kind)` rows (`ON CONFLICT DO NOTHING`) for live files with `contentHash` whose kind applies (`thumb` for image/pdf/video kinds; `text` for text/markdown/code/pdf/docx/xlsx/pptx/odt/ods/odp) and size ≤ `previewMaxBytes`
  - `JobsService.claim(kind, n): Promise<DerivativeJob[]>` – `UPDATE … SET status='running', "lockedAt"=now(), attempts=attempts+1 WHERE (sha,kind) IN (SELECT sha,kind FROM "DerivativeJob" WHERE kind=$1 AND (status='pending' OR (status='running' AND "lockedAt" < now()-interval '10 minutes')) AND attempts < 3 ORDER BY "createdAt" LIMIT $2 FOR UPDATE SKIP LOCKED) RETURNING *`
  - `JobsService.complete(sha, kind, status, meta?, error?)`
  - `JobsService.sourceFor(sha): Promise<{ abs: string; name: string; size: bigint } | null>` – any live Item with that hash, path resolved via `realpathInside`, re-verifying size; null if none
  - `hashMissing(limit = 200): Promise<number>` (`hash.ts`) – streams sha256 for live files with `contentHash IS NULL` (≤ `previewMaxBytes`… no: hash all sizes, but at most 1 GiB/s budget per loop) and sets `contentHash` only if `size`, `mtime`, `ino` are unchanged (optimistic `updateMany where …`); **no version bump, no journal** (ruling 1b-1 below)
  - `generateThumb(job): Promise<{ status: 'done' | 'unsupported'; meta }>` (`thumbnails.ts`) – writes `thumb-256.webp` and `thumb-1024.webp` (longest edge, `fit: 'inside'`, `withoutEnlargement`, quality 78, EXIF-rotate), plus `poster.webp` for video
  - Tools (`tools.ts`): `heifToJpeg(abs, outTmp)` (`heif-convert -q 90`), `videoFrame(abs, outTmp)` (`ffprobe` duration → `ffmpeg -ss <10% or 1s> -i abs -frames:v 1 -vf scale=1280:-2 outTmp.jpg`, timeout 120 s), `pdfFirstPage(abs, outTmp)` (`pdftoppm -f 1 -l 1 -r 110 -jpeg -singlefile`), all via `execFile`, all killed on timeout; image decode via sharp with `limitInputPixels: 100_000_000`, `sequentialRead: true`, `failOn: 'error'`
  - `WorkerRunner.run()` loop: every 2 s (or immediately after work): `hashMissing` → `enqueueMissing` → claim up to `workerConcurrency` `thumb` jobs and process concurrently → (Task 6 adds `text`) → sleep; graceful stop on SIGTERM (finish in-flight, release claims)
  - Server route `GET /api/sync/v1/items/:id/thumbnail?size=256|1024` (AuthGuard + `@AllowDownloadToken`): 200 `image/webp` with `ETag: "<sha>-<size>"`, `Cache-Control: private, max-age=31536000, immutable`; 404 `not_found` if no thumbnail yet; 400 for other sizes
  - Serializer: `preview: { kind, thumbnail, language? }` for files — `thumbnail` true iff a `DerivativeJob(sha,'thumb')` is `done`; load job states for a page in one query
  - **Ruling 1b-1:** worker-computed hashes and derivative completion are not journaled. Clients learn `sha256`/`preview.thumbnail` on the next item fetch; the web refetches folders every 15 s. Cost if wrong: native clients won't refresh thumbnails until another change.
  - **Ruling 1b-2:** table-driven queue instead of pg-boss (spec §5 named pg-boss): fewer dependencies, idempotent backfill, `SKIP LOCKED` gives the same safety. Cost if wrong: no retries with backoff schedules (3 attempts, then `failed`).

**Security (Review Focus 3):** SVG is rasterized by sharp with `limitInputPixels` and **never** served inline (thumbnail only); thumbnails are always re-encoded webp; worker refuses files > `previewMaxBytes`; every tool has a timeout and is killed; temp outputs go to `/meta/derived/.tmp` and are removed in `finally`.

**Tests – at minimum:** `previewKind` table; hash backfill sets hashes, skips files that changed during hashing, journals nothing (cursor unchanged); `enqueueMissing` idempotent and shares one job across two files with the same hash; claim with two concurrent claimers never returns the same job; stale `running` jobs are re-claimable after 10 min; thumbnails for jpg (EXIF rotation honored), png, heic, svg (contains `<script>` → produces webp, no script anywhere), pdf, mp4 (poster), mp3 → `unsupported`; a decompression bomb (e.g. 30 000×30 000 PNG generated in the test with sharp `create` at low bit depth) → `failed` without crashing the process; tool timeout kills the child (inject a fake tool that sleeps); thumbnail route 404 → 200 after processing, other user → 404, `size=999` → 400; serializer `preview` field; `DerivedStore.gc` keeps shas referenced by live items and by trash manifests (`contentHash` in manifest), removes others.

Tests that need external tools (`heif-convert`, `ffmpeg`, `pdftoppm`) use `itIfTool(name, …)` (skip with a warning if the binary is missing on the dev Mac); the Linux container run in Task 13 must run all of them.

Commit `feat(worker): content hashing, thumbnails and previews from a SKIP LOCKED job queue`.

---

### Task 6: Text extraction, search, recent

**Files:**
- Create: `apps/server/src/derivatives/text-extract.ts` (+ spec), `apps/server/src/search/{search.service.ts, search.controller.ts, search.module.ts, search.e2e.spec.ts}`
- Modify: `apps/server/src/derivatives/worker.runner.ts` (process `text` jobs), `apps/server/src/sync/sync.controller.ts` (`preview-text` route), `apps/server/src/app.module.ts`

**Interfaces:**
- Produces:
  - `extractText(abs, name, size): Promise<string | null>` – text/markdown/code/csv: read up to 1 MiB, decode UTF-8 (fallback latin1 if invalid UTF-8 > 1 %), strip NULs; pdf: `pdftotext -layout -l 50 abs -` (timeout 60 s); docx/xlsx/pptx/odt/ods/odp: `unzip -p abs <member…>` for `word/document.xml`, `xl/sharedStrings.xml`, `ppt/slides/slide*.xml`, `content.xml` → strip tags (`<[^>]+>` → space), decode XML entities, collapse whitespace; result truncated to 1 MiB; null if nothing
  - Worker: for `text` jobs → `ItemText` upsert (`content`) and `UPDATE "ItemText" SET tsv = to_tsvector($lang::regconfig, synclet_unaccent(content)) WHERE sha=$1`
  - `SearchService.search(user, q: string, opts: { limit: number; offset: number; folderId?: string }): Promise<SearchResponse>` – `q` trimmed, 1..200 chars; name matches: `synclet_unaccent(lower(name)) % synclet_unaccent(lower($q))` OR `ILIKE '%' || $q || '%'` (escape `%_\`), ranked by `similarity`; content matches: `tsv @@ websearch_to_tsquery($lang, synclet_unaccent($q))` joined via `Item.contentHash = ItemText.sha`; union per item id, `matched` = name/content/both, rank = name similarity * 2 + ts_rank; snippet = `ts_headline($lang, content, query, 'StartSel=«,StopSel=»,MaxFragments=1,MaxWords=18,MinWords=6')` for content hits (the web replaces «» with `<mark>` after escaping); only `ownerId = user.id AND deletedAt IS NULL`; optional `folderId` restricts to the folder subtree by path prefix
  - `GET /api/sync/v1/search?q=&limit=20&offset=0&folder=` → `SearchResponse` (limit clamp 1..50)
  - `GET /api/sync/v1/recent?limit=50` → `SyncItem[]` – live files ordered by `mtime DESC` (uses `Item_owner_mtime_idx`)
  - `GET /api/sync/v1/items/:id/preview-text` → `{ text: string; truncated: boolean; encoding: 'utf-8' | 'latin1' }` for text/markdown/code kinds, first 256 KiB read **directly from disk** (fresh, not ItemText), 415 `invalid_request` for other kinds

**Tests – at minimum:** extraction of txt (UTF-8 + latin1), md, ts, pdf (`itIfTool pdftotext`), docx/xlsx/pptx/odt fixtures (`itIfTool unzip`), binary file → null, > 1 MiB truncation; search by exact name, by typo (`Rechnung` vs `Rechnnug`), by accent-insensitive (`Café` ↔ `cafe`), by content word inside a PDF/docx, `matched: 'both'`, snippet markers; **leak tests (Review Focus 5):** other user's matching file never returned, trashed file never returned, file whose content matches but was moved into the trash folder of the user not returned, two users sharing the same content hash only see their own items; `folder` scoping; recent ordering and limit; preview-text for UTF-8 file, truncated flag at 256 KiB, 400/415 for image, other user → 404.

Commit `feat(server): text extraction, name+content search, recent files, text preview`.

---

### Task 7: Resumable uploads (tus 1.0) on the server

**Files:**
- Create: `apps/server/src/uploads/{tus.ts, uploads.module.ts, tus.e2e.spec.ts}`
- Modify: `apps/server/src/bootstrap.ts` (content-type parser for `application/offset+octet-stream` → passthrough for `/api/sync/v1/uploads`), `apps/server/src/app.module.ts`, `apps/server/src/indexer/scheduler.service.ts` (maintenance: expire uploads)

**Interfaces:**
- Consumes: `FilesService.upload` (stream from the completed file), `AuthGuard` logic (call `AuthGuard.resolveFromHeaders(req)` – add a small public method to the guard that returns `AuthUser` or throws `SyncError`), `APP_CONFIG.maxUploadBytes`
- Produces:
  - tus endpoint at `/api/sync/v1/uploads` (POST create, HEAD offset, PATCH append, DELETE terminate, OPTIONS) using `@tus/server` with `@tus/file-store` directory `/meta/uploads`; mounted as Fastify routes that `reply.hijack()` and call `tusServer.handle(req.raw, reply.raw)`
  - `Upload-Metadata` keys: `parentId` (sync id, default `root`), `name` (required), `onConflict` (`rename` default for tus), `modifiedAt` (ISO, optional)
  - `onIncomingRequest`: authenticate (Bearer JWT or `syd_` device token); the upload id is namespaced by user (`namingFunction` → `<userId>-<random>`) and every HEAD/PATCH/DELETE checks the prefix matches the caller (else 404)
  - `onUploadCreate`: validate name (`validateName`), parent exists and is a folder, `Upload-Length ≤ maxUploadBytes` (else 413)
  - `onUploadFinish`: `FilesService.upload(user, parentId, name, createReadStream(filePath), { onConflict, modifiedAt })`; respond with header `X-Synclet-Item: <sync id>` and JSON body `SyncItem` (tus allows a body on the final PATCH response via `onUploadFinish` return value `{ status_code: 200, body, headers }`); then delete the tus file + `.json` metadata
  - Maintenance: delete `/meta/uploads/*` entries whose metadata `creation_date` is older than 24 h (`expire()` from FileStore with `expirationPeriodInMilliseconds: 24h`)
  - `Tus-Max-Size` header = `maxUploadBytes`

**Tests (Review Focus 4) – using raw HTTP via `app.inject` (no client lib):** create → PATCH 60 % → HEAD shows offset → PATCH rest → item exists with exact bytes, `SyncItem` in final response, file in `/data` only after completion (assert absence after the first PATCH); wrong `Upload-Offset` → 409; other user HEAD/PATCH → 404; no auth → 401; `Upload-Length` over limit → 413; invalid name → 400 `invalid_name` at create; name conflict with `onConflict=rename` → `(2)` name; DELETE terminates and removes files from `/meta/uploads`; expiry removes a 25-h-old abandoned upload (fake `creation_date`); nothing in `/data` named other than the final file (no temp leftovers).

Commit `feat(server): resumable tus uploads into the user folder`.

---

### Task 8: Web – Trash page, Shared page, Share dialog

**REQUIRED SUB-SKILL:** `frontend-design:frontend-design` (keep the established Phase 1a direction; read `apps/web/src/styles/globals.css` header for tokens).

**Files:** `apps/web/src/features/trash/{TrashPage.tsx, queries.ts, *.test.ts}`, `apps/web/src/features/shares/{ShareDialog.tsx, SharedPage.tsx, queries.ts, *.test.ts}`, `apps/web/src/app/router.tsx` (`/trash`, `/shared`), `components/app-shell/Sidebar.tsx` (enable Trash + Shared; Recent is Task 10), `features/files/FileActions.tsx` (+ "Teilen…" action), locales.

**Requirements:**
- Trash page: table (name + icon, original location, deleted date, size, "läuft ab in N Tagen"), row actions Restore / Delete forever (confirm), header action "Papierkorb leeren" (confirm with count), empty state, toast on restore with "Anzeigen" link to the restored item's folder (`restoredTo`), mention when `renamed`. Invalidate `['folder', …]`, `['account']`, `['trash']`.
- Share dialog (from file/folder actions, context menu and a toolbar button when one item is selected): create link with toggles: password (show/hide), expiry (none / 1 day / 7 days / 30 days / custom date), allow download, allow upload (folders only); after creation show the URL with copy button; list existing links for the item with copy/edit/revoke and "Neuen Link erzeugen" (rotate, with a confirm explaining the old link stops working); QR code is out of scope.
- Shared page: all of the user's links (`GET /api/shares`) with item, created, expiry, hits, password/upload badges, actions (copy, edit, new link, revoke), filter active/expired/revoked.
- Tests: queries call the right endpoints and invalidate the right keys; share dialog form validation (expiry in the past rejected, password min 6 chars); trash "expires in" formatting.

Commit `feat(web): trash, shared links page and share dialog`.

---

### Task 9: Web – thumbnails + QuickLook

**REQUIRED SUB-SKILL:** `frontend-design:frontend-design`.

**Files:** `apps/web/src/features/preview/{QuickLook.tsx, viewers/{ImageViewer,PdfViewer,TextViewer,MarkdownViewer,CodeViewer,MediaViewer}.tsx, thumbnails.ts, preview-url.ts, *.test.ts}`, `features/files/{FileGrid.tsx, FileList.tsx, FileIcon.tsx, FilesPage}` integration, locales.

**Requirements:**
- Server change (small, in this task): `POST /api/sync/v1/items/:id/download-token?purpose=preview` returns a token valid **6 h** without `Content-Disposition`, also accepted by the thumbnail route (extend `AuthService.signDownloadToken(userId, itemId, ttl)`; test both TTLs).
- Thumbnails: grid cards and list rows show `thumbnail?size=256` when `item.preview?.thumbnail`; fetched via `<img>` with a preview token URL cached per item id + etag for 5 h (`thumbnails.ts`, in-memory map); `loading="lazy"`, `decoding="async"`, fade-in, fallback to `FileIcon` on error. Do not request thumbnails for items without `preview.thumbnail`.
- QuickLook: Space or double-click on a previewable file opens a full-screen modal (Radix Dialog) with header (name, size, modified, download, share, close), left/right arrows to navigate siblings in the current sort order, Esc closes, focus trapped and restored. Viewers by `preview.kind`:
  - image: `thumbnail?size=1024` first, then the original via content URL for jpg/png/gif/webp/avif (never for svg/heic/tiff → stay on 1024 webp); zoom 1×/fit toggle
  - pdf: `<iframe sandbox="allow-scripts allow-same-origin" src=<content URL with preview token>>` using the browser's PDF viewer
  - text/code/markdown: `GET preview-text`; code highlighted with highlight.js core + only the registered languages (lazy chunk); markdown via marked → DOMPurify (lazy chunk), links `rel="noopener noreferrer" target="_blank"`, images from markdown not loaded (strip `img`)
  - video/audio: native `<video controls>` / `<audio controls>` with the preview-token content URL (Range works), poster = 1024 thumbnail
  - none: big icon + "Keine Vorschau verfügbar" + download button
- Tests: viewer selection by kind; markdown sanitizer strips `<script>`, `onerror=`, `javascript:` links and images; thumbnail URL cache reuse/expiry; keyboard navigation order follows the current sort.

Commit `feat(web): thumbnails and QuickLook previews`.

---

### Task 10: Web – ⌘K search, Recent page, tus uploads

**Files:** `apps/web/src/features/search/{CommandPalette.tsx, queries.ts, highlight.ts, *.test.ts}`, `apps/web/src/features/recent/RecentPage.tsx`, `features/files/uploads.ts` (tus), `components/app-shell/{Topbar.tsx, Sidebar.tsx}`, router `/recent`, locales; dependency `tus-js-client@^4`.

**Requirements:**
- ⌘K / Ctrl+K and a search field in the top bar open a command palette (Radix Dialog + listbox semantics): debounced (200 ms) `GET /search`, results grouped "Namen" / "Inhalte" with icon/thumbnail, path breadcrumb, snippet with `<mark>` (escape first, then replace «/», see Task 6), keyboard ↑↓ Enter (open folder / open file in QuickLook in its folder), "in diesem Ordner suchen" toggle (`folder=`), empty/no-results/error states, recent searches (localStorage, try/catch).
- Recent page: list of recently modified files (`/recent`) using the existing list view (thumbnails, QuickLook, actions).
- Uploads via tus: `UploadQueue` uses `tus-js-client` for every file (chunkSize 16 MiB, `retryDelays [0, 1000, 3000, 5000, 10000]`, `removeFingerprintOnSuccess: true`, metadata per Task 7, `Authorization` header from the current access token via `onBeforeRequest` so refreshed tokens are used), resumes interrupted uploads after a page reload (tus fingerprints in localStorage), keeps cancel/retry/progress/413 handling; the response `SyncItem` from `onSuccess` (`upload.lastResponse`) feeds `result`. Keep the old raw-POST path only as fallback when tus is unsupported (`tus.isSupported` false).
- Tests: highlight escaping (`<img onerror>` in a snippet stays text), palette keyboard model, upload queue with a mocked tus `Upload` class (progress, success with SyncItem, error mapping, resume picks previous upload).

Commit `feat(web): command palette search, recent files and resumable uploads`.

---

### Task 11: Web – public share page `/s/:token`

**REQUIRED SUB-SKILL:** `frontend-design:frontend-design` (public, unauthenticated, branded but minimal; shows owner display name).

**Files:** `apps/web/src/features/public/{PublicSharePage.tsx, api.ts, PublicUploadZone.tsx, *.test.ts}`, router (route outside `RequireAuth`), locales.

**Requirements:** password gate (unlock → cookie; error + rate-limit messages), file share: preview (reuse Task 9 viewers through a small adapter that builds public content/thumbnail URLs) + download button (hidden if `!allowDownload`), folder share: breadcrumb within the share, list/grid with thumbnails, QuickLook, per-file download, "Alles als ZIP herunterladen", upload zone (drag&drop + button, progress, renamed-on-conflict notice) when `allowUpload`, expired/revoked/not-found states, `<meta name="robots" content="noindex">`, no app shell, no auth calls (must not trigger refresh or redirect to login).
- Tests: API adapter URLs, gate state machine, "no auth requests are made" (mock fetch; assert no `/api/auth/*` calls).

Commit `feat(web): public share page with preview, zip download and uploads`.

---

### Task 12: Docker, worker service, README

**Files:** `deploy/Dockerfile.server`, `deploy/compose.yml`, `deploy/.env.example`, `deploy/Caddyfile`, `README.md`

**Requirements:**
- Runtime image adds `ffmpeg poppler-utils libheif-examples unzip` (apt, `--no-install-recommends`), keeps sharp's prebuilt libvips (verify `node -e "require('sharp')"` in the image and that HEIC goes through `heif-convert`).
- Compose: new service `worker` (same image, `command: ["node","/app/dist/main.worker.js"]` via an entrypoint arg so migrations still run only in `server` – entrypoint runs `migrate deploy` only when `SYNCLET_ROLE=server`), `user: ${PUID}:${PGID}`, volumes `${SYNCLET_DATA}:/data:ro`, `${SYNCLET_META}:/meta`, env `DATABASE_URL`, `SYNCLET_WORKER_CONCURRENCY`, `SYNCLET_PREVIEW_MAX_BYTES`, `SYNCLET_SEARCH_LANGUAGE`, `depends_on: server (service_started)`; server gets `SYNCLET_TRASH_RETENTION_DAYS`, `SYNCLET_SEARCH_LANGUAGE`.
- Caddy: `/s/*` served by the SPA (already via try_files) – verify; tus needs `PATCH`/`HEAD`/`OPTIONS` through `/api/*` with `request_body` unlimited and `flush_interval -1` (already) – verify with the e2e.
- README: features list (trash 30 days, shares, previews, search, resumable uploads), the worker container and what it reads/writes, new env vars in the configuration table, disk usage of `/meta/derived` and `/meta/uploads`, privacy note (thumbnails/extracted text stored in `/meta` + DB, removed when files are deleted forever via GC).
- Verify: `docker compose … up -d --build`, worker logs show processing; `docker compose exec worker heif-convert --version`, `ffmpeg -version`, `pdftoppm -v`.

Commit `build: worker service with preview tooling; docs for phase 1b`.

---

### Task 13: End-to-end verification

**Files:** `scripts/throwaway-test.sh`, `e2e/tests/{files,trash,share,preview,search}.spec.ts`, `scripts/server-tests-linux.sh` (ensure tools installed in the Linux test container: `apt-get install -y ffmpeg poppler-utils libheif-examples unzip`)

**Requirements:**
- Throwaway script additions: delete a folder via API → restore → same IDs; create a share link for a folder → anonymous `GET` info + ZIP download (unzip -l matches) → external upload lands in the folder on disk; upload a jpg/pdf → thumbnail endpoint eventually 200 (poll ≤ 60 s); search finds a word inside the pdf; tus upload via curl (create/patch/patch) produces the file; **final fidelity check unchanged**: after `down -v`, the data folder contains exactly the expected tree (incl. restored folder, externally uploaded file) and no `.synclet-*`; `/meta/derived` non-empty; `/meta/uploads` empty.
- Playwright: trash (delete → trash page → restore → back in folder), share (create link with password → open in a fresh browser context → unlock → download a file → ZIP), QuickLook (image, pdf iframe present, markdown rendered with sanitized content, video element present), search (⌘K finds a file by content, Enter opens its folder with QuickLook), resumable upload (abort mid-way by going offline via `context.setOffline(true)`, reload, upload resumes and completes).
- Linux server suite: all `itIfTool` and `itIfCaseSensitive` tests must run (no skip warnings).

Commit `test: phase 1b end-to-end coverage`.

---

## Out of scope for Phase 1b

Euro-Office, optional versions, admin UI, conformance package, PKCE app login (Phase 1c); SSE `/events` and native clients (Phase 2+); share link QR codes, share link email invites, per-user quotas.
