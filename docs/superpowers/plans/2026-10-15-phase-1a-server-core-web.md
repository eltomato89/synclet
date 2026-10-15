# Synclet Phase 1a – Server Core + Web Basics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Docker-Compose-deployable Synclet server that indexes a mounted folder (`/data/<username>/`) as the source of truth, exposes Buro-compatible Sync API v1, and ships a polished web UI for login, browsing, upload, download, new folder, rename, move and delete.

**Architecture:** NestJS 11 (Fastify 5) + Prisma 6 + PostgreSQL 16. The disk is authoritative: an indexer (watcher + reconcile scan) mirrors it into an `Item` table with stable IDs, every mutation (API or indexer) runs under a per-user advisory lock and writes a gap-free per-user change journal (`FileChange`). The web app (React + Vite + Tailwind + shadcn/ui) talks to the same Sync API v1 as native clients will.

**Tech Stack:** Node ≥ 24, pnpm 11, NestJS 11, Fastify 5, Prisma 6, PostgreSQL 16, argon2, @nestjs/jwt, @fastify/cookie, @parcel/watcher, mime-types, zod 3, Jest + ts-jest (server); React 19, Vite 7, Tailwind 4, shadcn/ui, TanStack Query 5, react-router 7, i18next, Vitest, Playwright (web); Caddy 2.

**Spec:** `docs/superpowers/specs/2026-10-15-synclet-design.md` (read §2 "Dateisystem als Source of Truth", §3, §4, §8, §9, §10). Template contract: `/Volumes/Daten/Privat/SaaS/BuroApp/buro/docs/sync/SYNC_API.md` (Buro Sync API v1).

## Global Constraints

- Node `>=24`, pnpm `11.x`, NestJS `^11`, Fastify `^5`, Prisma `^6`, PostgreSQL `16`, React `^19`, Tailwind `^4`.
- **Nothing is ever written inside `/data` except user content** and the transient temp files `/data/<username>/.synclet-tmp-<id>` (ignored by the indexer, deleted at startup). No xattrs, no hidden dirs, no metadata files.
- All metadata lives in PostgreSQL or under `SYNCLET_META_ROOT` (`/meta`): trash in `/meta/trash/<trashId>/`.
- Sync API base path: `/api/sync/v1`. Error body: `{ "statusCode": <n>, "message": "…", "code": "<code>", "item"?: SyncItem }` with codes from Buro SYNC_API §1.
- Sync IDs: `root` (user root, no DB row), `d_<uuid>` (folder), `f_<uuid>` (file). Device tokens: `syd_<43 base64url chars>`; refresh tokens: `syr_<43 chars>`.
- Etags: file `v<version>`, folder `t<updatedAtMs>`; `contentEtag` = `v<version>` for files, `null` for folders. HTTP `ETag`/`If-Match` values are quoted (`"v3"`); parse with or without quotes.
- Names created via API are NFC-normalized and must pass `validateName` (Task 2). Names found on disk are never rewritten.
- Code, identifiers and comments in **English** (open source). UI strings via i18next in **German (default) and English**.
- Every mutation: `prisma.$transaction(async tx => { await journal.lockUser(tx, userId); … }, TX_OPTS)` with `TX_OPTS = { timeout: 60_000, maxWait: 30_000 }`.
- Background jobs (watcher, scans) are disabled when `SYNCLET_BACKGROUND=off` (tests).
- Commit style: Conventional Commits; every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- macOS dev hosts have case-insensitive, normalization-insensitive APFS: tests that need `a.txt` + `A.txt` or NFC + NFD siblings on disk must use `itIfCaseSensitive` (Task 1 helper) and are fully exercised in the Linux container (Task 12).

## Review Focus

1. **Empty/unmounted data volume** (`/data` mounted from a missing host path) – expected: the indexer refuses to scan, journals **no** deletes, logs an error. Test in Task 5 (`refuses to scan when data root has no user folders`).
2. **Stale write after an external edit not yet indexed** (host edits file, client PUTs with the old `If-Match`) – expected: `412 conflict` with the fresh item, never a silent overwrite. Test in Task 6 (`replaceContent detects unindexed external edit`).
3. **Upload whose name matches an unindexed file just created on the host** – expected: never overwrites; `409 name_conflict` (or next free name with `onConflict=rename`). Test in Task 6 (`upload never overwrites unindexed file`).
4. **Symlink in the data folder pointing outside** (`ln -s /etc evil`) – expected: never indexed, never served, path checks reject escapes. Tests in Task 1 (`absPath`/`realpathInside`) and Task 5 (`skips symlinks`).
5. **Aborted upload** (client disconnects mid-stream) – expected: no partial file visible in the user's folder, no DB row. Test in Task 6 (`aborted upload leaves nothing behind`).

---

## Parallel execution waves (max 5 concurrent subagents)

Each task runs in its own git worktree/branch (`phase1a/task-N`), merged into `main` by the controller after review. Task 1 creates all module stubs so later tasks only touch their own folders.

| Wave | Tasks (parallel) | Depends on |
|---|---|---|
| 0 | T1 Monorepo + server skeleton + schema, then T2 Names (same agent, sequential) | – |
| 1 | T3 Auth · T4 Journal/ItemStore · T9 Web shell + auth UI | T1, T2 |
| 2 | T5 Indexer · T6 FilesService · T10 Web file browser | T2+T4 (T5,T6), T9 (T10) |
| 3 | T7 Sync API controller · T8 Watcher/scheduler/status · T11 Docker | T3,T5,T6 (T7), T5 (T8), T1 (T11) |
| 4 | T12 End-to-end + throwaway test | all |

## File map

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, .gitignore, .editorconfig, README.md
deploy/compose.dev.yml            Postgres for dev/tests (port 5434)
deploy/compose.yml                Production stack (T11)
deploy/Caddyfile, deploy/.env.example, deploy/Dockerfile.server, deploy/Dockerfile.caddy (T11)
packages/shared/src/index.ts      Wire types (SyncItem, SyncAccount, …) – types only
apps/server/
  prisma/schema.prisma, prisma/migrations/*
  src/main.ts                     Bootstrap (listen)
  src/bootstrap.ts                configureApp(): cookie, raw-body parser, prefix, filter
  src/app.module.ts               AppModule.forRoot(config)
  src/config.ts                   AppConfig + loadConfig + APP_CONFIG token
  src/prisma/prisma.{module,service}.ts
  src/common/paths.ts             userRoot/joinRel/parentRel/absPath/realpathInside
  src/common/sync-error.ts        SyncError + SyncErrorFilter
  src/common/zod.pipe.ts          ZodPipe
  src/common/events.ts            AppEvents (typed EventEmitter)
  src/common/types.ts             IndexUser, AuthUser
  src/common/names.ts             (T2) name rules + display names
  src/auth/*                      (T3) setup, login, sessions, guard, users, devices service
  src/journal/*                   (T4) JournalService, ItemStore, BusyPaths
  src/indexer/*                   (T5) IndexerService (+ T8 watcher, scheduler, status)
  src/files/*                     (T6) FilesService
  src/sync/*                      (T7) serializer, ids, range, controllers
  test/env.ts, test/global-setup.ts, test/context.ts
apps/web/                          (T9, T10)
e2e/ , scripts/throwaway-test.sh  (T12)
```

---

### Task 1: Monorepo, server skeleton, Prisma schema, test harness

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.editorconfig`, `deploy/compose.dev.yml`
- Create: `packages/shared/{package.json,tsconfig.json,src/index.ts}`
- Create: `apps/server/{package.json,tsconfig.json,tsconfig.build.json,nest-cli.json,jest.config.js,.env.example}`
- Create: `apps/server/prisma/schema.prisma` + migration `init`
- Create: `apps/server/src/{main.ts,bootstrap.ts,app.module.ts,config.ts}`, `src/prisma/*`, `src/common/{paths.ts,sync-error.ts,zod.pipe.ts,events.ts,types.ts}`
- Create module stubs: `src/auth/auth.module.ts`, `src/journal/journal.module.ts`, `src/indexer/indexer.module.ts`, `src/files/files.module.ts`, `src/sync/sync.module.ts`
- Test: `apps/server/src/common/paths.spec.ts`, `apps/server/test/{env.ts,global-setup.ts,context.ts}`, `apps/server/test/health.spec.ts`

**Interfaces:**
- Produces:
  - `loadConfig(env?: NodeJS.ProcessEnv): AppConfig`, `APP_CONFIG` injection token
  - `AppConfig { dataRoot: string; metaRoot: string; port: number; background: boolean; watch: boolean; scanIntervalSec: number; tombstoneWindowSec: number; journalRetentionDays: number; maxUploadBytes: number; publicUrl: string | null; secureCookies: boolean }`
  - `AppModule.forRoot(config: AppConfig): DynamicModule`, `configureApp(app: NestFastifyApplication): Promise<void>`
  - `PrismaService` (global), `AppEvents` (global, events `'user.created'(user: IndexUser)`)
  - `IndexUser { id: string; username: string }`, `AuthUser extends IndexUser { role: 'admin' | 'user'; deviceId: string | null }`
  - `userRoot(dataRoot, username)`, `joinRel(parentRel, name)`, `parentRel(rel)`, `baseName(rel)`, `absPath(dataRoot, username, rel)`, `realpathInside(abs, root): Promise<string>`
  - `SyncError(code: SyncErrorCode, message?: string, itemRow?: Item)`, `SyncErrorFilter` with static hook `SyncErrorFilter.serializeItem?: (row: Item) => Promise<unknown>`
  - `ZodPipe(schema)`
  - Test helpers: `createTestApp(overrides?)`, `createTestUser(ctx, username?)`, `itIfCaseSensitive`, `resetDb(prisma)`
  - Shared wire types (see Step 4)

- [ ] **Step 1: Root workspace files**

`package.json`:
```json
{
  "name": "synclet",
  "private": true,
  "packageManager": "pnpm@11.7.0",
  "engines": { "node": ">=24" },
  "scripts": {
    "dev:db": "docker compose -f deploy/compose.dev.yml up -d",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - apps/server
  - apps/web
  - packages/*
onlyBuiltDependencies:
  - "@prisma/client"
  - "@prisma/engines"
  - prisma
  - argon2
  - "@parcel/watcher"
  - esbuild
```
(If pnpm 11 reports ignored build scripts anyway, run `pnpm approve-builds` and approve exactly these packages.)

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
coverage/
.env
*.log
.DS_Store
playwright-report/
test-results/
```

`.editorconfig`: 2 spaces, LF, utf-8, final newline.

`deploy/compose.dev.yml`:
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: synclet
      POSTGRES_PASSWORD: synclet
      POSTGRES_DB: synclet
    ports: ["5434:5432"]
    volumes: [pgdata-dev:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U synclet"]
      interval: 2s
      retries: 30
volumes:
  pgdata-dev:
```
Run: `docker compose -f deploy/compose.dev.yml up -d && docker compose -f deploy/compose.dev.yml exec postgres psql -U synclet -c 'CREATE DATABASE synclet_test'`
Expected: `CREATE DATABASE`.

- [ ] **Step 2: Shared package (types only)**

`packages/shared/package.json`:
```json
{
  "name": "@synclet/shared",
  "version": "0.1.0",
  "private": true,
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p .",
    "prepare": "tsc -p .",
    "typecheck": "tsc -p . --noEmit"
  },
  "devDependencies": { "typescript": "^5.9.0" }
}
```
`packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "declaration": true, "emitDeclarationOnly": true },
  "include": ["src"]
}
```
`packages/shared/src/index.ts`:
```ts
// Wire types of the Synclet Sync API v1 (compatible with Buro SYNC_API v1).
// Types only – consumers use `import type`.

export type SyncErrorCode =
  | 'unauthorized' | 'device_revoked' | 'forbidden' | 'not_found' | 'name_conflict'
  | 'invalid_move' | 'invalid_name' | 'invalid_request' | 'cursor_expired' | 'conflict'
  | 'precondition_required' | 'too_large' | 'range_not_satisfiable' | 'setup_done';

export interface SyncCapabilities {
  read: true; write: boolean; rename: boolean; move: boolean; delete: boolean; addChildren: boolean;
}

export interface SyncItem {
  id: string;
  parentId: string | null;
  type: 'folder' | 'file';
  kind: 'root' | 'folder' | 'file';
  name: string;
  size: number;
  mime: string | null;
  version: number | null;
  sha256: string | null;
  etag: string;
  contentEtag: string | null;
  createdAt: string;
  modifiedAt: string;
  documentId: string | null;
  capabilities: SyncCapabilities;
}

export interface SyncAccount {
  userId: string; email: string | null; displayName: string;
  organizationId: string; organizationName: string; slug: string;
  canWrite: boolean;
  areas: { personal: true; shared: boolean; customers: boolean; projects: boolean };
  quotaBytes: number; usedBytes: number; maxUploadBytes: number;
  cursor: string;
}

export interface SyncDevice {
  id: string; name: string; platform: 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'web';
  appVersion: string; createdAt: string; lastSeenAt: string | null; current?: boolean;
}

export type SyncChange = { op: 'upsert'; item: SyncItem } | { op: 'delete'; id: string };
export interface SyncChangesPage { changes: SyncChange[]; cursor: string; hasMore: boolean }
export interface SyncChildrenPage { items: SyncItem[]; nextPageToken: string | null; cursor: string }
export interface SyncErrorBody { statusCode: number; message: string; code: SyncErrorCode; item?: SyncItem }

export interface PublicUser {
  id: string; username: string; displayName: string; email: string | null; role: 'admin' | 'user';
}
export interface AuthResponse { accessToken: string; user: PublicUser }
export interface SetupStatus { needsSetup: boolean }
export interface ServerStatus {
  watch: 'active' | 'scan-only' | 'off';
  lastFullScanAt: string | null;
  users: number;
}
```
Run: `pnpm install && pnpm --filter @synclet/shared build`
Expected: `packages/shared/dist/index.d.ts` exists.

- [ ] **Step 3: Server package, Nest config, Jest**

`apps/server/package.json`:
```json
{
  "name": "@synclet/server",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "prisma generate && nest build -p tsconfig.build.json",
    "start": "node dist/main.js",
    "dev": "nest start --watch",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "jest --runInBand",
    "prisma": "prisma"
  },
  "dependencies": {
    "@fastify/cookie": "^11.0.0",
    "@nestjs/common": "^11.0.0",
    "@nestjs/core": "^11.0.0",
    "@nestjs/jwt": "^11.0.0",
    "@nestjs/platform-fastify": "^11.0.0",
    "@parcel/watcher": "^2.5.0",
    "@prisma/client": "^6.0.0",
    "@synclet/shared": "workspace:*",
    "argon2": "^0.41.1",
    "fastify": "^5.0.0",
    "mime-types": "^3.0.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@nestjs/cli": "^11.0.0",
    "@nestjs/testing": "^11.0.0",
    "@types/jest": "^29.5.0",
    "@types/mime-types": "^2.1.4",
    "@types/node": "^24.0.0",
    "jest": "^29.7.0",
    "prisma": "^6.0.0",
    "ts-jest": "^29.2.0",
    "typescript": "^5.9.0"
  }
}
```
`apps/server/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node",
    "outDir": "dist",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strictPropertyInitialization": false,
    "types": ["node", "jest"]
  },
  "include": ["src", "test"]
}
```
`apps/server/tsconfig.build.json`:
```json
{ "extends": "./tsconfig.json", "compilerOptions": { "rootDir": "src" }, "include": ["src"], "exclude": ["**/*.spec.ts"] }
```
`apps/server/nest-cli.json`:
```json
{ "$schema": "https://json.schemastore.org/nest-cli", "collection": "@nestjs/schematics", "sourceRoot": "src", "compilerOptions": { "deleteOutDir": true, "tsConfigPath": "tsconfig.build.json" } }
```
`apps/server/jest.config.js`:
```js
module.exports = {
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/test/env.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  testTimeout: 30000,
};
```
`apps/server/.env.example`:
```
DATABASE_URL=postgresql://synclet:synclet@localhost:5434/synclet
SYNCLET_DATA_ROOT=/absolute/path/to/your/test/folder
SYNCLET_META_ROOT=/absolute/path/to/meta
```

- [ ] **Step 4: Prisma schema + migration**

`apps/server/prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  admin
  user
}

enum ItemType {
  folder
  file
}

enum ChangeOp {
  upsert
  delete
}

/// Singleton row (id = 1) created on first start.
model ServerConfig {
  id        Int      @id @default(1)
  serverId  String   @db.Uuid
  jwtSecret String
  createdAt DateTime @default(now())
}

model User {
  id          String       @id @default(uuid()) @db.Uuid
  /// Folder name below the data root.
  username    String       @unique
  email       String?      @unique
  displayName String
  role        Role         @default(user)
  disabledAt  DateTime?
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  identities  Identity[]
  sessions    Session[]
  devices     SyncDevice[]
  items       Item[]
  scope       SyncScope?
}

/// Login identities: provider 'local' (subject = username lower-case) or 'oidc:<issuer>' later.
model Identity {
  id           String   @id @default(uuid()) @db.Uuid
  userId       String   @db.Uuid
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  provider     String
  subject      String
  passwordHash String?
  createdAt    DateTime @default(now())

  @@unique([provider, subject])
}

/// Web refresh sessions (rotating, httpOnly cookie).
model Session {
  id        String    @id @default(uuid()) @db.Uuid
  userId    String    @db.Uuid
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  tokenHash String    @unique
  expiresAt DateTime
  revokedAt DateTime?
  userAgent String?
  createdAt DateTime  @default(now())

  @@index([userId])
}

model SyncDevice {
  id             String    @id @default(uuid()) @db.Uuid
  userId         String    @db.Uuid
  user           User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  name           String
  platform       String
  appVersion     String
  installationId String?
  tokenHash      String    @unique
  createdAt      DateTime  @default(now())
  lastSeenAt     DateTime?
  revokedAt      DateTime?

  @@index([userId])
}

/// Mirror of one file/folder on disk. Paths are relative to the user root, '/'-separated.
model Item {
  id          String    @id @default(uuid()) @db.Uuid
  ownerId     String    @db.Uuid
  owner       User      @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  /// null = direct child of the user root ("root").
  parentId    String?   @db.Uuid
  type        ItemType
  /// Exact on-disk name.
  name        String
  /// NFC + lower-case, for collision checks.
  nameKey     String
  path        String
  size        BigInt    @default(0)
  mtime       DateTime
  ino         BigInt?
  dev         BigInt?
  contentHash String?
  version     Int       @default(1)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  /// Tombstone; kept for tombstoneWindowSec so external moves can be paired.
  deletedAt   DateTime?

  @@index([ownerId, parentId])
  @@index([ownerId, dev, ino])
  @@index([ownerId, path])
}

/// Per-user journal head. seq is incremented inside the mutating transaction
/// (row lock => sequence numbers become visible in commit order, no gaps for readers).
model SyncScope {
  userId String @id @db.Uuid
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  seq    BigInt @default(0)
  /// Watermark: entries with seq <= minSeq were trimmed; older cursors get 410.
  minSeq BigInt @default(0)
}

model FileChange {
  scopeId  String   @db.Uuid
  seq      BigInt
  itemId   String   @db.Uuid
  itemType ItemType
  op       ChangeOp
  at       DateTime @default(now())

  @@id([scopeId, seq])
  @@index([scopeId, itemId])
  @@index([at])
}

model TrashEntry {
  id           String   @id @default(uuid()) @db.Uuid
  ownerId      String   @db.Uuid
  itemId       String   @db.Uuid
  type         ItemType
  name         String
  originalPath String
  size         BigInt
  /// Absolute path below metaRoot/trash.
  storePath    String
  /// [{ id, type, path }] of the subtree, for restore with original IDs (Phase 1b).
  manifest     Json
  deletedAt    DateTime @default(now())

  @@index([ownerId, deletedAt])
}
```
Run: `cd apps/server && DATABASE_URL=postgresql://synclet:synclet@localhost:5434/synclet pnpm prisma migrate dev --name init --create-only`
Then append to the generated `prisma/migrations/<ts>_init/migration.sql`:
```sql
-- Live paths are unique per user; tombstones may share paths.
CREATE UNIQUE INDEX "Item_owner_path_live_key" ON "Item" ("ownerId", "path") WHERE "deletedAt" IS NULL;
```
Run: `DATABASE_URL=postgresql://synclet:synclet@localhost:5434/synclet pnpm prisma migrate dev`
Expected: "Your database is now in sync with your schema."

- [ ] **Step 5: Write failing tests for paths**

`apps/server/src/common/paths.spec.ts`:
```ts
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { absPath, baseName, joinRel, parentRel, realpathInside, userRoot } from './paths';

describe('paths', () => {
  it('joins and splits relative paths', () => {
    expect(joinRel('', 'a')).toBe('a');
    expect(joinRel('a/b', 'c')).toBe('a/b/c');
    expect(parentRel('a/b/c')).toBe('a/b');
    expect(parentRel('a')).toBe('');
    expect(baseName('a/b/c.txt')).toBe('c.txt');
  });

  it('builds absolute paths below the user root', () => {
    expect(absPath('/data', 'alice', '')).toBe(path.join('/data', 'alice'));
    expect(absPath('/data', 'alice', 'x/y.txt')).toBe(path.join('/data', 'alice', 'x', 'y.txt'));
    expect(userRoot('/data', 'alice')).toBe(path.join('/data', 'alice'));
  });

  it('rejects traversal segments', () => {
    expect(() => absPath('/data', 'alice', '../bob')).toThrow();
    expect(() => absPath('/data', 'alice', 'a/../../x')).toThrow();
    expect(() => absPath('/data', 'alice', 'a/./b')).toThrow();
    expect(() => absPath('/data', 'alice', '/etc')).toThrow();
  });

  it('realpathInside rejects symlink escapes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'synclet-paths-'));
    const outside = await mkdtemp(path.join(os.tmpdir(), 'synclet-outside-'));
    await writeFile(path.join(outside, 'secret'), 'x');
    await mkdir(path.join(root, 'ok'));
    await symlink(outside, path.join(root, 'evil'));
    await expect(realpathInside(path.join(root, 'ok'), root)).resolves.toBeTruthy();
    await expect(realpathInside(path.join(root, 'evil', 'secret'), root)).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
});
```
Run: `cd apps/server && pnpm jest src/common/paths.spec.ts`
Expected: FAIL (`Cannot find module './paths'`). (Global setup needs `synclet_test` DB from Step 1.)

- [ ] **Step 6: Implement common files**

`apps/server/src/common/paths.ts`:
```ts
import { realpath } from 'node:fs/promises';
import path from 'node:path';

export function userRoot(dataRoot: string, username: string): string {
  return path.join(dataRoot, username);
}

export function joinRel(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

export function parentRel(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

export function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/** Absolute path of `rel` below the user root. Throws on traversal attempts. */
export function absPath(dataRoot: string, username: string, rel: string): string {
  const root = userRoot(dataRoot, username);
  if (rel === '') return root;
  const segments = rel.split('/');
  if (rel.startsWith('/') || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`unsafe relative path: ${rel}`);
  }
  return path.join(root, ...segments);
}

/** Resolves symlinks and asserts the target stays inside `root`. Returns the real path. */
export async function realpathInside(abs: string, root: string): Promise<string> {
  const [realTarget, realRoot] = await Promise.all([realpath(abs), realpath(root)]);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new Error(`path escapes root: ${abs}`);
  }
  return realTarget;
}
```

`apps/server/src/common/types.ts`:
```ts
export interface IndexUser {
  id: string;
  username: string;
}

export interface AuthUser extends IndexUser {
  role: 'admin' | 'user';
  /** Set when the request was authenticated with a device token. */
  deviceId: string | null;
}
```

`apps/server/src/common/events.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { IndexUser } from './types';

interface AppEventMap {
  'user.created': [IndexUser];
}

@Injectable()
export class AppEvents extends EventEmitter<AppEventMap> {}
```

`apps/server/src/common/sync-error.ts`:
```ts
import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Item } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import type { SyncErrorCode } from '@synclet/shared';

const STATUS: Record<SyncErrorCode, number> = {
  unauthorized: 401, device_revoked: 401, forbidden: 403, not_found: 404, name_conflict: 409,
  invalid_move: 400, invalid_name: 400, invalid_request: 400, cursor_expired: 410, conflict: 412,
  precondition_required: 428, too_large: 413, range_not_satisfiable: 416, setup_done: 409,
};

export class SyncError extends Error {
  readonly status: number;
  constructor(readonly code: SyncErrorCode, message?: string, readonly itemRow?: Item) {
    super(message ?? code);
    this.status = STATUS[code];
  }
}

@Catch(SyncError)
export class SyncErrorFilter implements ExceptionFilter {
  /** Installed by SyncModule so error bodies can carry a serialized SyncItem. */
  static serializeItem?: (row: Item) => Promise<unknown>;

  async catch(err: SyncError, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const body: Record<string, unknown> = { statusCode: err.status, message: err.message, code: err.code };
    if (err.itemRow && SyncErrorFilter.serializeItem) body.item = await SyncErrorFilter.serializeItem(err.itemRow);
    await reply.status(err.status).send(body);
  }
}
```

`apps/server/src/common/zod.pipe.ts`:
```ts
import { PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import { SyncError } from './sync-error';

export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) throw new SyncError('invalid_request', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return r.data;
  }
}
```

`apps/server/src/config.ts`:
```ts
export const APP_CONFIG = Symbol('APP_CONFIG');

export interface AppConfig {
  dataRoot: string;
  metaRoot: string;
  port: number;
  background: boolean;
  watch: boolean;
  scanIntervalSec: number;
  tombstoneWindowSec: number;
  journalRetentionDays: number;
  maxUploadBytes: number;
  publicUrl: string | null;
  secureCookies: boolean;
}

const bool = (v: string | undefined, dflt: boolean) => (v === undefined ? dflt : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()));
const int = (v: string | undefined, dflt: number) => (v === undefined || v === '' ? dflt : Number.parseInt(v, 10));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const publicUrl = env.SYNCLET_PUBLIC_URL || null;
  return {
    dataRoot: env.SYNCLET_DATA_ROOT ?? '/data',
    metaRoot: env.SYNCLET_META_ROOT ?? '/meta',
    port: int(env.PORT, 3000),
    background: bool(env.SYNCLET_BACKGROUND, true),
    watch: bool(env.SYNCLET_WATCH, true),
    scanIntervalSec: int(env.SYNCLET_SCAN_INTERVAL, bool(env.SYNCLET_WATCH, true) ? 900 : 120),
    tombstoneWindowSec: int(env.SYNCLET_TOMBSTONE_WINDOW, 3600),
    journalRetentionDays: int(env.SYNCLET_JOURNAL_RETENTION_DAYS, 30),
    maxUploadBytes: int(env.SYNCLET_MAX_UPLOAD_BYTES, 50 * 1024 ** 3),
    publicUrl,
    secureCookies: bool(env.SYNCLET_SECURE_COOKIES, publicUrl?.startsWith('https://') ?? false),
  };
}
```

`apps/server/src/prisma/prisma.service.ts`:
```ts
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() { await this.$connect(); }
  async onModuleDestroy() { await this.$disconnect(); }
}

export const TX_OPTS = { timeout: 60_000, maxWait: 30_000 } as const;
```
`apps/server/src/prisma/prisma.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

Module stubs – each is exactly this shape (later tasks replace the body):
```ts
// apps/server/src/auth/auth.module.ts
import { Module } from '@nestjs/common';
@Module({})
export class AuthModule {}
```
Same for `JournalModule` (`src/journal/journal.module.ts`), `IndexerModule` (`src/indexer/indexer.module.ts`), `FilesModule` (`src/files/files.module.ts`), `SyncModule` (`src/sync/sync.module.ts`).

`apps/server/src/app.module.ts`:
```ts
import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from './config';
import { AppEvents } from './common/events';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { JournalModule } from './journal/journal.module';
import { IndexerModule } from './indexer/indexer.module';
import { FilesModule } from './files/files.module';
import { SyncModule } from './sync/sync.module';
import { HealthController } from './health.controller';

@Global()
@Module({})
class CoreModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: CoreModule,
      providers: [{ provide: APP_CONFIG, useValue: config }, AppEvents],
      exports: [APP_CONFIG, AppEvents],
    };
  }
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [CoreModule.forRoot(config), PrismaModule, AuthModule, JournalModule, IndexerModule, FilesModule, SyncModule],
      controllers: [HealthController],
    };
  }
}
```
`apps/server/src/health.controller.ts`:
```ts
import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  health() { return { ok: true }; }
}
```

`apps/server/src/bootstrap.ts`:
```ts
import cookie from '@fastify/cookie';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Readable } from 'node:stream';
import { SyncErrorFilter } from './common/sync-error';

export async function configureApp(app: NestFastifyApplication): Promise<void> {
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new SyncErrorFilter());
  await app.register(cookie as never);
  const fastify = app.getHttpAdapter().getInstance();
  // Raw uploads: application/octet-stream bodies are passed through as a stream (never buffered).
  fastify.addContentTypeParser('application/octet-stream', (req, payload: Readable, done) => {
    if (!req.url.startsWith('/api/sync/')) {
      const err = Object.assign(new Error('Unsupported Media Type'), { statusCode: 415 });
      done(err, undefined);
      return;
    }
    done(null, payload);
  });
}
```
`apps/server/src/main.ts`:
```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadConfig } from './config';

async function main() {
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(config),
    new FastifyAdapter({ trustProxy: true, bodyLimit: 10 * 1024 * 1024 }),
  );
  await configureApp(app);
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
}

void main();
```

- [ ] **Step 7: Test harness**

`apps/server/test/env.ts`:
```ts
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://synclet:synclet@localhost:5434/synclet_test';
process.env.SYNCLET_BACKGROUND = 'off';
```
`apps/server/test/global-setup.ts`:
```ts
import { execSync } from 'node:child_process';
import path from 'node:path';

export default async function globalSetup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://synclet:synclet@localhost:5434/synclet_test';
  execSync('pnpm prisma migrate reset --force --skip-seed', {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
```
`apps/server/test/context.ts`:
```ts
import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { mkdir, mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { AppConfig, loadConfig } from '../src/config';
import { PrismaService } from '../src/prisma/prisma.service';
import type { IndexUser } from '../src/common/types';

export interface TestContext {
  app: NestFastifyApplication;
  prisma: PrismaService;
  config: AppConfig;
  close(): Promise<void>;
}

export async function resetDb(prisma: PrismaService) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "FileChange","SyncScope","TrashEntry","Item","SyncDevice","Session","Identity","User","ServerConfig" CASCADE',
  );
}

export async function createTestApp(overrides: Partial<AppConfig> = {}): Promise<TestContext> {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'synclet-data-'));
  const metaRoot = await mkdtemp(path.join(os.tmpdir(), 'synclet-meta-'));
  const config: AppConfig = { ...loadConfig({}), dataRoot, metaRoot, background: false, ...overrides };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const prisma = app.get(PrismaService);
  await resetDb(prisma);
  return {
    app, prisma, config,
    async close() {
      await app.close();
      await rm(dataRoot, { recursive: true, force: true });
      await rm(metaRoot, { recursive: true, force: true });
    },
  };
}

/** Inserts a user directly (no auth module needed) and creates its folder. */
export async function createTestUser(ctx: TestContext, username = 'alice'): Promise<IndexUser> {
  const user = await ctx.prisma.user.create({ data: { username, displayName: username } });
  await ctx.prisma.syncScope.create({ data: { userId: user.id } });
  await mkdir(path.join(ctx.config.dataRoot, username), { recursive: true });
  return { id: user.id, username };
}

let caseSensitive: boolean | undefined;
async function detectCaseSensitive(): Promise<boolean> {
  if (caseSensitive !== undefined) return caseSensitive;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'synclet-case-'));
  await writeFile(path.join(dir, 'a'), '');
  caseSensitive = await stat(path.join(dir, 'A')).then(() => false, () => true);
  await rm(dir, { recursive: true, force: true });
  return caseSensitive;
}

/** Runs the test only on case-sensitive file systems (Linux); skips it on macOS APFS. */
export function itIfCaseSensitive(name: string, fn: () => Promise<void>) {
  it(name, async () => {
    if (!(await detectCaseSensitive())) {
      console.warn(`skipped on case-insensitive FS: ${name}`);
      return;
    }
    await fn();
  });
}
```
`apps/server/test/health.spec.ts`:
```ts
import { createTestApp, TestContext } from './context';

describe('health', () => {
  let ctx: TestContext;
  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { await ctx.close(); });

  it('GET /api/health', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 8: Run all server tests**

Run: `cd apps/server && pnpm prisma generate && pnpm test`
Expected: PASS (paths.spec.ts 4 tests, health.spec.ts 1 test). Also `pnpm typecheck` and `pnpm build` succeed.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold monorepo, server skeleton, prisma schema and test harness

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Name rules and display names

**Files:**
- Create: `apps/server/src/common/names.ts`
- Test: `apps/server/src/common/names.spec.ts`

**Interfaces:**
- Produces:
  - `nameKey(name: string): string` – NFC + lower-case
  - `type NameError = 'empty' | 'forbidden_char' | 'trailing' | 'reserved' | 'too_long' | 'ignored'`
  - `validateName(name: string): NameError | null`
  - `isIgnored(name: string): boolean` (includes temp names)
  - `TEMP_PREFIX = '.synclet-tmp-'`, `tempName(id: string): string`, `isTempName(name: string): boolean`
  - `splitExt(name: string): { base: string; ext: string }` (ext includes the dot or is `''`)
  - `withSuffix(name: string, n: number, isFolder: boolean): string`
  - `freeName(desired: string, takenKeys: Set<string>, isFolder: boolean): string`
  - `interface NameSibling { id: string; name: string; type: 'folder' | 'file'; createdAt: Date }`
  - `assignDisplayNames(siblings: NameSibling[]): Map<string, string>`

- [ ] **Step 1: Write the failing tests**

`apps/server/src/common/names.spec.ts`:
```ts
import {
  assignDisplayNames, freeName, isIgnored, isTempName, nameKey, splitExt, tempName, validateName, withSuffix,
} from './names';

const d = (s: number) => new Date(2026, 0, 1, 0, 0, s);

describe('names', () => {
  it('nameKey folds case and unicode normalization', () => {
    expect(nameKey('Äpfel.TXT')).toBe(nameKey('äpfel.txt'.replace('ä', 'Ä')));
    expect(nameKey('Report.PDF')).toBe('report.pdf');
  });

  it.each([
    ['', 'empty'], ['.', 'empty'], ['..', 'empty'],
    ['a/b', 'forbidden_char'], ['a\\b', 'forbidden_char'], ['a:b', 'forbidden_char'], ['a*b', 'forbidden_char'],
    ['a?b', 'forbidden_char'], ['a"b', 'forbidden_char'], ['a<b', 'forbidden_char'], ['a|b', 'forbidden_char'],
    ['tab\tname', 'forbidden_char'],
    ['name.', 'trailing'], ['name ', 'trailing'],
    ['CON', 'reserved'], ['con.txt', 'reserved'], ['LPT1', 'reserved'], ['com9.log', 'reserved'],
    ['x'.repeat(256), 'too_long'], ['ü'.repeat(128), 'too_long'],
    ['.DS_Store', 'ignored'], ['Thumbs.db', 'ignored'], ['~$doc.docx', 'ignored'], ['.synclet-tmp-abc', 'ignored'],
  ])('validateName(%j) = %s', (name, err) => {
    expect(validateName(name)).toBe(err);
  });

  it.each(['Report 2026.pdf', '.env', 'Ünïcödé 🚀.txt', 'console.log', 'a'.repeat(255), '.hidden'])('accepts %j', (name) => {
    expect(validateName(name)).toBeNull();
  });

  it('ignores OS junk and temp files', () => {
    for (const n of ['.DS_Store', '._foo', '.Spotlight-V100', '.Trashes', '.fseventsd', 'Thumbs.db', 'desktop.ini',
      '$RECYCLE.BIN', '~$x.docx', '~WRL0001.tmp', '.~lock.x.odt#', '@eaDir', '#recycle', 'lost+found', '.synclet-tmp-1a2b']) {
      expect(isIgnored(n)).toBe(true);
    }
    expect(isIgnored('notes.txt')).toBe(false);
    expect(isTempName(tempName('k3j4'))).toBe(true);
  });

  it('splits extensions at the last dot, not at position 0', () => {
    expect(splitExt('a.tar.gz')).toEqual({ base: 'a.tar', ext: '.gz' });
    expect(splitExt('.env')).toEqual({ base: '.env', ext: '' });
    expect(splitExt('README')).toEqual({ base: 'README', ext: '' });
  });

  it('adds suffixes before the extension (files) or at the end (folders)', () => {
    expect(withSuffix('a.txt', 2, false)).toBe('a (2).txt');
    expect(withSuffix('v1.2', 3, true)).toBe('v1.2 (3)');
  });

  it('freeName returns the first free variant', () => {
    expect(freeName('a.txt', new Set(['a.txt', 'a (2).txt']), false)).toBe('a (3).txt');
    expect(freeName('new', new Set(), true)).toBe('new');
  });

  it('assignDisplayNames: folders first, older first, genuine names before suffixes', () => {
    const map = assignDisplayNames([
      { id: 'f3', name: 'a (2).txt', type: 'file', createdAt: d(3) },
      { id: 'f2', name: 'A.txt', type: 'file', createdAt: d(2) },
      { id: 'f1', name: 'a.txt', type: 'file', createdAt: d(1) },
      { id: 'd1', name: 'A.TXT', type: 'folder', createdAt: d(9) },
    ]);
    expect(map.get('d1')).toBe('A.TXT');
    expect(map.get('f3')).toBe('a (2).txt');
    expect(map.get('f1')).toBe('a (3).txt');
    expect(map.get('f2')).toBe('A (4).txt');
  });

  it('assignDisplayNames is independent of input order', () => {
    const sibs = [
      { id: 'x', name: 'Doc.md', type: 'file' as const, createdAt: d(1) },
      { id: 'y', name: 'doc.md', type: 'file' as const, createdAt: d(1) },
    ];
    expect([...assignDisplayNames(sibs)]).toEqual([...assignDisplayNames([...sibs].reverse())].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  });
});
```
Run: `cd apps/server && pnpm jest src/common/names.spec.ts`
Expected: FAIL (module not found).

- [ ] **Step 2: Implement**

`apps/server/src/common/names.ts`:
```ts
// Name rules shared by API writes, the indexer and the serializer.
// Display names follow Buro SYNC_API §4: unique per parent, case-insensitive, NFC.

const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const IGNORED_EXACT = new Set([
  '.DS_Store', '.Spotlight-V100', '.Trashes', '.fseventsd', '.TemporaryItems', '.localized',
  'Thumbs.db', 'desktop.ini', '$RECYCLE.BIN', '@eaDir', '#recycle', 'lost+found',
]);
export const TEMP_PREFIX = '.synclet-tmp-';
const IGNORED_PATTERNS = [/^\._/, /^~\$/, /^~WRL.*\.tmp$/i, /^\.~lock\..*#$/, /^\.synclet-tmp-[A-Za-z0-9]+$/];

export type NameError = 'empty' | 'forbidden_char' | 'trailing' | 'reserved' | 'too_long' | 'ignored';

export function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

export function isIgnored(name: string): boolean {
  return IGNORED_EXACT.has(name) || IGNORED_PATTERNS.some((p) => p.test(name));
}

export function tempName(id: string): string {
  return `${TEMP_PREFIX}${id}`;
}

export function isTempName(name: string): boolean {
  return /^\.synclet-tmp-[A-Za-z0-9]+$/.test(name);
}

export function validateName(name: string): NameError | null {
  if (name.length === 0 || name === '.' || name === '..') return 'empty';
  if (FORBIDDEN.test(name)) return 'forbidden_char';
  if (/[ .]$/.test(name)) return 'trailing';
  if (RESERVED.test(name)) return 'reserved';
  if (Buffer.byteLength(name.normalize('NFC'), 'utf8') > 255) return 'too_long';
  if (isIgnored(name)) return 'ignored';
  return null;
}

export function splitExt(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf('.');
  if (i <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i) };
}

export function withSuffix(name: string, n: number, isFolder: boolean): string {
  if (isFolder) return `${name} (${n})`;
  const { base, ext } = splitExt(name);
  return `${base} (${n})${ext}`;
}

export function freeName(desired: string, takenKeys: Set<string>, isFolder: boolean): string {
  if (!takenKeys.has(nameKey(desired))) return desired;
  for (let n = 2; ; n++) {
    const candidate = withSuffix(desired, n, isFolder);
    if (!takenKeys.has(nameKey(candidate))) return candidate;
  }
}

export interface NameSibling {
  id: string;
  name: string;
  type: 'folder' | 'file';
  createdAt: Date;
}

/** Deterministic, collision-free display names for all children of one parent. */
export function assignDisplayNames(siblings: NameSibling[]): Map<string, string> {
  const ranked = [...siblings].sort(
    (a, b) =>
      (a.type === b.type ? 0 : a.type === 'folder' ? -1 : 1) ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const taken = new Set<string>();
  const result = new Map<string, string>();
  const deferred: NameSibling[] = [];
  for (const s of ranked) {
    const k = nameKey(s.name);
    if (taken.has(k)) deferred.push(s);
    else { taken.add(k); result.set(s.id, s.name); }
  }
  for (const s of deferred) {
    const name = freeName(s.name, taken, s.type === 'folder');
    taken.add(nameKey(name));
    result.set(s.id, name);
  }
  return result;
}
```

- [ ] **Step 3: Run tests**

Run: `cd apps/server && pnpm jest src/common/names.spec.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/common/names.ts apps/server/src/common/names.spec.ts
git commit -m "feat(server): name validation, ignore rules and display names

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Auth – setup, login, sessions, users, device tokens, guard

**Files:**
- Create: `apps/server/src/auth/{crypto.ts,server-config.service.ts,users.service.ts,auth.service.ts,devices.service.ts,auth.guard.ts,current-user.decorator.ts,setup.controller.ts,auth.controller.ts,admin-users.controller.ts}`
- Modify: `apps/server/src/auth/auth.module.ts` (replace stub)
- Test: `apps/server/src/auth/auth.spec.ts`, `apps/server/src/auth/devices.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `APP_CONFIG`, `AppEvents`, `SyncError`, `ZodPipe` (Task 1), `validateName` (Task 2, already on `main` when this task starts).
- Produces:
  - `ServerConfigService.get(): Promise<{ serverId: string; jwtSecret: string }>` (creates singleton row on first call)
  - `UsersService.create(input: { username: string; displayName: string; email?: string | null; password: string; role: 'admin' | 'user' }): Promise<User>` – mkdirs the user root (adopts if it exists), creates `SyncScope`, local `Identity`, emits `'user.created'`
  - `UsersService.toPublic(user: User): PublicUser`
  - `AuthService.login(login: string, password: string, userAgent?: string): Promise<{ access: AuthResponse; refreshToken: string }>`, `refresh(raw: string, ua?: string)`, `logout(raw: string)`, `signDownloadToken(userId: string, itemId: string): Promise<string>`
  - `DevicesService.register(user: AuthUser, input: { name; platform; appVersion; installationId? }): Promise<{ device: SyncDevice row; token: string }>`, `list(userId)`, `revoke(userId, deviceId)`, `toWire(row, currentId?)`
  - `AuthGuard` (Nest guard): accepts `Authorization: Bearer <jwt|syd_…>`; on routes decorated `@AllowDownloadToken()` also `?dt=<jwt>` whose `item` claim equals `params.id`. Sets `request.user: AuthUser`.
  - `@CurrentUser()` param decorator, `@AdminOnly()` decorator (guard checks role), `@AllowDownloadToken()`
  - Routes: `GET /api/setup/status`, `POST /api/setup`, `POST /api/auth/login`, `POST /api/auth/refresh`, `POST /api/auth/logout`, `GET /api/auth/me`, `GET|POST /api/admin/users`, `PATCH /api/admin/users/:id`
  - `REFRESH_COOKIE = 'synclet_refresh'` (path `/api/auth`, httpOnly, SameSite=Strict, Secure if `config.secureCookies`, 30 days)
  - `AuthModule` exports `AuthGuard, AuthService, DevicesService, UsersService, ServerConfigService`

- [ ] **Step 1: Write failing tests**

`apps/server/src/auth/auth.spec.ts`:
```ts
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, TestContext } from '../../test/context';

describe('auth', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.close(); });

  const setup = (body: object = {}) =>
    ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery', ...body } });

  it('reports needsSetup until the first admin exists', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({ needsSetup: true });
    const res = await setup();
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ username: 'jens', role: 'admin' });
    expect(res.cookies.find((c) => c.name === 'synclet_refresh')).toBeTruthy();
    expect((await ctx.app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({ needsSetup: false });
    expect((await setup({ username: 'other' })).json().code).toBe('setup_done');
  });

  it('creates (or adopts) the user folder', async () => {
    await setup();
    expect((await stat(path.join(ctx.config.dataRoot, 'jens'))).isDirectory()).toBe(true);
  });

  it('rejects unsafe usernames', async () => {
    for (const username of ['../x', '.hidden', 'a/b', 'CON', '']) {
      expect((await setup({ username })).statusCode).toBe(400);
    }
  });

  it('logs in by username or email, refreshes with rotation and detects reuse', async () => {
    await setup({ email: 'jens@example.com' });
    const bad = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'jens', password: 'nope' } });
    expect(bad.statusCode).toBe(401);
    const ok = await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'JENS@example.com', password: 'correct horse battery' } });
    expect(ok.statusCode).toBe(200);
    const rt1 = ok.cookies.find((c) => c.name === 'synclet_refresh')!.value;

    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${ok.json().accessToken}` } });
    expect(me.json()).toMatchObject({ username: 'jens' });

    const r2 = await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { synclet_refresh: rt1 } });
    expect(r2.statusCode).toBe(200);
    const rt2 = r2.cookies.find((c) => c.name === 'synclet_refresh')!.value;
    expect(rt2).not.toBe(rt1);

    // Reusing the rotated token revokes every session of the user.
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { synclet_refresh: rt1 } })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { synclet_refresh: rt2 } })).statusCode).toBe(401);
  });

  it('rejects missing/invalid bearer tokens with code unauthorized', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: 'Bearer garbage' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('unauthorized');
  });

  it('admin creates users; non-admins cannot', async () => {
    const admin = (await setup()).json().accessToken;
    const created = await ctx.app.inject({
      method: 'POST', url: '/api/admin/users', headers: { authorization: `Bearer ${admin}` },
      payload: { username: 'anna', displayName: 'Anna', password: 'another long password' },
    });
    expect(created.statusCode).toBe(201);
    const anna = (await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'anna', password: 'another long password' } })).json().accessToken;
    const denied = await ctx.app.inject({ method: 'GET', url: '/api/admin/users', headers: { authorization: `Bearer ${anna}` } });
    expect(denied.statusCode).toBe(403);
  });

  it('disabled users can no longer authenticate', async () => {
    const admin = (await setup()).json().accessToken;
    const anna = (await ctx.app.inject({
      method: 'POST', url: '/api/admin/users', headers: { authorization: `Bearer ${admin}` },
      payload: { username: 'anna', displayName: 'Anna', password: 'another long password' },
    })).json();
    const token = (await ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'anna', password: 'another long password' } })).json().accessToken;
    await ctx.app.inject({ method: 'PATCH', url: `/api/admin/users/${anna.id}`, headers: { authorization: `Bearer ${admin}` }, payload: { disabled: true } });
    expect((await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
  });
});
```

`apps/server/src/auth/devices.spec.ts`:
```ts
import { createTestApp, TestContext } from '../../test/context';
import { DevicesService } from './devices.service';
import { AuthGuard } from './auth.guard';

describe('devices', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.close(); });

  async function adminUser() {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
    const u = res.json().user;
    return { id: u.id, username: u.username, role: 'admin' as const, deviceId: null };
  }

  it('issues syd_ tokens once, stores only a hash, and dedupes by installationId', async () => {
    const svc = ctx.app.get(DevicesService);
    const user = await adminUser();
    const a = await svc.register(user, { name: 'Mac', platform: 'macos', appVersion: '1.0', installationId: 'abc' });
    expect(a.token).toMatch(/^syd_[A-Za-z0-9_-]{43}$/);
    const row = await ctx.prisma.syncDevice.findUniqueOrThrow({ where: { id: a.device.id } });
    expect(row.tokenHash).not.toContain(a.token);
    const b = await svc.register(user, { name: 'Mac', platform: 'macos', appVersion: '1.1', installationId: 'abc' });
    const list = await svc.list(user.id);
    expect(list.map((d) => d.id)).toEqual([b.device.id]);
  });

  it('device tokens authenticate; revoked ones get device_revoked', async () => {
    const svc = ctx.app.get(DevicesService);
    const user = await adminUser();
    const { device, token } = await svc.register(user, { name: 'PC', platform: 'windows', appVersion: '1.0' });
    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    await svc.revoke(user.id, device.id);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('device_revoked');
    expect(ctx.app.get(AuthGuard)).toBeDefined();
  });
});
```
Run: `cd apps/server && pnpm jest src/auth`
Expected: FAIL (modules missing).

- [ ] **Step 2: Implement crypto + server config + users**

`apps/server/src/auth/crypto.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';

export function randomToken(prefix: string): string {
  return prefix + randomBytes(32).toString('base64url'); // 43 chars
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
```

`apps/server/src/auth/server-config.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ServerConfigService {
  private cached?: { serverId: string; jwtSecret: string };
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<{ serverId: string; jwtSecret: string }> {
    if (this.cached) return this.cached;
    const row = await this.prisma.serverConfig.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, serverId: randomUUID(), jwtSecret: randomBytes(48).toString('base64url') },
    });
    this.cached = { serverId: row.serverId, jwtSecret: row.jwtSecret };
    return this.cached;
  }
}
```

`apps/server/src/auth/users.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { PublicUser } from '@synclet/shared';
import * as argon2 from 'argon2';
import { mkdir } from 'node:fs/promises';
import { APP_CONFIG, AppConfig } from '../config';
import { AppEvents } from '../common/events';
import { validateName } from '../common/names';
import { userRoot } from '../common/paths';
import { SyncError } from '../common/sync-error';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateUserInput {
  username: string;
  displayName: string;
  email?: string | null;
  password: string;
  role: 'admin' | 'user';
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: AppEvents,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Username = folder name below the data root; must be a safe, visible folder name. */
  validateUsername(username: string): void {
    if (validateName(username) !== null || username.startsWith('.') || username !== username.normalize('NFC')) {
      throw new SyncError('invalid_request', 'invalid username');
    }
  }

  async create(input: CreateUserInput): Promise<User> {
    this.validateUsername(input.username);
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
    const user = await this.prisma.$transaction(async (tx) => {
      const exists = await tx.user.findFirst({
        where: { OR: [{ username: { equals: input.username, mode: 'insensitive' } }, ...(input.email ? [{ email: input.email.toLowerCase() }] : [])] },
      });
      if (exists) throw new SyncError('name_conflict', 'username or email already in use');
      const created = await tx.user.create({
        data: { username: input.username, displayName: input.displayName, email: input.email?.toLowerCase() ?? null, role: input.role },
      });
      await tx.identity.create({ data: { userId: created.id, provider: 'local', subject: input.username.toLowerCase(), passwordHash } });
      await tx.syncScope.create({ data: { userId: created.id } });
      return created;
    });
    await mkdir(userRoot(this.config.dataRoot, user.username), { recursive: true }); // adopts an existing folder
    this.events.emit('user.created', { id: user.id, username: user.username });
    return user;
  }

  toPublic(u: User): PublicUser {
    return { id: u.id, username: u.username, displayName: u.displayName, email: u.email, role: u.role };
  }
}
```

- [ ] **Step 3: Implement AuthService + DevicesService**

`apps/server/src/auth/auth.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@prisma/client';
import type { AuthResponse } from '@synclet/shared';
import * as argon2 from 'argon2';
import { APP_CONFIG, AppConfig } from '../config';
import { SyncError } from '../common/sync-error';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken, randomToken } from './crypto';
import { ServerConfigService } from './server-config.service';
import { UsersService } from './users.service';

export const REFRESH_COOKIE = 'synclet_refresh';
export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const ACCESS_TTL = '15m';

export interface AccessClaims { sub: string; username: string; role: 'admin' | 'user'; typ: 'access' }
export interface DownloadClaims { sub: string; item: string; typ: 'dl' }

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly serverConfig: ServerConfigService,
    private readonly users: UsersService,
    @Inject(APP_CONFIG) readonly config: AppConfig,
  ) {}

  private async secret() { return (await this.serverConfig.get()).jwtSecret; }

  async signAccess(u: User): Promise<string> {
    const claims: AccessClaims = { sub: u.id, username: u.username, role: u.role, typ: 'access' };
    return this.jwt.signAsync(claims, { secret: await this.secret(), expiresIn: ACCESS_TTL });
  }

  async verify<T extends { typ: string }>(token: string, typ: T['typ']): Promise<T | null> {
    try {
      const claims = await this.jwt.verifyAsync<T>(token, { secret: await this.secret() });
      return claims.typ === typ ? claims : null;
    } catch {
      return null;
    }
  }

  async signDownloadToken(userId: string, itemId: string): Promise<string> {
    const claims: DownloadClaims = { sub: userId, item: itemId, typ: 'dl' };
    return this.jwt.signAsync(claims, { secret: await this.secret(), expiresIn: '60s' });
  }

  async issue(u: User, userAgent?: string): Promise<{ access: AuthResponse; refreshToken: string }> {
    const refreshToken = randomToken('syr_');
    await this.prisma.session.create({
      data: { userId: u.id, tokenHash: hashToken(refreshToken), expiresAt: new Date(Date.now() + REFRESH_TTL_MS), userAgent },
    });
    return { access: { accessToken: await this.signAccess(u), user: this.users.toPublic(u) }, refreshToken };
  }

  async login(login: string, password: string, userAgent?: string) {
    const key = login.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { disabledAt: null, OR: [{ email: key }, { username: { equals: login.trim(), mode: 'insensitive' } }] },
      include: { identities: { where: { provider: 'local' } } },
    });
    const hash = user?.identities[0]?.passwordHash;
    if (!user || !hash || !(await argon2.verify(hash, password))) throw new SyncError('unauthorized', 'invalid credentials');
    return this.issue(user, userAgent);
  }

  async refresh(raw: string | undefined, userAgent?: string) {
    if (!raw) throw new SyncError('unauthorized');
    const session = await this.prisma.session.findUnique({ where: { tokenHash: hashToken(raw) }, include: { user: true } });
    if (!session) throw new SyncError('unauthorized');
    if (session.revokedAt) {
      // Reuse of a rotated token: assume theft, kill all sessions of this user.
      await this.prisma.session.updateMany({ where: { userId: session.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new SyncError('unauthorized', 'refresh token reuse detected');
    }
    if (session.expiresAt < new Date() || session.user.disabledAt) throw new SyncError('unauthorized');
    await this.prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    return this.issue(session.user, userAgent);
  }

  async logout(raw: string | undefined) {
    if (!raw) return;
    await this.prisma.session.updateMany({ where: { tokenHash: hashToken(raw), revokedAt: null }, data: { revokedAt: new Date() } });
  }
}
```

`apps/server/src/auth/devices.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { SyncDevice as DeviceRow } from '@prisma/client';
import type { SyncDevice } from '@synclet/shared';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { hashToken, randomToken } from './crypto';

export interface RegisterDeviceInput {
  name: string;
  platform: SyncDevice['platform'];
  appVersion: string;
  installationId?: string;
}

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  async register(user: AuthUser, input: RegisterDeviceInput): Promise<{ device: DeviceRow; token: string }> {
    const token = randomToken('syd_');
    const device = await this.prisma.$transaction(async (tx) => {
      // Re-registration of the same installation revokes the old device instead of piling up entries.
      await tx.syncDevice.updateMany({
        where: {
          userId: user.id, platform: input.platform, revokedAt: null,
          ...(input.installationId ? { installationId: input.installationId } : { installationId: null, name: input.name }),
        },
        data: { revokedAt: new Date() },
      });
      return tx.syncDevice.create({
        data: { userId: user.id, name: input.name, platform: input.platform, appVersion: input.appVersion, installationId: input.installationId ?? null, tokenHash: hashToken(token) },
      });
    });
    return { device, token };
  }

  list(userId: string): Promise<DeviceRow[]> {
    return this.prisma.syncDevice.findMany({ where: { userId, revokedAt: null }, orderBy: { createdAt: 'asc' } });
  }

  async revoke(userId: string, deviceId: string): Promise<void> {
    const res = await this.prisma.syncDevice.updateMany({ where: { id: deviceId, userId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (res.count === 0) throw new SyncError('not_found');
  }

  /** Returns the device for a raw token, or 'revoked'/null. Touches lastSeenAt at most once per minute. */
  async authenticate(token: string): Promise<DeviceRow | 'revoked' | null> {
    const row = await this.prisma.syncDevice.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!row) return null;
    if (row.revokedAt) return 'revoked';
    if (!row.lastSeenAt || Date.now() - row.lastSeenAt.getTime() > 60_000) {
      await this.prisma.syncDevice.update({ where: { id: row.id }, data: { lastSeenAt: new Date() } });
    }
    return row;
  }

  toWire(row: DeviceRow, currentId?: string | null): SyncDevice {
    return {
      id: row.id, name: row.name, platform: row.platform as SyncDevice['platform'], appVersion: row.appVersion,
      createdAt: row.createdAt.toISOString(), lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      ...(currentId !== undefined ? { current: row.id === currentId } : {}),
    };
  }
}
```

- [ ] **Step 4: Guard, decorators, controllers, module**

`apps/server/src/auth/current-user.decorator.ts`:
```ts
import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthUser } from '../common/types';

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);
export const ADMIN_ONLY = 'synclet:adminOnly';
export const AdminOnly = () => SetMetadata(ADMIN_ONLY, true);
export const ALLOW_DT = 'synclet:allowDownloadToken';
/** Route also accepts `?dt=<download token>` bound to `params.id`. */
export const AllowDownloadToken = () => SetMetadata(ALLOW_DT, true);
```

`apps/server/src/auth/auth.guard.ts`:
```ts
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { AccessClaims, AuthService, DownloadClaims } from './auth.service';
import { ADMIN_ONLY, ALLOW_DT } from './current-user.decorator';
import { DevicesService } from './devices.service';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly devices: DevicesService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const user = await this.resolve(req, this.reflector.get<boolean>(ALLOW_DT, ctx.getHandler()) === true);
    if (this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY, [ctx.getHandler(), ctx.getClass()]) && user.role !== 'admin') {
      throw new SyncError('forbidden');
    }
    req.user = user;
    return true;
  }

  private async resolve(req: { headers: Record<string, string | undefined>; query?: Record<string, string>; params?: Record<string, string> }, allowDt: boolean): Promise<AuthUser> {
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (bearer.startsWith('syd_')) {
      const device = await this.devices.authenticate(bearer);
      if (device === 'revoked') throw new SyncError('device_revoked');
      if (!device) throw new SyncError('unauthorized');
      return this.loadUser(device.userId, device.id);
    }
    if (bearer) {
      const claims = await this.auth.verify<AccessClaims>(bearer, 'access');
      if (!claims) throw new SyncError('unauthorized');
      return this.loadUser(claims.sub, null);
    }
    const dt = req.query?.dt;
    if (allowDt && dt) {
      const claims = await this.auth.verify<DownloadClaims>(dt, 'dl');
      if (!claims || claims.item !== req.params?.id) throw new SyncError('unauthorized');
      return this.loadUser(claims.sub, null);
    }
    throw new SyncError('unauthorized');
  }

  private async loadUser(id: string, deviceId: string | null): Promise<AuthUser> {
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u || u.disabledAt) throw new SyncError('unauthorized');
    return { id: u.id, username: u.username, role: u.role, deviceId };
  }
}
```

`apps/server/src/auth/setup.controller.ts`:
```ts
import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SyncError } from '../common/sync-error';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { setRefreshCookie } from './auth.controller';
import { UsersService } from './users.service';

const SetupBody = z.object({
  username: z.string(),
  displayName: z.string().min(1).max(100),
  email: z.string().email().nullish(),
  password: z.string().min(10).max(200),
});

@Controller('setup')
export class SetupController {
  constructor(private readonly prisma: PrismaService, private readonly users: UsersService, private readonly auth: AuthService) {}

  @Get('status')
  async status() {
    return { needsSetup: (await this.prisma.user.count()) === 0 };
  }

  @Post()
  @HttpCode(201)
  async setup(@Body(new ZodPipe(SetupBody)) body: z.infer<typeof SetupBody>, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    if ((await this.prisma.user.count()) > 0) throw new SyncError('setup_done', 'setup already completed');
    const user = await this.users.create({ ...body, role: 'admin' });
    const { access, refreshToken } = await this.auth.issue(user, req.headers['user-agent']);
    setRefreshCookie(reply, refreshToken, this.auth.config.secureCookies);
    return access;
  }
}
```
(Race of two concurrent setups is acceptable: the second fails on the unique username or creates a second admin – document in README; single-operator first start.)

`apps/server/src/auth/auth.controller.ts`:
```ts
import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard } from './auth.guard';
import { AuthService, REFRESH_COOKIE, REFRESH_TTL_MS } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { UsersService } from './users.service';

export function setRefreshCookie(reply: FastifyReply, token: string, secure: boolean) {
  reply.setCookie(REFRESH_COOKIE, token, { path: '/api/auth', httpOnly: true, sameSite: 'strict', secure, maxAge: REFRESH_TTL_MS / 1000 });
}

const LoginBody = z.object({ login: z.string().min(1), password: z.string().min(1) });

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly prisma: PrismaService, private readonly users: UsersService) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(LoginBody)) body: z.infer<typeof LoginBody>, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const { access, refreshToken } = await this.auth.login(body.login, body.password, req.headers['user-agent']);
    setRefreshCookie(reply, refreshToken, this.auth.config.secureCookies);
    return access;
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const { access, refreshToken } = await this.auth.refresh(req.cookies[REFRESH_COOKIE], req.headers['user-agent']);
    setRefreshCookie(reply, refreshToken, this.auth.config.secureCookies);
    return access;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(req.cookies[REFRESH_COOKIE]);
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@CurrentUser() user: AuthUser) {
    return this.users.toPublic(await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } }));
  }
}
```

`apps/server/src/auth/admin-users.controller.ts`:
```ts
import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import * as argon2 from 'argon2';
import { z } from 'zod';
import { SyncError } from '../common/sync-error';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard } from './auth.guard';
import { AdminOnly } from './current-user.decorator';
import { UsersService } from './users.service';

const CreateBody = z.object({
  username: z.string(), displayName: z.string().min(1).max(100), email: z.string().email().nullish(),
  password: z.string().min(10).max(200), role: z.enum(['admin', 'user']).default('user'),
});
const PatchBody = z.object({ disabled: z.boolean().optional(), password: z.string().min(10).max(200).optional(), displayName: z.string().min(1).max(100).optional() });

@Controller('admin/users')
@UseGuards(AuthGuard)
@AdminOnly()
export class AdminUsersController {
  constructor(private readonly prisma: PrismaService, private readonly users: UsersService) {}

  @Get()
  async list() {
    return (await this.prisma.user.findMany({ orderBy: { createdAt: 'asc' } })).map((u) => ({ ...this.users.toPublic(u), disabled: u.disabledAt !== null }));
  }

  @Post()
  @HttpCode(201)
  async create(@Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.users.toPublic(await this.users.create(body));
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body(new ZodPipe(PatchBody)) body: z.infer<typeof PatchBody>) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new SyncError('not_found');
    if (body.password) {
      const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
      await this.prisma.identity.updateMany({ where: { userId: id, provider: 'local' }, data: { passwordHash } });
    }
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.disabled !== undefined ? { disabledAt: body.disabled ? new Date() : null } : {}),
      },
    });
    if (body.disabled) {
      await this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    return { ...this.users.toPublic(updated), disabled: updated.disabledAt !== null };
  }
}
```

`apps/server/src/auth/auth.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AdminUsersController } from './admin-users.controller';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { DevicesService } from './devices.service';
import { ServerConfigService } from './server-config.service';
import { SetupController } from './setup.controller';
import { UsersService } from './users.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [SetupController, AuthController, AdminUsersController],
  providers: [AuthGuard, AuthService, DevicesService, ServerConfigService, UsersService],
  exports: [AuthGuard, AuthService, DevicesService, ServerConfigService, UsersService],
})
export class AuthModule {}
```

- [ ] **Step 5: Run tests**

Run: `cd apps/server && pnpm jest src/auth && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/auth
git commit -m "feat(server): setup wizard, login with rotating refresh sessions, users and device tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Journal, ItemStore, BusyPaths

**Files:**
- Create: `apps/server/src/journal/{journal.service.ts,item-store.ts,busy-paths.ts}`
- Modify: `apps/server/src/journal/journal.module.ts` (replace stub)
- Test: `apps/server/src/journal/journal.spec.ts`, `apps/server/src/journal/item-store.spec.ts`, `apps/server/src/journal/busy-paths.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `SyncError`, `createTestApp`, `createTestUser`
- Produces:
  - `type Tx = Prisma.TransactionClient`; `interface ItemRef { id: string; type: ItemType }`
  - `JournalService.lockUser(tx: Tx, userId: string): Promise<void>`
  - `JournalService.record(tx: Tx, userId: string, refs: ItemRef[], op: 'upsert' | 'delete'): Promise<void>` (dedupes by id, one seq per item)
  - `JournalService.currentCursor(userId: string): Promise<string>`
  - `JournalService.changesSince(userId: string, cursor: string, limit: number): Promise<{ entries: { itemId: string; itemType: ItemType; seq: bigint }[]; cursor: string; hasMore: boolean }>` – throws `SyncError('cursor_expired')` / `SyncError('invalid_request')`
  - `JournalService.trim(userId: string, before: Date): Promise<number>`
  - `ItemStore.liveChildren(tx, ownerId, parentId: string | null): Promise<Item[]>`
  - `ItemStore.getLive(tx, ownerId, id): Promise<Item | null>`
  - `ItemStore.findLiveByPath(tx, ownerId, path): Promise<Item | null>`
  - `ItemStore.liveDescendants(tx, ownerId, path): Promise<Item[]>`
  - `ItemStore.rewritePrefix(tx, ownerId, oldPath, newPath): Promise<void>` (live descendants only)
  - `ItemStore.tombstoneSubtree(tx, item: Item): Promise<Item[]>` (item + live descendants, returns them)
  - `ItemStore.sameKeySiblings(tx, ownerId, parentId: string | null, keys: string[], excludeIds: Set<string>): Promise<Item[]>`
  - `ItemStore.purgeTombstones(olderThan: Date): Promise<number>`
  - `BusyPaths.add(userId, rel): () => void` (returns release fn), `BusyPaths.covers(userId, rel): boolean`
  - `JournalModule` exports `JournalService, ItemStore, BusyPaths` and is `@Global()`

- [ ] **Step 1: Write failing tests**

`apps/server/src/journal/journal.spec.ts`:
```ts
import { createTestApp, createTestUser, TestContext } from '../../test/context';
import { IndexUser } from '../common/types';
import { TX_OPTS } from '../prisma/prisma.service';
import { JournalService } from './journal.service';

describe('JournalService', () => {
  let ctx: TestContext; let journal: JournalService; let user: IndexUser;
  beforeEach(async () => {
    ctx = await createTestApp();
    journal = ctx.app.get(JournalService);
    user = await createTestUser(ctx);
  });
  afterEach(async () => { await ctx.close(); });

  const ref = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, type: 'file' as const });
  const rec = (refs: ReturnType<typeof ref>[], op: 'upsert' | 'delete' = 'upsert') =>
    ctx.prisma.$transaction(async (tx) => { await journal.lockUser(tx, user.id); await journal.record(tx, user.id, refs, op); }, TX_OPTS);

  it('starts at cursor 0 and advances one seq per distinct item', async () => {
    expect(await journal.currentCursor(user.id)).toBe('0');
    await rec([ref(1), ref(2), ref(1)]);
    expect(await journal.currentCursor(user.id)).toBe('2');
  });

  it('collapses multiple changes per item and pages by max seq', async () => {
    await rec([ref(1)]); await rec([ref(2)]); await rec([ref(1)], 'delete'); await rec([ref(3)]);
    const p1 = await journal.changesSince(user.id, '0', 2);
    expect(p1.entries.map((e) => e.itemId)).toEqual([ref(2).id, ref(1).id]);
    expect(p1.hasMore).toBe(true);
    const p2 = await journal.changesSince(user.id, p1.cursor, 2);
    expect(p2.entries.map((e) => e.itemId)).toEqual([ref(3).id]);
    expect(p2.hasMore).toBe(false);
    expect(p2.cursor).toBe('4');
    const p3 = await journal.changesSince(user.id, p2.cursor, 2);
    expect(p3.entries).toEqual([]);
    expect(p3.cursor).toBe('4');
  });

  it('rejects malformed, future and trimmed cursors', async () => {
    await rec([ref(1)]); await rec([ref(2)]);
    await expect(journal.changesSince(user.id, 'abc', 10)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(journal.changesSince(user.id, '99', 10)).rejects.toMatchObject({ code: 'cursor_expired' });
    await journal.trim(user.id, new Date(Date.now() + 1000));
    await expect(journal.changesSince(user.id, '0', 10)).rejects.toMatchObject({ code: 'cursor_expired' });
    expect((await journal.changesSince(user.id, '2', 10)).entries).toEqual([]);
  });

  it('serializes concurrent writers: seqs are gap-free in commit order', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => rec([ref(i + 1)])));
    const page = await journal.changesSince(user.id, '0', 100);
    expect(page.entries.map((e) => Number(e.seq))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
```

`apps/server/src/journal/item-store.spec.ts`:
```ts
import { createTestApp, createTestUser, TestContext } from '../../test/context';
import { IndexUser } from '../common/types';
import { ItemStore } from './item-store';

describe('ItemStore', () => {
  let ctx: TestContext; let store: ItemStore; let user: IndexUser;
  beforeEach(async () => { ctx = await createTestApp(); store = ctx.app.get(ItemStore); user = await createTestUser(ctx); });
  afterEach(async () => { await ctx.close(); });

  const mk = (path: string, type: 'folder' | 'file', parentId: string | null) =>
    ctx.prisma.item.create({ data: { ownerId: user.id, parentId, type, name: path.split('/').pop()!, nameKey: path.split('/').pop()!.toLowerCase(), path, mtime: new Date() } });

  it('rewrites descendant paths on folder move (unicode-safe)', async () => {
    const a = await mk('Ä 🚀', 'folder', null);
    const b = await mk('Ä 🚀/sub', 'folder', a.id);
    await mk('Ä 🚀/sub/f.txt', 'file', b.id);
    await mk('Ä 🚀 other/x', 'file', null); // same prefix without slash must not change
    await ctx.prisma.$transaction((tx) => store.rewritePrefix(tx, user.id, 'Ä 🚀', 'moved/Ä 🚀'));
    const paths = (await ctx.prisma.item.findMany({ orderBy: { path: 'asc' } })).map((i) => i.path);
    expect(paths).toEqual(['moved/Ä 🚀/sub', 'moved/Ä 🚀/sub/f.txt', 'Ä 🚀', 'Ä 🚀 other/x'].sort());
  });

  it('tombstones a subtree and hides it from live queries', async () => {
    const a = await mk('a', 'folder', null);
    await mk('a/x', 'file', a.id);
    const gone = await ctx.prisma.$transaction((tx) => store.tombstoneSubtree(tx, a));
    expect(gone).toHaveLength(2);
    expect(await ctx.prisma.$transaction((tx) => store.liveChildren(tx, user.id, null))).toEqual([]);
  });

  it('finds siblings sharing a name key', async () => {
    const x = await mk('Doc.md', 'file', null);
    const y = await ctx.prisma.item.create({ data: { ownerId: user.id, parentId: null, type: 'file', name: 'doc.md', nameKey: 'doc.md', path: 'doc.md', mtime: new Date() } });
    const res = await ctx.prisma.$transaction((tx) => store.sameKeySiblings(tx, user.id, null, ['doc.md'], new Set([x.id])));
    expect(res.map((r) => r.id)).toEqual([y.id]);
  });
});
```
(The `nameKey` for `Doc.md` built by `mk` is `doc.md`, so both share the key.)

`apps/server/src/journal/busy-paths.spec.ts`:
```ts
import { BusyPaths } from './busy-paths';

it('covers a path and its descendants until released', () => {
  const b = new BusyPaths();
  const release = b.add('u1', 'a/b');
  expect(b.covers('u1', 'a/b')).toBe(true);
  expect(b.covers('u1', 'a/b/c.txt')).toBe(true);
  expect(b.covers('u1', 'a/bc')).toBe(false);
  expect(b.covers('u2', 'a/b')).toBe(false);
  release();
  expect(b.covers('u1', 'a/b')).toBe(false);
});
```
Run: `cd apps/server && pnpm jest src/journal`
Expected: FAIL.

- [ ] **Step 2: Implement**

`apps/server/src/journal/journal.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { ChangeOp, ItemType, Prisma } from '@prisma/client';
import { SyncError } from '../common/sync-error';
import { PrismaService } from '../prisma/prisma.service';

export type Tx = Prisma.TransactionClient;
export interface ItemRef { id: string; type: ItemType }

@Injectable()
export class JournalService {
  constructor(private readonly prisma: PrismaService) {}

  /** Serializes all mutations of one user's tree (API + indexer). Released at commit/rollback. */
  async lockUser(tx: Tx, userId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`;
  }

  async record(tx: Tx, userId: string, refs: ItemRef[], op: ChangeOp): Promise<void> {
    const unique = [...new Map(refs.map((r) => [r.id, r])).values()];
    if (unique.length === 0) return;
    const n = unique.length;
    const rows = await tx.$queryRaw<{ seq: bigint }[]>`
      INSERT INTO "SyncScope" ("userId", seq, "minSeq") VALUES (${userId}::uuid, ${n}, 0)
      ON CONFLICT ("userId") DO UPDATE SET seq = "SyncScope".seq + ${n}
      RETURNING seq`;
    const first = rows[0].seq - BigInt(n) + 1n;
    await tx.fileChange.createMany({
      data: unique.map((r, i) => ({ scopeId: userId, seq: first + BigInt(i), itemId: r.id, itemType: r.type, op })),
    });
  }

  async currentCursor(userId: string): Promise<string> {
    const scope = await this.prisma.syncScope.findUnique({ where: { userId } });
    return String(scope?.seq ?? 0n);
  }

  async changesSince(userId: string, cursor: string, limit: number) {
    if (!/^\d{1,19}$/.test(cursor)) throw new SyncError('invalid_request', 'invalid cursor');
    const c = BigInt(cursor);
    const scope = await this.prisma.syncScope.findUnique({ where: { userId } });
    const head = scope?.seq ?? 0n;
    if (c < (scope?.minSeq ?? 0n) || c > head) throw new SyncError('cursor_expired');
    const rows = await this.prisma.$queryRaw<{ itemId: string; itemType: ItemType; seq: bigint }[]>`
      SELECT "itemId", "itemType", MAX(seq) AS seq FROM "FileChange"
      WHERE "scopeId" = ${userId}::uuid AND seq > ${c}
      GROUP BY "itemId", "itemType"
      ORDER BY MAX(seq)
      LIMIT ${limit + 1}`;
    const hasMore = rows.length > limit;
    const entries = rows.slice(0, limit);
    const last = entries.length ? entries[entries.length - 1].seq : c;
    const next = hasMore ? last : last > head ? last : head;
    return { entries, cursor: String(next), hasMore };
  }

  /** Deletes journal entries older than `before` and raises the watermark. */
  async trim(userId: string, before: Date): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const max = await tx.fileChange.aggregate({ where: { scopeId: userId, at: { lt: before } }, _max: { seq: true } });
      if (max._max.seq === null) return 0;
      const res = await tx.fileChange.deleteMany({ where: { scopeId: userId, seq: { lte: max._max.seq } } });
      await tx.syncScope.update({ where: { userId }, data: { minSeq: max._max.seq } });
      return res.count;
    });
  }
}
```

`apps/server/src/journal/item-store.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { Item } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Tx } from './journal.service';

@Injectable()
export class ItemStore {
  constructor(private readonly prisma: PrismaService) {}

  liveChildren(tx: Tx, ownerId: string, parentId: string | null): Promise<Item[]> {
    return tx.item.findMany({ where: { ownerId, parentId, deletedAt: null } });
  }

  getLive(tx: Tx, ownerId: string, id: string): Promise<Item | null> {
    return tx.item.findFirst({ where: { id, ownerId, deletedAt: null } });
  }

  findLiveByPath(tx: Tx, ownerId: string, path: string): Promise<Item | null> {
    return tx.item.findFirst({ where: { ownerId, path, deletedAt: null } });
  }

  liveDescendants(tx: Tx, ownerId: string, path: string): Promise<Item[]> {
    return tx.$queryRaw<Item[]>`
      SELECT * FROM "Item" WHERE "ownerId" = ${ownerId}::uuid AND "deletedAt" IS NULL
      AND left(path, char_length(${path}) + 1) = ${path} || '/'`;
  }

  async rewritePrefix(tx: Tx, ownerId: string, oldPath: string, newPath: string): Promise<void> {
    await tx.$executeRaw`
      UPDATE "Item" SET path = ${newPath} || substring(path FROM char_length(${oldPath}) + 1), "updatedAt" = now()
      WHERE "ownerId" = ${ownerId}::uuid AND "deletedAt" IS NULL
      AND left(path, char_length(${oldPath}) + 1) = ${oldPath} || '/'`;
  }

  async tombstoneSubtree(tx: Tx, item: Item): Promise<Item[]> {
    const all = item.type === 'folder' ? [item, ...(await this.liveDescendants(tx, item.ownerId, item.path))] : [item];
    await tx.item.updateMany({ where: { id: { in: all.map((i) => i.id) } }, data: { deletedAt: new Date() } });
    return all;
  }

  sameKeySiblings(tx: Tx, ownerId: string, parentId: string | null, keys: string[], excludeIds: Set<string>): Promise<Item[]> {
    if (keys.length === 0) return Promise.resolve([]);
    return tx.item.findMany({
      where: { ownerId, parentId, deletedAt: null, nameKey: { in: keys }, id: { notIn: [...excludeIds] } },
    });
  }

  async purgeTombstones(olderThan: Date): Promise<number> {
    return (await this.prisma.item.deleteMany({ where: { deletedAt: { lt: olderThan } } })).count;
  }
}
```
Note: `$queryRaw<Item[]>` returns `size`/`ino`/`dev` as `bigint` and timestamps as `Date` – same shapes as Prisma models; column names are the quoted camelCase names, so the row objects match `Item`.

`apps/server/src/journal/busy-paths.ts`:
```ts
import { Injectable } from '@nestjs/common';

/** Paths currently being moved/deleted by the API outside a transaction; the indexer skips them. */
@Injectable()
export class BusyPaths {
  private readonly busy = new Map<string, number>();

  add(userId: string, rel: string): () => void {
    const key = `${userId}\u0000${rel}`;
    this.busy.set(key, (this.busy.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.busy.get(key) ?? 1) - 1;
      if (n <= 0) this.busy.delete(key); else this.busy.set(key, n);
    };
  }

  covers(userId: string, rel: string): boolean {
    for (const key of this.busy.keys()) {
      const [uid, p] = key.split('\u0000');
      if (uid === userId && (rel === p || rel.startsWith(p + '/'))) return true;
    }
    return false;
  }
}
```

`apps/server/src/journal/journal.module.ts`:
```ts
import { Global, Module } from '@nestjs/common';
import { BusyPaths } from './busy-paths';
import { ItemStore } from './item-store';
import { JournalService } from './journal.service';

@Global()
@Module({ providers: [JournalService, ItemStore, BusyPaths], exports: [JournalService, ItemStore, BusyPaths] })
export class JournalModule {}
```

- [ ] **Step 3: Run tests**

Run: `cd apps/server && pnpm jest src/journal && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/journal
git commit -m "feat(server): gap-free per-user change journal, item store and busy paths

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Indexer – reconcile disk into Item rows with stable IDs

**Files:**
- Create: `apps/server/src/indexer/{indexer.service.ts,disk.ts}`
- Modify: `apps/server/src/indexer/indexer.module.ts` (replace stub)
- Test: `apps/server/src/indexer/indexer.spec.ts`

**Interfaces:**
- Consumes: `JournalService`, `ItemStore`, `BusyPaths` (Task 4); `nameKey`, `isIgnored` (Task 2); `absPath`, `joinRel`, `parentRel`, `userRoot` (Task 1); `APP_CONFIG`, `AppEvents`.
- Produces:
  - `interface DiskEntry { name: string; type: ItemType; size: bigint; mtime: Date; ino: bigint; dev: bigint }`
  - `readDisk(abs: string, log?: (msg: string) => void): Promise<DiskEntry[]>` (skips ignored, non-UTF-8, symlinks, special files)
  - `interface ReconcileStats { created: number; updated: number; moved: number; deleted: number }`
  - `IndexerService.reconcileDir(user: IndexUser, relDir: string, opts: { recursive: boolean }): Promise<ReconcileStats>`
  - `IndexerService.fullScan(user: IndexUser): Promise<ReconcileStats | null>` (null = refused, see guard)
  - `IndexerService.dataRootLooksMounted(): Promise<boolean>`
  - `IndexerModule` exports `IndexerService`

- [ ] **Step 1: Write failing tests**

`apps/server/src/indexer/indexer.spec.ts`:
```ts
import { mkdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, createTestUser, itIfCaseSensitive, TestContext } from '../../test/context';
import { IndexUser } from '../common/types';
import { JournalService } from '../journal/journal.service';
import { IndexerService } from './indexer.service';

describe('IndexerService', () => {
  let ctx: TestContext; let indexer: IndexerService; let journal: JournalService; let user: IndexUser; let root: string;
  beforeEach(async () => {
    ctx = await createTestApp();
    indexer = ctx.app.get(IndexerService);
    journal = ctx.app.get(JournalService);
    user = await createTestUser(ctx);
    root = path.join(ctx.config.dataRoot, user.username);
  });
  afterEach(async () => { await ctx.close(); });

  const live = () => ctx.prisma.item.findMany({ where: { deletedAt: null }, orderBy: { path: 'asc' } });
  const byPath = async (p: string) => (await live()).find((i) => i.path === p)!;
  const changesFrom = async (cursor: string) => (await journal.changesSince(user.id, cursor, 1000)).entries;

  it('indexes a fresh tree recursively and journals every item', async () => {
    await mkdir(path.join(root, 'Docs/Sub'), { recursive: true });
    await writeFile(path.join(root, 'Docs/a.txt'), 'hello');
    await writeFile(path.join(root, 'Docs/Sub/b.txt'), 'world!');
    const stats = await indexer.fullScan(user);
    expect(stats).toMatchObject({ created: 4 });
    expect((await live()).map((i) => [i.path, i.type, Number(i.size)])).toEqual([
      ['Docs', 'folder', 0], ['Docs/Sub', 'folder', 0], ['Docs/Sub/b.txt', 'file', 6], ['Docs/a.txt', 'file', 5],
    ]);
    expect((await byPath('Docs/Sub/b.txt')).parentId).toBe((await byPath('Docs/Sub')).id);
    expect(await changesFrom('0')).toHaveLength(4);
  });

  it('is idempotent: a second scan journals nothing', async () => {
    await writeFile(path.join(root, 'a.txt'), 'x');
    await indexer.fullScan(user);
    const cursor = await journal.currentCursor(user.id);
    expect(await indexer.fullScan(user)).toMatchObject({ created: 0, updated: 0, moved: 0, deleted: 0 });
    expect(await journal.currentCursor(user.id)).toBe(cursor);
  });

  it('keeps the ID on external rename and move (inode match)', async () => {
    await mkdir(path.join(root, 'A'));
    await mkdir(path.join(root, 'B'));
    await writeFile(path.join(root, 'A/doc.txt'), 'content');
    await indexer.fullScan(user);
    const id = (await byPath('A/doc.txt')).id;
    await rename(path.join(root, 'A/doc.txt'), path.join(root, 'B/renamed.txt'));
    const stats = await indexer.fullScan(user);
    expect(stats).toMatchObject({ moved: 1, created: 0 });
    const moved = await byPath('B/renamed.txt');
    expect(moved.id).toBe(id);
    expect(moved.parentId).toBe((await byPath('B')).id);
  });

  it('keeps folder and descendant IDs when a folder is moved externally', async () => {
    await mkdir(path.join(root, 'X/Inner'), { recursive: true });
    await writeFile(path.join(root, 'X/Inner/f.txt'), 'f');
    await mkdir(path.join(root, 'Target'));
    await indexer.fullScan(user);
    const before = await live();
    await rename(path.join(root, 'X'), path.join(root, 'Target/X2'));
    await indexer.fullScan(user);
    const after = await live();
    const idOf = (rows: typeof before, p: string) => rows.find((r) => r.path === p)!.id;
    expect(idOf(after, 'Target/X2')).toBe(idOf(before, 'X'));
    expect(idOf(after, 'Target/X2/Inner')).toBe(idOf(before, 'X/Inner'));
    expect(idOf(after, 'Target/X2/Inner/f.txt')).toBe(idOf(before, 'X/Inner/f.txt'));
  });

  it('keeps the ID and bumps version on editor-style save (temp file + rename over)', async () => {
    await writeFile(path.join(root, 'note.md'), 'v1');
    await indexer.fullScan(user);
    const before = await byPath('note.md');
    await writeFile(path.join(root, 'note.md.tmp~'), 'v2 longer');
    await rename(path.join(root, 'note.md.tmp~'), path.join(root, 'note.md'));
    await indexer.reconcileDir(user, '', { recursive: false });
    const after = await byPath('note.md');
    expect(after.id).toBe(before.id);
    expect(after.version).toBe(before.version + 1);
    expect(Number(after.size)).toBe(9);
  });

  it('detects in-place content changes via size/mtime', async () => {
    await writeFile(path.join(root, 'a.txt'), 'one');
    await indexer.fullScan(user);
    await writeFile(path.join(root, 'a.txt'), 'two');
    await utimes(path.join(root, 'a.txt'), new Date(), new Date(Date.now() + 5000));
    expect(await indexer.fullScan(user)).toMatchObject({ updated: 1 });
  });

  it('tombstones deleted items and journals deletes for the subtree', async () => {
    await mkdir(path.join(root, 'D'));
    await writeFile(path.join(root, 'D/x.txt'), 'x');
    await indexer.fullScan(user);
    const cursor = await journal.currentCursor(user.id);
    await rm(path.join(root, 'D'), { recursive: true });
    expect(await indexer.fullScan(user)).toMatchObject({ deleted: 1 });
    expect(await live()).toEqual([]);
    expect(await changesFrom(cursor)).toHaveLength(2);
  });

  it('treats a type change at the same path as delete + create', async () => {
    await writeFile(path.join(root, 'thing'), 'file');
    await indexer.fullScan(user);
    const oldId = (await byPath('thing')).id;
    await rm(path.join(root, 'thing'));
    await mkdir(path.join(root, 'thing'));
    await indexer.fullScan(user);
    const now = await byPath('thing');
    expect(now.type).toBe('folder');
    expect(now.id).not.toBe(oldId);
  });

  it('skips ignored names, temp files and symlinks (Review Focus 4)', async () => {
    await writeFile(path.join(root, '.DS_Store'), 'x');
    await writeFile(path.join(root, '.synclet-tmp-abc'), 'x');
    await writeFile(path.join(root, 'keep.txt'), 'x');
    await symlink('/etc', path.join(root, 'evil'));
    await symlink(path.join(root, 'keep.txt'), path.join(root, 'link.txt'));
    await indexer.fullScan(user);
    expect((await live()).map((i) => i.path)).toEqual(['keep.txt']);
  });

  it('refuses to scan when the data root has no user folders (Review Focus 1)', async () => {
    await writeFile(path.join(root, 'a.txt'), 'x');
    await indexer.fullScan(user);
    const cursor = await journal.currentCursor(user.id);
    await rm(root, { recursive: true }); // simulates an unmounted/empty volume
    expect(await indexer.fullScan(user)).toBeNull();
    expect(await journal.currentCursor(user.id)).toBe(cursor);
    expect(await live()).toHaveLength(1);
  });

  it('reconcileDir climbs to the nearest indexed ancestor for unknown directories', async () => {
    await indexer.fullScan(user);
    await mkdir(path.join(root, 'new/deep'), { recursive: true });
    await writeFile(path.join(root, 'new/deep/f.txt'), 'x');
    await indexer.reconcileDir(user, 'new/deep', { recursive: false });
    expect((await live()).map((i) => i.path)).toEqual(['new', 'new/deep', 'new/deep/f.txt']);
  });

  it('skips paths marked busy by the API', async () => {
    await writeFile(path.join(root, 'busy.txt'), 'x');
    const { BusyPaths } = await import('../journal/busy-paths');
    const release = ctx.app.get(BusyPaths).add(user.id, 'busy.txt');
    await indexer.fullScan(user);
    expect(await live()).toEqual([]);
    release();
  });

  itIfCaseSensitive('indexes case variants as separate items', async () => {
    await writeFile(path.join(root, 'a.txt'), '1');
    await writeFile(path.join(root, 'A.txt'), '2');
    await indexer.fullScan(user);
    expect((await live()).map((i) => i.name).sort()).toEqual(['A.txt', 'a.txt']);
  });
});
```
Run: `cd apps/server && pnpm jest src/indexer`
Expected: FAIL.

- [ ] **Step 2: Implement disk reader**

`apps/server/src/indexer/disk.ts`:
```ts
import type { ItemType } from '@prisma/client';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isIgnored } from '../common/names';

export interface DiskEntry {
  name: string;
  type: ItemType;
  size: bigint;
  mtime: Date;
  ino: bigint;
  dev: bigint;
}

const CHUNK = 64;

/** Lists a directory: regular files and directories only, no symlinks, no ignored names, valid UTF-8 only. */
export async function readDisk(abs: string, log: (msg: string) => void = () => {}): Promise<DiskEntry[]> {
  const dirents = await readdir(abs, { withFileTypes: true, encoding: 'buffer' });
  const names: string[] = [];
  for (const d of dirents) {
    const raw = d.name as unknown as Buffer;
    const name = raw.toString('utf8');
    if (!Buffer.from(name, 'utf8').equals(raw)) { log(`skipping non-UTF-8 name in ${abs}`); continue; }
    if (isIgnored(name)) continue;
    if (!d.isFile() && !d.isDirectory()) continue;
    names.push(name);
  }
  const out: DiskEntry[] = [];
  for (let i = 0; i < names.length; i += CHUNK) {
    const stats = await Promise.all(
      names.slice(i, i + CHUNK).map(async (name) => {
        try {
          const st = await lstat(path.join(abs, name), { bigint: true });
          if (!st.isFile() && !st.isDirectory()) return null;
          const entry: DiskEntry = {
            name, type: st.isDirectory() ? 'folder' : 'file', size: st.isDirectory() ? 0n : st.size,
            mtime: new Date(Number(st.mtimeMs)), ino: st.ino, dev: st.dev,
          };
          return entry;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw e;
        }
      }),
    );
    for (const s of stats) if (s) out.push(s);
  }
  return out;
}
```

- [ ] **Step 3: Implement IndexerService**

`apps/server/src/indexer/indexer.service.ts`:
```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Item } from '@prisma/client';
import { lstat, readdir } from 'node:fs/promises';
import { APP_CONFIG, AppConfig } from '../config';
import { nameKey } from '../common/names';
import { absPath, joinRel, parentRel, userRoot } from '../common/paths';
import type { IndexUser } from '../common/types';
import { BusyPaths } from '../journal/busy-paths';
import { ItemStore } from '../journal/item-store';
import { ItemRef, JournalService, Tx } from '../journal/journal.service';
import { PrismaService, TX_OPTS } from '../prisma/prisma.service';
import { DiskEntry, readDisk } from './disk';

export interface ReconcileStats { created: number; updated: number; moved: number; deleted: number }

interface QueueEntry { dir: string; recursive: boolean }
type OneResult = { kind: 'ok'; subdirs: string[]; newDirs: string[] } | { kind: 'missing-dir' } | { kind: 'missing-parent' };

const isErrno = (e: unknown, ...codes: string[]) => codes.includes((e as NodeJS.ErrnoException)?.code ?? '');

@Injectable()
export class IndexerService {
  private readonly log = new Logger(IndexerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
    private readonly store: ItemStore,
    private readonly busy: BusyPaths,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Mass-deletion guard: an empty or missing data root almost always means an unmounted volume. */
  async dataRootLooksMounted(): Promise<boolean> {
    try {
      const entries = await readdir(this.config.dataRoot, { withFileTypes: true });
      return entries.some((e) => e.isDirectory());
    } catch {
      return false;
    }
  }

  async fullScan(user: IndexUser): Promise<ReconcileStats | null> {
    const root = userRoot(this.config.dataRoot, user.username);
    const rootOk = await lstat(root).then((s) => s.isDirectory(), () => false);
    if (!rootOk || !(await this.dataRootLooksMounted())) {
      this.log.error(`user root ${root} missing or data root empty – refusing to scan (unmounted volume?)`);
      return null;
    }
    return this.reconcileDir(user, '', { recursive: true });
  }

  async reconcileDir(user: IndexUser, relDir: string, opts: { recursive: boolean }): Promise<ReconcileStats> {
    const stats: ReconcileStats = { created: 0, updated: 0, moved: 0, deleted: 0 };
    const queue: QueueEntry[] = [{ dir: relDir, recursive: opts.recursive }];
    while (queue.length) {
      const { dir, recursive } = queue.shift()!;
      if (dir !== '' && this.busy.covers(user.id, dir)) continue;
      const res = await this.reconcileOne(user, dir, stats);
      if (res.kind === 'missing-parent') {
        // The directory is not indexed yet: rescan the nearest ancestor that is.
        queue.push({ dir: parentRel(dir), recursive: true });
        continue;
      }
      if (res.kind === 'missing-dir') continue;
      const next = recursive ? res.subdirs : res.newDirs;
      for (const d of next) queue.push({ dir: d, recursive: recursive || res.newDirs.includes(d) });
    }
    return stats;
  }

  private async reconcileOne(user: IndexUser, dir: string, stats: ReconcileStats): Promise<OneResult> {
    const abs = absPath(this.config.dataRoot, user.username, dir);
    return this.prisma.$transaction(async (tx) => {
      await this.journal.lockUser(tx, user.id);
      let parentId: string | null = null;
      if (dir !== '') {
        const parent = await this.store.findLiveByPath(tx, user.id, dir);
        if (!parent || parent.type !== 'folder') {
          const exists = await lstat(abs).then((s) => s.isDirectory(), () => false);
          return exists ? { kind: 'missing-parent' as const } : { kind: 'missing-dir' as const };
        }
        parentId = parent.id;
      }
      // Read the disk while holding the lock so API writes cannot interleave with this snapshot.
      let disk: DiskEntry[];
      try {
        disk = await readDisk(abs, (m) => this.log.warn(m));
      } catch (e) {
        if (isErrno(e, 'ENOENT', 'ENOTDIR')) return { kind: 'missing-dir' as const };
        throw e;
      }
      disk = disk.filter((e) => !this.busy.covers(user.id, joinRel(dir, e.name)));
      return this.applyDiff(tx, user, dir, parentId, disk, stats);
    }, TX_OPTS);
  }

  private async applyDiff(tx: Tx, user: IndexUser, dir: string, parentId: string | null, disk: DiskEntry[], stats: ReconcileStats): Promise<OneResult> {
    const rows = await this.store.liveChildren(tx, user.id, parentId);
    const byName = new Map(rows.map((r) => [r.name, r]));
    const seen = new Set<string>();
    const upserts: ItemRef[] = [];
    const deletes: ItemRef[] = [];
    const touchedKeys = new Map<string | null, Set<string>>(); // parentId -> nameKeys whose display names may shift
    const touch = (pid: string | null, key: string) => (touchedKeys.get(pid) ?? touchedKeys.set(pid, new Set()).get(pid)!).add(key);
    const unmatched: DiskEntry[] = [];
    const subdirs: string[] = [];
    const newDirs: string[] = [];

    // 1) Same name: same item (even with a new inode – editors save via temp + rename).
    for (const e of disk) {
      const rel = joinRel(dir, e.name);
      if (e.type === 'folder') subdirs.push(rel);
      const row = byName.get(e.name);
      if (!row || row.type !== e.type) { unmatched.push(e); continue; }
      seen.add(row.id);
      const contentChanged = e.type === 'file' && (row.size !== e.size || row.mtime.getTime() !== e.mtime.getTime());
      if (contentChanged) {
        await tx.item.update({ where: { id: row.id }, data: { size: e.size, mtime: e.mtime, ino: e.ino, dev: e.dev, contentHash: null, version: { increment: 1 } } });
        upserts.push(row); stats.updated++;
      } else if (row.ino !== e.ino || row.dev !== e.dev) {
        await tx.item.update({ where: { id: row.id }, data: { ino: e.ino, dev: e.dev } });
      }
    }

    // 2) Rows whose name now has a different type must go before new rows take their path.
    for (const row of rows) {
      const e = disk.find((d) => d.name === row.name);
      if (e && e.type !== row.type) {
        const gone = await this.store.tombstoneSubtree(tx, row);
        deletes.push(...gone); seen.add(row.id); stats.deleted++; touch(parentId, row.nameKey);
      }
    }

    // 3) New names: inode match => move/rename (ID kept), else create.
    for (const e of unmatched) {
      const rel = joinRel(dir, e.name);
      const key = nameKey(e.name);
      const cand = await this.findMoveCandidate(tx, user, e, seen);
      if (cand) {
        const wasLive = cand.deletedAt === null;
        await tx.item.update({
          where: { id: cand.id },
          data: { parentId, name: e.name, nameKey: key, path: rel, deletedAt: null, ino: e.ino, dev: e.dev, mtime: e.mtime },
        });
        if (cand.type === 'folder' && wasLive) await this.store.rewritePrefix(tx, user.id, cand.path, rel);
        seen.add(cand.id); upserts.push(cand); stats.moved++;
        if (cand.parentId !== parentId) touch(cand.parentId, cand.nameKey);
        if (e.type === 'folder' && !wasLive) newDirs.push(rel); // resurrected folder: re-pair its children
      } else {
        const created = await tx.item.create({
          data: { ownerId: user.id, parentId, type: e.type, name: e.name, nameKey: key, path: rel, size: e.size, mtime: e.mtime, ino: e.ino, dev: e.dev },
        });
        upserts.push(created); stats.created++;
        if (e.type === 'folder') newDirs.push(rel);
      }
      touch(parentId, key);
    }

    // 4) Rows not found on disk: tombstone (kept for tombstoneWindowSec to pair later moves).
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      const gone = await this.store.tombstoneSubtree(tx, row);
      deletes.push(...gone); stats.deleted++; touch(parentId, row.nameKey);
    }

    // 5) Siblings whose display name may change (case/NFC duplicates) are re-announced.
    const changedIds = new Set([...upserts, ...deletes].map((r) => r.id));
    for (const [pid, keys] of touchedKeys) {
      upserts.push(...(await this.store.sameKeySiblings(tx, user.id, pid, [...keys], changedIds)));
    }

    await this.journal.record(tx, user.id, deletes, 'delete');
    await this.journal.record(tx, user.id, upserts.filter((u) => !deletes.some((d) => d.id === u.id)), 'upsert');
    return { kind: 'ok', subdirs, newDirs };
  }

  private async findMoveCandidate(tx: Tx, user: IndexUser, e: DiskEntry, seen: Set<string>): Promise<Item | null> {
    const windowStart = new Date(Date.now() - this.config.tombstoneWindowSec * 1000);
    const cands = await tx.item.findMany({
      where: { ownerId: user.id, dev: e.dev, ino: e.ino, type: e.type, OR: [{ deletedAt: null }, { deletedAt: { gte: windowStart } }] },
      orderBy: { updatedAt: 'desc' },
    });
    for (const c of cands) {
      if (seen.has(c.id)) continue;
      // Guard against inode reuse: files must keep size and mtime across a move.
      if (e.type === 'file' && (c.size !== e.size || c.mtime.getTime() !== e.mtime.getTime())) continue;
      if (c.deletedAt === null) {
        // A live row only moved if its old path is gone (otherwise it is a hard link).
        const old = absPath(this.config.dataRoot, user.username, c.path);
        const stillThere = await lstat(old, { bigint: true }).then((s) => s.ino === c.ino && s.dev === c.dev, () => false);
        if (stillThere) continue;
      }
      return c;
    }
    return null;
  }
}
```

`apps/server/src/indexer/indexer.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { IndexerService } from './indexer.service';

@Module({ providers: [IndexerService], exports: [IndexerService] })
export class IndexerModule {}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && pnpm jest src/indexer && pnpm typecheck`
Expected: PASS (the case-variant test logs "skipped" on macOS).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/indexer
git commit -m "feat(server): indexer reconciles disk into items with stable IDs across external moves

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: FilesService – atomic, non-clobbering disk mutations

**Files:**
- Create: `apps/server/src/files/{files.service.ts,fs-ops.ts}`
- Modify: `apps/server/src/files/files.module.ts` (replace stub)
- Test: `apps/server/src/files/files.spec.ts`, `apps/server/src/files/fs-ops.spec.ts`

**Interfaces:**
- Consumes: Task 1 paths/config/SyncError, Task 2 names, Task 4 `JournalService`/`ItemStore`/`BusyPaths`, Task 5 `IndexerService` (only for tests to seed, not as runtime dependency).
- Produces:
  - `fs-ops.ts`: `linkNoReplace(src: string, dst: string): Promise<void>` (throws `EEXIST`-coded error if dst exists), `moveNoReplace(src, dst): Promise<void>`, `moveAcrossFs(src, dst): Promise<void>`, `statEntry(abs): Promise<{ size: bigint; mtime: Date; ino: bigint; dev: bigint }>`
  - `type OnConflict = 'fail' | 'rename'`
  - `FilesService.createFolder(user: IndexUser, parentId: string | null, name: string, onConflict?: OnConflict): Promise<Item>`
  - `FilesService.upload(user, parentId: string | null, name: string, body: Readable, opts: { onConflict?: OnConflict; modifiedAt?: Date | null }): Promise<Item>`
  - `FilesService.replaceContent(user, itemId: string, body: Readable, opts: { ifMatchVersion: number; modifiedAt?: Date | null }): Promise<Item>`
  - `FilesService.update(user, itemId: string, patch: { name?: string; parentId?: string | null }, opts?: { ifMatchEtag?: string }): Promise<Item>` (`parentId: null` = move to root, `undefined` = keep)
  - `FilesService.remove(user, itemId: string): Promise<void>` (moves to `/meta/trash/<trashId>/<name>`, writes `TrashEntry`)
  - `FilesService.openRead(user, itemId: string): Promise<{ item: Item; abs: string }>`
  - `itemEtag(item: Item): string` (`v<version>` / `t<updatedAtMs>`) – exported from `files.service.ts`
  - `FilesModule` exports `FilesService`

- [ ] **Step 1: Write failing tests**

`apps/server/src/files/fs-ops.spec.ts`:
```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { linkNoReplace } from './fs-ops';

it('linkNoReplace never clobbers an existing file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'synclet-ops-'));
  await writeFile(path.join(dir, 'src'), 'new');
  await writeFile(path.join(dir, 'dst'), 'old');
  await expect(linkNoReplace(path.join(dir, 'src'), path.join(dir, 'dst'))).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await readFile(path.join(dir, 'dst'), 'utf8')).toBe('old');
  await linkNoReplace(path.join(dir, 'src'), path.join(dir, 'fresh'));
  expect(await readFile(path.join(dir, 'fresh'), 'utf8')).toBe('new');
});
```

`apps/server/src/files/files.spec.ts`:
```ts
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { createTestApp, createTestUser, TestContext } from '../../test/context';
import { IndexUser } from '../common/types';
import { IndexerService } from '../indexer/indexer.service';
import { JournalService } from '../journal/journal.service';
import { FilesService } from './files.service';

describe('FilesService', () => {
  let ctx: TestContext; let files: FilesService; let user: IndexUser; let root: string;
  beforeEach(async () => {
    ctx = await createTestApp();
    files = ctx.app.get(FilesService);
    user = await createTestUser(ctx);
    root = path.join(ctx.config.dataRoot, user.username);
  });
  afterEach(async () => { await ctx.close(); });

  const body = (s: string) => Readable.from([Buffer.from(s)]);
  const visible = async (dir = root) => (await readdir(dir)).sort();

  it('creates folders and files exactly as named on disk', async () => {
    const folder = await files.createFolder(user, null, 'Projekte 2026');
    const file = await files.upload(user, folder.id, 'Angebot ü.txt', body('hallo'), {});
    expect(await visible()).toEqual(['Projekte 2026']);
    expect(await readFile(path.join(root, 'Projekte 2026', 'Angebot ü.txt'), 'utf8')).toBe('hallo');
    expect(file.path).toBe('Projekte 2026/Angebot ü.txt');
    expect(file.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(file.size)).toBe(5);
  });

  it('rejects invalid names and missing parents', async () => {
    await expect(files.createFolder(user, null, 'a/b')).rejects.toMatchObject({ code: 'invalid_name' });
    await expect(files.createFolder(user, '00000000-0000-4000-8000-000000000000', 'x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('handles name conflicts case-insensitively with fail or rename', async () => {
    await files.upload(user, null, 'Report.pdf', body('1'), {});
    await expect(files.upload(user, null, 'report.PDF', body('2'), {})).rejects.toMatchObject({ code: 'name_conflict' });
    const renamed = await files.upload(user, null, 'report.PDF', body('2'), { onConflict: 'rename' });
    expect(renamed.name).toBe('report (2).PDF');
  });

  it('upload never overwrites an unindexed file on disk (Review Focus 3)', async () => {
    await writeFile(path.join(root, 'fresh.txt'), 'external');
    await expect(files.upload(user, null, 'fresh.txt', body('mine'), {})).rejects.toMatchObject({ code: 'name_conflict' });
    expect(await readFile(path.join(root, 'fresh.txt'), 'utf8')).toBe('external');
    const r = await files.upload(user, null, 'fresh.txt', body('mine'), { onConflict: 'rename' });
    expect(r.name).toBe('fresh (2).txt');
    expect(await readFile(path.join(root, 'fresh.txt'), 'utf8')).toBe('external');
  });

  it('aborted upload leaves nothing behind (Review Focus 5)', async () => {
    const stream = new PassThrough();
    const p = files.upload(user, null, 'big.bin', stream, {});
    stream.write(Buffer.alloc(1024));
    stream.destroy(new Error('client went away'));
    await expect(p).rejects.toThrow();
    expect(await visible()).toEqual([]);
    expect(await ctx.prisma.item.count()).toBe(0);
  });

  it('replaceContent enforces If-Match and bumps the version', async () => {
    const f = await files.upload(user, null, 'a.txt', body('v1'), {});
    await expect(files.replaceContent(user, f.id, body('x'), { ifMatchVersion: 99 })).rejects.toMatchObject({ code: 'conflict' });
    const v2 = await files.replaceContent(user, f.id, body('version two'), { ifMatchVersion: f.version });
    expect(v2.version).toBe(f.version + 1);
    expect(v2.id).toBe(f.id);
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('version two');
  });

  it('replaceContent detects an unindexed external edit (Review Focus 2)', async () => {
    const f = await files.upload(user, null, 'a.txt', body('v1'), {});
    await writeFile(path.join(root, 'a.txt'), 'edited on host, longer');
    await expect(files.replaceContent(user, f.id, body('client'), { ifMatchVersion: f.version })).rejects.toMatchObject({ code: 'conflict' });
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('edited on host, longer');
  });

  it('applies modifiedAt to the file on disk', async () => {
    const when = new Date('2024-05-01T10:00:00.000Z');
    const f = await files.upload(user, null, 'dated.txt', body('x'), { modifiedAt: when });
    expect((await stat(path.join(root, 'dated.txt'))).mtime.toISOString()).toBe(when.toISOString());
    expect(f.mtime.toISOString()).toBe(when.toISOString());
  });

  it('renames and moves folders, keeping IDs and rewriting descendant paths', async () => {
    const a = await files.createFolder(user, null, 'A');
    const b = await files.createFolder(user, null, 'B');
    const f = await files.upload(user, a.id, 'x.txt', body('x'), {});
    const moved = await files.update(user, a.id, { name: 'A2', parentId: b.id });
    expect(moved.path).toBe('B/A2');
    expect((await ctx.prisma.item.findUniqueOrThrow({ where: { id: f.id } })).path).toBe('B/A2/x.txt');
    expect(await visible(path.join(root, 'B', 'A2'))).toEqual(['x.txt']);
    await expect(files.update(user, b.id, { parentId: moved.id })).rejects.toMatchObject({ code: 'invalid_move' });
  });

  it('rename refuses to clobber and allows case-only renames of the same item', async () => {
    await files.upload(user, null, 'one.txt', body('1'), {});
    const two = await files.upload(user, null, 'two.txt', body('2'), {});
    await expect(files.update(user, two.id, { name: 'ONE.txt' })).rejects.toMatchObject({ code: 'name_conflict' });
    const r = await files.update(user, two.id, { name: 'Two.txt' });
    expect(r.name).toBe('Two.txt');
  });

  it('update with a stale etag fails with conflict', async () => {
    const f = await files.upload(user, null, 'a.txt', body('1'), {});
    await expect(files.update(user, f.id, { name: 'b.txt' }, { ifMatchEtag: 'v42' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('remove moves the subtree to /meta/trash and journals deletes', async () => {
    const a = await files.createFolder(user, null, 'A');
    await files.upload(user, a.id, 'x.txt', body('x'), {});
    const cursor = await ctx.app.get(JournalService).currentCursor(user.id);
    await files.remove(user, a.id);
    expect(await visible()).toEqual([]);
    const entry = await ctx.prisma.trashEntry.findFirstOrThrow();
    expect(entry.originalPath).toBe('A');
    expect(await readFile(path.join(entry.storePath, 'x.txt'), 'utf8')).toBe('x');
    expect(entry.storePath.startsWith(ctx.config.metaRoot)).toBe(true);
    const changes = await ctx.app.get(JournalService).changesSince(user.id, cursor, 100);
    expect(changes.entries).toHaveLength(2);
  });

  it('API writes produce no indexer echo', async () => {
    const a = await files.createFolder(user, null, 'A');
    await files.upload(user, a.id, 'x.txt', body('x'), {});
    await files.update(user, a.id, { name: 'B' });
    const journal = ctx.app.get(JournalService);
    const cursor = await journal.currentCursor(user.id);
    expect(await ctx.app.get(IndexerService).fullScan(user)).toMatchObject({ created: 0, updated: 0, moved: 0, deleted: 0 });
    expect(await journal.currentCursor(user.id)).toBe(cursor);
  });

  it('never leaves temp files in the user folder', async () => {
    await mkdir(path.join(root, 'sub'));
    await files.upload(user, null, 'a.txt', body('x'), {});
    expect((await visible()).filter((n) => n.startsWith('.synclet-tmp-'))).toEqual([]);
  });
});
```
Note: the "API writes produce no indexer echo" test creates `sub` on disk only in the last test, so it doesn't affect it. Run: `cd apps/server && pnpm jest src/files`
Expected: FAIL.

- [ ] **Step 2: Implement fs-ops**

`apps/server/src/files/fs-ops.ts`:
```ts
import { constants } from 'node:fs';
import { copyFile, cp, link, lstat, rename, rm } from 'node:fs/promises';

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;
const eexist = (dst: string) => Object.assign(new Error(`EEXIST: ${dst}`), { code: 'EEXIST' });

export async function statEntry(abs: string) {
  const st = await lstat(abs, { bigint: true });
  return { size: st.isDirectory() ? 0n : st.size, mtime: new Date(Number(st.mtimeMs)), ino: st.ino, dev: st.dev };
}

async function exists(p: string) {
  return lstat(p).then(() => true, (e) => (code(e) === 'ENOENT' ? false : Promise.reject(e)));
}

/** Atomically publishes `src` at `dst` without ever replacing an existing `dst`. `src` stays (caller unlinks). */
export async function linkNoReplace(src: string, dst: string): Promise<void> {
  try {
    await link(src, dst);
  } catch (e) {
    if (code(e) === 'EEXIST') throw eexist(dst);
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'ENOSYS'].includes(code(e) ?? '')) throw e;
    // File system without hard links (exFAT, some SMB): best-effort check + exclusive copy.
    if (await exists(dst)) throw eexist(dst);
    await copyFile(src, dst, constants.COPYFILE_EXCL).catch((err) => { throw code(err) === 'EEXIST' ? eexist(dst) : err; });
  }
}

/** Renames without replacing an existing target (small TOCTOU window; Node has no renameat2). */
export async function moveNoReplace(src: string, dst: string): Promise<void> {
  if (src.toLowerCase() !== dst.toLowerCase() && (await exists(dst))) throw eexist(dst);
  await rename(src, dst);
}

/** Moves a file or folder, falling back to copy + delete across file systems (e.g. /data -> /meta). */
export async function moveAcrossFs(src: string, dst: string): Promise<void> {
  try {
    await rename(src, dst);
  } catch (e) {
    if (code(e) !== 'EXDEV') throw e;
    await cp(src, dst, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    await rm(src, { recursive: true, force: true });
  }
}
```
(`moveNoReplace` skips the existence check for case-only renames, where `dst` resolves to `src` on case-insensitive file systems.)

- [ ] **Step 3: Implement FilesService**

`apps/server/src/files/files.service.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Item } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, utimes } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { APP_CONFIG, AppConfig } from '../config';
import { freeName, nameKey, tempName, validateName } from '../common/names';
import { absPath, joinRel, realpathInside, userRoot } from '../common/paths';
import { SyncError } from '../common/sync-error';
import type { IndexUser } from '../common/types';
import { BusyPaths } from '../journal/busy-paths';
import { ItemStore } from '../journal/item-store';
import { JournalService, Tx } from '../journal/journal.service';
import { PrismaService, TX_OPTS } from '../prisma/prisma.service';
import { linkNoReplace, moveAcrossFs, moveNoReplace, statEntry } from './fs-ops';

export type OnConflict = 'fail' | 'rename';

export function itemEtag(item: Item): string {
  return item.type === 'file' ? `v${item.version}` : `t${item.updatedAt.getTime()}`;
}

const isEexist = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'EEXIST';

@Injectable()
export class FilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
    private readonly store: ItemStore,
    private readonly busy: BusyPaths,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private abs(user: IndexUser, rel: string) { return absPath(this.config.dataRoot, user.username, rel); }

  private checkName(raw: string): string {
    const err = validateName(raw);
    if (err) throw new SyncError('invalid_name', `invalid name (${err})`);
    return raw.normalize('NFC');
  }

  private async parentPath(tx: Tx, user: IndexUser, parentId: string | null): Promise<string> {
    if (parentId === null) return '';
    const p = await this.store.getLive(tx, user.id, parentId);
    if (!p) throw new SyncError('not_found', 'parent not found');
    if (p.type !== 'folder') throw new SyncError('invalid_request', 'parent is not a folder');
    return p.path;
  }

  private async takenKeys(tx: Tx, user: IndexUser, parentId: string | null, excludeId?: string) {
    const sibs = await this.store.liveChildren(tx, user.id, parentId);
    return { sibs: sibs.filter((s) => s.id !== excludeId), keys: new Set(sibs.filter((s) => s.id !== excludeId).map((s) => s.nameKey)) };
  }

  /** Journals the item plus same-key siblings (their display names may change). */
  private async announce(tx: Tx, user: IndexUser, items: Item[], extra: { parentId: string | null; key: string }[] = []) {
    const ids = new Set(items.map((i) => i.id));
    const sibs: Item[] = [];
    for (const { parentId, key } of [...items.map((i) => ({ parentId: i.parentId, key: i.nameKey })), ...extra]) {
      sibs.push(...(await this.store.sameKeySiblings(tx, user.id, parentId, [key], ids)));
    }
    await this.journal.record(tx, user.id, [...items, ...sibs], 'upsert');
  }

  async createFolder(user: IndexUser, parentId: string | null, rawName: string, onConflict: OnConflict = 'fail'): Promise<Item> {
    const desired = this.checkName(rawName);
    return this.prisma.$transaction(async (tx) => {
      await this.journal.lockUser(tx, user.id);
      const parentRel = await this.parentPath(tx, user, parentId);
      const { sibs, keys } = await this.takenKeys(tx, user, parentId);
      let name = desired;
      for (let attempt = 0; ; attempt++) {
        if (keys.has(nameKey(name))) {
          if (onConflict === 'fail') throw new SyncError('name_conflict', 'name already exists', sibs.find((s) => s.nameKey === nameKey(name)));
          name = freeName(desired, keys, true);
        }
        try {
          await mkdir(this.abs(user, joinRel(parentRel, name)));
          break;
        } catch (e) {
          if (!isEexist(e) || attempt > 100) throw e;
          if (onConflict === 'fail') throw new SyncError('name_conflict', 'exists on disk');
          keys.add(nameKey(name)); // unindexed entry on disk – try the next free name
        }
      }
      const rel = joinRel(parentRel, name);
      const st = await statEntry(this.abs(user, rel));
      const item = await tx.item.create({
        data: { ownerId: user.id, parentId, type: 'folder', name, nameKey: nameKey(name), path: rel, size: 0n, mtime: st.mtime, ino: st.ino, dev: st.dev },
      });
      await this.announce(tx, user, [item]);
      return item;
    }, TX_OPTS);
  }

  /** Streams the body into a temp file in the user root (same file system as the target). */
  private async receive(user: IndexUser, body: Readable, modifiedAt?: Date | null): Promise<{ tmp: string; size: bigint; sha256: string }> {
    const tmp = path.join(userRoot(this.config.dataRoot, user.username), tempName(randomBytes(8).toString('hex')));
    const hash = createHash('sha256');
    let size = 0;
    const max = this.config.maxUploadBytes;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > max) { cb(Object.assign(new Error('too large'), { tooLarge: true })); return; }
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const fh = await open(tmp, 'wx', 0o666);
    try {
      await pipeline(body, meter, fh.createWriteStream({ autoClose: false }));
      await fh.sync();
    } catch (e) {
      await fh.close().catch(() => {});
      await rm(tmp, { force: true });
      if ((e as { tooLarge?: boolean }).tooLarge) throw new SyncError('too_large');
      throw e;
    }
    await fh.close();
    if (modifiedAt) await utimes(tmp, modifiedAt, modifiedAt);
    return { tmp, size: BigInt(size), sha256: hash.digest('hex') };
  }

  async upload(user: IndexUser, parentId: string | null, rawName: string, body: Readable, opts: { onConflict?: OnConflict; modifiedAt?: Date | null }): Promise<Item> {
    const desired = this.checkName(rawName);
    await this.prisma.$transaction((tx) => this.parentPath(tx, user, parentId)); // fail fast before streaming
    const { tmp, sha256 } = await this.receive(user, body, opts.modifiedAt);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.journal.lockUser(tx, user.id);
        const parentRel = await this.parentPath(tx, user, parentId);
        const { sibs, keys } = await this.takenKeys(tx, user, parentId);
        let name = desired;
        for (let attempt = 0; ; attempt++) {
          if (keys.has(nameKey(name))) {
            if (opts.onConflict !== 'rename') throw new SyncError('name_conflict', 'name already exists', sibs.find((s) => s.nameKey === nameKey(name)));
            name = freeName(desired, keys, false);
          }
          try {
            await linkNoReplace(tmp, this.abs(user, joinRel(parentRel, name)));
            break;
          } catch (e) {
            if (!isEexist(e) || attempt > 100) throw e;
            if (opts.onConflict !== 'rename') throw new SyncError('name_conflict', 'exists on disk');
            keys.add(nameKey(name));
          }
        }
        const rel = joinRel(parentRel, name);
        const st = await statEntry(this.abs(user, rel));
        const item = await tx.item.create({
          data: { ownerId: user.id, parentId, type: 'file', name, nameKey: nameKey(name), path: rel, size: st.size, mtime: st.mtime, ino: st.ino, dev: st.dev, contentHash: sha256 },
        });
        await this.announce(tx, user, [item]);
        return item;
      }, TX_OPTS);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async replaceContent(user: IndexUser, itemId: string, body: Readable, opts: { ifMatchVersion: number; modifiedAt?: Date | null }): Promise<Item> {
    const pre = await this.prisma.item.findFirst({ where: { id: itemId, ownerId: user.id, deletedAt: null } });
    if (!pre || pre.type !== 'file') throw new SyncError('not_found');
    if (pre.version !== opts.ifMatchVersion) throw new SyncError('conflict', 'version mismatch', pre);
    const { tmp, sha256 } = await this.receive(user, body, opts.modifiedAt);
    try {
      // The transaction returns the conflict instead of throwing, so the recorded
      // external version is committed before the 412 goes out.
      const outcome = await this.prisma.$transaction(async (tx) => {
        await this.journal.lockUser(tx, user.id);
        const item = await this.store.getLive(tx, user.id, itemId);
        if (!item) throw new SyncError('not_found');
        const target = this.abs(user, item.path);
        const disk = await statEntry(target).catch(() => null);
        if (disk && (disk.size !== item.size || disk.mtime.getTime() !== item.mtime.getTime())) {
          // Edited on the host but not yet indexed: record that version, then report the conflict.
          const fresh = await tx.item.update({
            where: { id: item.id },
            data: { size: disk.size, mtime: disk.mtime, ino: disk.ino, dev: disk.dev, contentHash: null, version: { increment: 1 } },
          });
          await this.journal.record(tx, user.id, [fresh], 'upsert');
          return { conflict: fresh, reason: 'file changed on disk' } as const;
        }
        if (item.version !== opts.ifMatchVersion) return { conflict: item, reason: 'version mismatch' } as const;
        await rename(tmp, target); // atomic replace
        const st = await statEntry(target);
        const updated = await tx.item.update({
          where: { id: item.id },
          data: { size: st.size, mtime: st.mtime, ino: st.ino, dev: st.dev, contentHash: sha256, version: { increment: 1 } },
        });
        await this.journal.record(tx, user.id, [updated], 'upsert');
        return { ok: updated } as const;
      }, TX_OPTS);
      if ('conflict' in outcome) throw new SyncError('conflict', outcome.reason, outcome.conflict);
      return outcome.ok;
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async update(user: IndexUser, itemId: string, patch: { name?: string; parentId?: string | null }, opts: { ifMatchEtag?: string } = {}): Promise<Item> {
    const newName = patch.name === undefined ? undefined : this.checkName(patch.name);
    return this.prisma.$transaction(async (tx) => {
      await this.journal.lockUser(tx, user.id);
      const item = await this.store.getLive(tx, user.id, itemId);
      if (!item) throw new SyncError('not_found');
      if (opts.ifMatchEtag && opts.ifMatchEtag !== itemEtag(item)) throw new SyncError('conflict', 'etag mismatch', item);
      const targetParent = patch.parentId === undefined ? item.parentId : patch.parentId;
      const name = newName ?? item.name;
      if (targetParent === item.parentId && name === item.name) return item;
      const parentRel = await this.parentPath(tx, user, targetParent);
      if (item.type === 'folder' && (parentRel === item.path || parentRel.startsWith(item.path + '/'))) {
        throw new SyncError('invalid_move', 'cannot move a folder into itself');
      }
      const { sibs, keys } = await this.takenKeys(tx, user, targetParent, item.id);
      if (keys.has(nameKey(name))) throw new SyncError('name_conflict', 'name already exists', sibs.find((s) => s.nameKey === nameKey(name)));
      const rel = joinRel(parentRel, name);
      try {
        await moveNoReplace(this.abs(user, item.path), this.abs(user, rel));
      } catch (e) {
        if (isEexist(e)) throw new SyncError('name_conflict', 'exists on disk');
        throw e;
      }
      const updated = await tx.item.update({ where: { id: item.id }, data: { parentId: targetParent, name, nameKey: nameKey(name), path: rel } });
      if (item.type === 'folder') await this.store.rewritePrefix(tx, user.id, item.path, rel);
      await this.announce(tx, user, [updated], [{ parentId: item.parentId, key: item.nameKey }]);
      return updated;
    }, TX_OPTS);
  }

  async remove(user: IndexUser, itemId: string): Promise<void> {
    const trashId = randomUUID();
    const storeDir = path.join(this.config.metaRoot, 'trash', trashId);
    let item!: Item;
    let release = () => {};
    await this.prisma.$transaction(async (tx) => {
      await this.journal.lockUser(tx, user.id);
      const found = await this.store.getLive(tx, user.id, itemId);
      if (!found) throw new SyncError('not_found');
      item = found;
      const gone = await this.store.tombstoneSubtree(tx, item);
      await tx.trashEntry.create({
        data: {
          id: trashId, ownerId: user.id, itemId: item.id, type: item.type, name: item.name, originalPath: item.path,
          size: gone.reduce((s, i) => s + i.size, 0n), storePath: path.join(storeDir, item.name),
          manifest: gone.map((i) => ({ id: i.id, type: i.type, path: i.path })),
        },
      });
      await this.journal.record(tx, user.id, gone, 'delete');
      const sibs = await this.store.sameKeySiblings(tx, user.id, item.parentId, [item.nameKey], new Set([item.id]));
      await this.journal.record(tx, user.id, sibs, 'upsert');
      release = this.busy.add(user.id, item.path); // keep the indexer away until the move finished
    }, TX_OPTS);
    try {
      await mkdir(storeDir, { recursive: true });
      await moveAcrossFs(this.abs(user, item.path), path.join(storeDir, item.name));
    } finally {
      release();
    }
  }

  async openRead(user: IndexUser, itemId: string): Promise<{ item: Item; abs: string }> {
    const item = await this.prisma.item.findFirst({ where: { id: itemId, ownerId: user.id, deletedAt: null } });
    if (!item) throw new SyncError('not_found');
    if (item.type !== 'file') throw new SyncError('invalid_request', 'not a file');
    try {
      const abs = await realpathInside(this.abs(user, item.path), userRoot(this.config.dataRoot, user.username));
      return { item, abs };
    } catch {
      throw new SyncError('not_found');
    }
  }
}
```
`apps/server/src/files/files.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { FilesService } from './files.service';

@Module({ providers: [FilesService], exports: [FilesService] })
export class FilesModule {}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && pnpm jest src/files && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/files
git commit -m "feat(server): atomic non-clobbering file operations with trash and journal

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Sync API v1 controller

**Files:**
- Create: `apps/server/src/sync/{sync-ids.ts,range.ts,serializer.service.ts,sync.controller.ts,devices.controller.ts}`
- Modify: `apps/server/src/sync/sync.module.ts` (replace stub)
- Test: `apps/server/src/sync/range.spec.ts`, `apps/server/src/sync/sync-ids.spec.ts`, `apps/server/src/sync/sync.e2e.spec.ts`

**Interfaces:**
- Consumes: `AuthGuard`, `CurrentUser`, `AllowDownloadToken`, `AuthService.signDownloadToken`, `DevicesService`, `ServerConfigService` (Task 3); `JournalService`, `ItemStore` (Task 4); `FilesService`, `itemEtag` (Task 6); `assignDisplayNames` (Task 2); `SyncErrorFilter.serializeItem` hook (Task 1).
- Produces (HTTP, all under `/api/sync/v1`, all guarded by `AuthGuard`):
  - `POST /devices` `{name, platform, appVersion, installationId?}` → 201 `{device, token, account}`; `GET /devices`; `DELETE /devices/current` → 204; `DELETE /devices/:id` → 204; `PUT /devices/current/push` → 204 (accepted, no-op until Phase 3)
  - `GET /account` → `SyncAccount`; `GET /cursor` → `{cursor}`
  - `GET /changes?cursor=&limit=` (default 500, max 1000) → `SyncChangesPage`
  - `GET /items/:id` → `SyncItem`; `GET /items/:id/children?pageToken=&limit=` → `SyncChildrenPage`
  - `GET /items/:id/content` (Range, If-None-Match, `?download=1` → `Content-Disposition: attachment`; `@AllowDownloadToken`)
  - `POST /items/:id/download-token` → `{ url: "/api/sync/v1/items/<id>/content?download=1&dt=<jwt>" }`
  - `PUT /items/:id/content` (raw body, `If-Match` required → 428) → `SyncItem`
  - `POST /items/upload?parentId=&name=&onConflict=` (raw body) → 201 `SyncItem`
  - `POST /items` `{parentId, type:'folder', name, onConflict?}` → 201; `PATCH /items/:id` `{name?, parentId?}` + optional `If-Match`; `DELETE /items/:id` → 204
  - Headers accepted: `X-Synclet-Modified-At` or `X-Buro-Modified-At` (ISO) → `modifiedAt`
  - `SerializerService.toSyncItems(user: IndexUser, rows: Item[]): Promise<SyncItem[]>`, `rootItem(user)`
  - `parseSyncId(raw): { kind: 'root' } | { kind: 'folder' | 'file'; uuid: string } | null`, `toSyncId(item)`, `parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null`

- [ ] **Step 1: Unit tests for ids and range**

`apps/server/src/sync/sync-ids.spec.ts`:
```ts
import { parseSyncId, toSyncId } from './sync-ids';

const uuid = '3f2b8c1e-1d2a-4c3b-9a8b-0123456789ab';
it('parses and formats sync ids', () => {
  expect(parseSyncId('root')).toEqual({ kind: 'root' });
  expect(parseSyncId(`d_${uuid}`)).toEqual({ kind: 'folder', uuid });
  expect(parseSyncId(`f_${uuid}`)).toEqual({ kind: 'file', uuid });
  expect(parseSyncId('f_not-a-uuid')).toBeNull();
  expect(parseSyncId('personal')).toBeNull();
  expect(toSyncId({ id: uuid, type: 'folder' })).toBe(`d_${uuid}`);
});
```
`apps/server/src/sync/range.spec.ts`:
```ts
import { parseRange } from './range';

it.each([
  [undefined, 100, null],
  ['bytes=0-9', 100, { start: 0, end: 9 }],
  ['bytes=90-', 100, { start: 90, end: 99 }],
  ['bytes=-10', 100, { start: 90, end: 99 }],
  ['bytes=50-500', 100, { start: 50, end: 99 }],
  ['bytes=100-', 100, 'invalid'],
  ['bytes=5-1', 100, 'invalid'],
  ['bytes=0-1,5-6', 100, null],
  ['items=0-1', 100, null],
  ['bytes=0-0', 0, 'invalid'],
])('parseRange(%j, %d)', (h, size, expected) => {
  expect(parseRange(h as string | undefined, size)).toEqual(expected);
});
```
(Multi-range and non-bytes units are ignored → full response, as allowed by RFC 9110.)

- [ ] **Step 2: Implement ids + range**

`apps/server/src/sync/sync-ids.ts`:
```ts
import type { ItemType } from '@prisma/client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ROOT_ID = 'root';

export type ParsedSyncId = { kind: 'root' } | { kind: 'folder' | 'file'; uuid: string };

export function parseSyncId(raw: string | undefined | null): ParsedSyncId | null {
  const id = (raw ?? '').trim();
  if (id === ROOT_ID) return { kind: 'root' };
  const prefix = id.slice(0, 2);
  const uuid = id.slice(2);
  if (!UUID.test(uuid)) return null;
  if (prefix === 'd_') return { kind: 'folder', uuid };
  if (prefix === 'f_') return { kind: 'file', uuid };
  return null;
}

export function toSyncId(item: { id: string; type: ItemType }): string {
  return (item.type === 'folder' ? 'd_' : 'f_') + item.id;
}
```
`apps/server/src/sync/range.ts`:
```ts
/** Single byte range per RFC 9110; returns null for "send the whole file". */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  let start: number; let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(a); end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}
```
Run: `cd apps/server && pnpm jest src/sync/range.spec.ts src/sync/sync-ids.spec.ts`
Expected: PASS.

- [ ] **Step 3: Write failing E2E tests for the controller**

`apps/server/src/sync/sync.e2e.spec.ts`:
```ts
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, TestContext } from '../../test/context';
import { IndexerService } from '../indexer/indexer.service';

describe('Sync API v1', () => {
  let ctx: TestContext; let token: string; let userId: string;
  const api = (method: string, url: string, opts: { payload?: unknown; headers?: Record<string, string>; body?: Buffer | string } = {}) =>
    ctx.app.inject({
      method: method as 'GET', url: `/api/sync/v1${url}`,
      headers: { authorization: `Bearer ${token}`, ...(opts.body !== undefined ? { 'content-type': 'application/octet-stream' } : {}), ...opts.headers },
      ...(opts.body !== undefined ? { body: opts.body } : opts.payload !== undefined ? { payload: opts.payload as object } : {}),
    });

  beforeEach(async () => {
    ctx = await createTestApp();
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
    token = res.json().accessToken; userId = res.json().user.id;
  });
  afterEach(async () => { await ctx.close(); });

  it('registers a device and returns account + token', async () => {
    const res = await api('POST', '/devices', { payload: { name: 'Mac', platform: 'macos', appVersion: '1.0' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toMatch(/^syd_/);
    expect(res.json().account).toMatchObject({ userId, slug: 'jens', canWrite: true, cursor: '0' });
    expect(res.json().account.organizationId).toMatch(new RegExp(`:${userId}$`));
  });

  it('root item and children with folders first and pagination', async () => {
    expect((await api('GET', '/items/root')).json()).toMatchObject({ id: 'root', parentId: null, kind: 'root', type: 'folder' });
    for (const n of ['b.txt', 'a.txt', 'c.txt']) await api('POST', `/items/upload?parentId=root&name=${n}`, { body: 'x' });
    await api('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: 'Z' } });
    const p1 = (await api('GET', '/items/root/children?limit=2')).json();
    expect(p1.items[0].type).toBe('folder');
    expect(p1.nextPageToken).toBeTruthy();
    const p2 = (await api('GET', `/items/root/children?limit=2&pageToken=${p1.nextPageToken}`)).json();
    expect([...p1.items, ...p2.items].map((i: { name: string }) => i.name).sort()).toEqual(['Z', 'a.txt', 'b.txt', 'c.txt']);
    expect(p2.nextPageToken).toBeNull();
  });

  it('upload, download with range and etags, replace with If-Match', async () => {
    const up = await api('POST', '/items/upload?parentId=root&name=hello.txt', { body: 'hello world' });
    expect(up.statusCode).toBe(201);
    const item = up.json();
    expect(item).toMatchObject({ kind: 'file', name: 'hello.txt', size: 11, version: 1, etag: 'v1', contentEtag: 'v1', mime: 'text/plain' });
    const dl = await api('GET', `/items/${item.id}/content`);
    expect(dl.body).toBe('hello world');
    expect(dl.headers.etag).toBe('"v1"');
    expect(dl.headers['accept-ranges']).toBe('bytes');
    const part = await api('GET', `/items/${item.id}/content`, { headers: { range: 'bytes=6-' } });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('world');
    expect(part.headers['content-range']).toBe('bytes 6-10/11');
    expect((await api('GET', `/items/${item.id}/content`, { headers: { range: 'bytes=50-' } })).statusCode).toBe(416);
    expect((await api('GET', `/items/${item.id}/content`, { headers: { 'if-none-match': '"v1"' } })).statusCode).toBe(304);
    expect((await api('PUT', `/items/${item.id}/content`, { body: 'new' })).json().code).toBe('precondition_required');
    const stale = await api('PUT', `/items/${item.id}/content`, { body: 'new', headers: { 'if-match': '"v9"' } });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().item).toMatchObject({ id: item.id, version: 1 });
    const ok = await api('PUT', `/items/${item.id}/content`, { body: 'new', headers: { 'if-match': '"v1"' } });
    expect(ok.json()).toMatchObject({ version: 2, size: 3 });
  });

  it('download token works without Authorization header', async () => {
    const item = (await api('POST', '/items/upload?parentId=root&name=a.pdf', { body: '%PDF' })).json();
    const { url } = (await api('POST', `/items/${item.id}/download-token`)).json();
    const res = await ctx.app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain("filename*=UTF-8''a.pdf");
  });

  it('409 name_conflict carries the existing item; onConflict=rename picks a free name', async () => {
    await api('POST', '/items/upload?parentId=root&name=a.txt', { body: '1' });
    const conflict = await api('POST', '/items/upload?parentId=root&name=A.TXT', { body: '2' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().item.name).toBe('a.txt');
    const renamed = await api('POST', '/items/upload?parentId=root&name=A.TXT&onConflict=rename', { body: '2' });
    expect(renamed.json().name).toBe('A (2).TXT');
  });

  it('patch renames/moves and delete removes; changes reflect everything', async () => {
    const c0 = (await api('GET', '/cursor')).json().cursor;
    const folder = (await api('POST', '/items', { payload: { parentId: 'root', type: 'folder', name: 'Docs' } })).json();
    const file = (await api('POST', '/items/upload?parentId=root&name=x.txt', { body: 'x' })).json();
    const moved = await api('PATCH', `/items/${file.id}`, { payload: { name: 'y.txt', parentId: folder.id } });
    expect(moved.json()).toMatchObject({ id: file.id, name: 'y.txt', parentId: folder.id });
    expect((await api('DELETE', `/items/${folder.id}`)).statusCode).toBe(204);
    const page = (await api('GET', `/changes?cursor=${c0}`)).json();
    expect(page.changes).toEqual(expect.arrayContaining([{ op: 'delete', id: folder.id }, { op: 'delete', id: file.id }]));
    expect((await api('GET', `/items/${file.id}`)).statusCode).toBe(404);
  });

  it('changes include external edits picked up by the indexer', async () => {
    const c0 = (await api('GET', '/cursor')).json().cursor;
    await writeFile(path.join(ctx.config.dataRoot, 'jens', 'external.md'), '# hi');
    await ctx.app.get(IndexerService).fullScan({ id: userId, username: 'jens' });
    const page = (await api('GET', `/changes?cursor=${c0}`)).json();
    expect(page.changes).toEqual([expect.objectContaining({ op: 'upsert', item: expect.objectContaining({ name: 'external.md', parentId: 'root' }) })]);
  });

  it('410 for expired cursors, 400 for unknown ids, 404 for other users items', async () => {
    expect((await api('GET', '/changes?cursor=999')).json().code).toBe('cursor_expired');
    expect((await api('GET', '/items/bogus')).statusCode).toBe(400);
    expect((await api('GET', '/items/f_3f2b8c1e-1d2a-4c3b-9a8b-0123456789ab')).statusCode).toBe(404);
  });

  it('children of a file is invalid_request', async () => {
    const f = (await api('POST', '/items/upload?parentId=root&name=a.txt', { body: '1' })).json();
    expect((await api('GET', `/items/${f.id}/children`)).json().code).toBe('invalid_request');
  });

  it('accepts X-Buro-Modified-At as alias', async () => {
    const f = (await api('POST', '/items/upload?parentId=root&name=t.txt', { body: '1', headers: { 'x-buro-modified-at': '2023-01-02T03:04:05.000Z' } })).json();
    expect(f.modifiedAt).toBe('2023-01-02T03:04:05.000Z');
  });
});
```
Run: `cd apps/server && pnpm jest src/sync/sync.e2e.spec.ts`
Expected: FAIL.

- [ ] **Step 4: Implement serializer**

`apps/server/src/sync/serializer.service.ts`:
```ts
import { Injectable } from '@nestjs/common';
import type { Item } from '@prisma/client';
import type { SyncItem } from '@synclet/shared';
import { lookup } from 'mime-types';
import { assignDisplayNames } from '../common/names';
import type { IndexUser } from '../common/types';
import { itemEtag } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { ROOT_ID, toSyncId } from './sync-ids';

const CAPS = { read: true as const, write: true, rename: true, move: true, delete: true, addChildren: true };

@Injectable()
export class SerializerService {
  constructor(private readonly prisma: PrismaService) {}

  rootItem(user: IndexUser): SyncItem {
    const epoch = new Date(0).toISOString();
    return {
      id: ROOT_ID, parentId: null, type: 'folder', kind: 'root', name: user.username, size: 0, mime: null, version: null,
      sha256: null, etag: 't0', contentEtag: null, createdAt: epoch, modifiedAt: epoch, documentId: null,
      capabilities: { ...CAPS, rename: false, move: false, delete: false },
    };
  }

  /** Serializes rows; display names are computed against all live siblings of each parent. */
  async toSyncItems(user: IndexUser, rows: Item[]): Promise<SyncItem[]> {
    const parents = [...new Set(rows.map((r) => r.parentId))];
    const display = new Map<string, string>();
    for (const parentId of parents) {
      const sibs = await this.prisma.item.findMany({
        where: { ownerId: user.id, parentId, deletedAt: null },
        select: { id: true, name: true, type: true, createdAt: true },
      });
      for (const [id, name] of assignDisplayNames(sibs)) display.set(id, name);
    }
    return rows.map((r) => this.one(r, display.get(r.id) ?? r.name));
  }

  private one(r: Item, name: string): SyncItem {
    const isFile = r.type === 'file';
    return {
      id: toSyncId(r),
      parentId: r.parentId ? `d_${r.parentId}` : ROOT_ID,
      type: r.type, kind: r.type, name,
      size: isFile ? Number(r.size) : 0,
      mime: isFile ? lookup(r.name) || 'application/octet-stream' : null,
      version: isFile ? r.version : null,
      sha256: isFile ? r.contentHash : null,
      etag: itemEtag(r),
      contentEtag: isFile ? `v${r.version}` : null,
      createdAt: r.createdAt.toISOString(),
      modifiedAt: r.mtime.toISOString(),
      documentId: isFile ? toSyncId(r) : null,
      capabilities: { ...CAPS, addChildren: !isFile },
    };
  }
}
```

- [ ] **Step 5: Implement controllers and module**

`apps/server/src/sync/devices.controller.ts`:
```ts
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { DevicesService } from '../auth/devices.service';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { SyncController } from './sync.controller';

const RegisterBody = z.object({
  name: z.string().min(1).max(100),
  platform: z.enum(['ios', 'android', 'macos', 'windows', 'linux', 'web']),
  appVersion: z.string().min(1).max(40),
  installationId: z.string().max(128).optional(),
});

@Controller('sync/v1/devices')
@UseGuards(AuthGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService, private readonly sync: SyncController) {}

  @Post()
  @HttpCode(201)
  async register(@CurrentUser() user: AuthUser, @Body(new ZodPipe(RegisterBody)) body: z.infer<typeof RegisterBody>) {
    const { device, token } = await this.devices.register(user, body);
    return { device: this.devices.toWire(device), token, account: await this.sync.account(user) };
  }

  @Get()
  async list(@CurrentUser() user: AuthUser) {
    return (await this.devices.list(user.id)).map((d) => this.devices.toWire(d, user.deviceId));
  }

  @Delete('current')
  @HttpCode(204)
  async revokeCurrent(@CurrentUser() user: AuthUser) {
    if (!user.deviceId) throw new SyncError('invalid_request', 'not a device token');
    await this.devices.revoke(user.id, user.deviceId);
  }

  @Put('current/push')
  @HttpCode(204)
  push() {
    // Accepted for client compatibility; APNs pushes arrive in Phase 3.
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.devices.revoke(user.id, id);
  }
}
```

`apps/server/src/sync/sync.controller.ts`:
```ts
import { Body, Controller, Delete, Get, Headers, HttpCode, Inject, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Item } from '@prisma/client';
import type { SyncAccount, SyncChange, SyncItem } from '@synclet/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import { AuthService } from '../auth/auth.service';
import { AllowDownloadToken, CurrentUser } from '../auth/current-user.decorator';
import { ServerConfigService } from '../auth/server-config.service';
import { APP_CONFIG, AppConfig } from '../config';
import { SyncError } from '../common/sync-error';
import type { AuthUser } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { FilesService, OnConflict } from '../files/files.service';
import { JournalService } from '../journal/journal.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseRange } from './range';
import { SerializerService } from './serializer.service';
import { parseSyncId, ROOT_ID } from './sync-ids';

const CreateBody = z.object({ parentId: z.string(), type: z.literal('folder'), name: z.string(), onConflict: z.enum(['fail', 'rename']).optional() });
const PatchBody = z.object({ name: z.string().optional(), parentId: z.string().optional() });

const unquote = (v: string | undefined) => v?.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
const modifiedAt = (h: Record<string, string | string[] | undefined>) => {
  const raw = (h['x-synclet-modified-at'] ?? h['x-buro-modified-at']) as string | undefined;
  const d = raw ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};
const asStream = (body: unknown): Readable => {
  if (body instanceof Readable) return body;
  const empty = new PassThrough(); empty.end(); return empty; // Content-Length 0: parser not invoked
};

@Controller('sync/v1')
@UseGuards(AuthGuard)
export class SyncController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly journal: JournalService,
    private readonly serializer: SerializerService,
    private readonly serverConfig: ServerConfigService,
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Resolves a sync id to a live row (null for root). */
  private async resolve(user: AuthUser, rawId: string): Promise<Item | null> {
    const parsed = parseSyncId(rawId);
    if (!parsed) throw new SyncError('invalid_request', 'invalid id');
    if (parsed.kind === 'root') return null;
    const row = await this.prisma.item.findFirst({ where: { id: parsed.uuid, ownerId: user.id, deletedAt: null, type: parsed.kind } });
    if (!row) throw new SyncError('not_found');
    return row;
  }

  private async resolveParent(user: AuthUser, rawId: string): Promise<string | null> {
    const row = await this.resolve(user, rawId);
    if (row && row.type !== 'folder') throw new SyncError('invalid_request', 'parent is not a folder');
    return row?.id ?? null;
  }

  private async one(user: AuthUser, row: Item): Promise<SyncItem> {
    return (await this.serializer.toSyncItems(user, [row]))[0];
  }

  @Get('account')
  async account(@CurrentUser() user: AuthUser): Promise<SyncAccount> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const used = await this.prisma.item.aggregate({ where: { ownerId: user.id, deletedAt: null }, _sum: { size: true } });
    const { serverId } = await this.serverConfig.get();
    return {
      userId: u.id, email: u.email, displayName: u.displayName,
      organizationId: `${serverId}:${u.id}`, organizationName: 'Synclet', slug: u.username,
      canWrite: true, areas: { personal: true, shared: false, customers: false, projects: false },
      quotaBytes: 0, usedBytes: Number(used._sum.size ?? 0n), maxUploadBytes: this.config.maxUploadBytes,
      cursor: await this.journal.currentCursor(user.id),
    };
  }

  @Get('cursor')
  async cursor(@CurrentUser() user: AuthUser) {
    return { cursor: await this.journal.currentCursor(user.id) };
  }

  @Get('changes')
  async changes(@CurrentUser() user: AuthUser, @Query('cursor') cursor = '', @Query('limit') limitRaw?: string) {
    const limit = Math.min(Math.max(Number(limitRaw) || 500, 1), 1000);
    const page = await this.journal.changesSince(user.id, cursor, limit);
    const ids = page.entries.map((e) => e.itemId);
    const rows = await this.prisma.item.findMany({ where: { id: { in: ids }, ownerId: user.id, deletedAt: null } });
    const live = new Map((await this.serializer.toSyncItems(user, rows)).map((s, i) => [rows[i].id, s]));
    const changes: SyncChange[] = page.entries.map((e) => {
      const item = live.get(e.itemId);
      return item ? { op: 'upsert', item } : { op: 'delete', id: (e.itemType === 'folder' ? 'd_' : 'f_') + e.itemId };
    });
    return { changes, cursor: page.cursor, hasMore: page.hasMore };
  }

  @Get('items/:id')
  async item(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const row = await this.resolve(user, id);
    return row ? this.one(user, row) : this.serializer.rootItem(user);
  }

  @Get('items/:id/children')
  async children(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('pageToken') pageToken?: string, @Query('limit') limitRaw?: string) {
    const cursor = await this.journal.currentCursor(user.id); // state before reading the first page
    const parent = await this.resolve(user, id);
    if (parent && parent.type !== 'folder') throw new SyncError('invalid_request', 'not a folder');
    const limit = Math.min(Math.max(Number(limitRaw) || 500, 1), 1000);
    // Keyset: "<0|1>:<uuid>" – folders (0) before files (1), then by id.
    const [rankRaw, afterId] = pageToken ? pageToken.split(':') : ['', ''];
    const rank = rankRaw === '' ? -1 : Number(rankRaw);
    const where = { ownerId: user.id, parentId: parent?.id ?? null, deletedAt: null };
    const folders = rank <= 0
      ? await this.prisma.item.findMany({ where: { ...where, type: 'folder', ...(rank === 0 ? { id: { gt: afterId } } : {}) }, orderBy: { id: 'asc' }, take: limit + 1 })
      : [];
    const remaining = limit + 1 - folders.length;
    const filesRows = remaining > 0
      ? await this.prisma.item.findMany({ where: { ...where, type: 'file', ...(rank === 1 ? { id: { gt: afterId } } : {}) }, orderBy: { id: 'asc' }, take: remaining })
      : [];
    const all = [...folders, ...filesRows];
    const pageRows = all.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    const nextPageToken = all.length > limit && last ? `${last.type === 'folder' ? 0 : 1}:${last.id}` : null;
    return { items: await this.serializer.toSyncItems(user, pageRows), nextPageToken, cursor };
  }

  @Post('items/:id/download-token')
  async downloadToken(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const row = await this.resolve(user, id);
    if (!row || row.type !== 'file') throw new SyncError('invalid_request', 'not a file');
    const dt = await this.auth.signDownloadToken(user.id, id);
    return { url: `/api/sync/v1/items/${id}/content?download=1&dt=${encodeURIComponent(dt)}` };
  }

  @Get('items/:id/content')
  @AllowDownloadToken()
  async content(@CurrentUser() user: AuthUser, @Param('id') id: string, @Query('download') download: string | undefined, @Req() req: FastifyRequest, @Res() reply: FastifyReply) {
    const parsed = parseSyncId(id);
    if (!parsed || parsed.kind !== 'file') throw new SyncError('invalid_request', 'not a file');
    const { item, abs } = await this.files.openRead(user, parsed.uuid);
    const size = Number(item.size);
    const etag = `"v${item.version}"`;
    reply.header('ETag', etag).header('Accept-Ranges', 'bytes').header('Last-Modified', item.mtime.toUTCString());
    reply.header('Content-Type', (await this.one(user, item)).mime ?? 'application/octet-stream');
    if (download === '1') reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`);
    if (unquote(req.headers['if-none-match']) === `v${item.version}`) return reply.status(304).send();
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      return reply.status(416).header('Content-Range', `bytes */${size}`).send({ statusCode: 416, message: 'range not satisfiable', code: 'range_not_satisfiable' });
    }
    if (range) {
      reply.status(206).header('Content-Range', `bytes ${range.start}-${range.end}/${size}`).header('Content-Length', range.end - range.start + 1);
      return reply.send(createReadStream(abs, { start: range.start, end: range.end }));
    }
    reply.header('Content-Length', size);
    return reply.send(createReadStream(abs));
  }

  @Put('items/:id/content')
  async replace(@CurrentUser() user: AuthUser, @Param('id') id: string, @Headers() headers: Record<string, string>, @Body() body: unknown) {
    const parsed = parseSyncId(id);
    if (!parsed || parsed.kind !== 'file') throw new SyncError('invalid_request', 'not a file');
    const ifMatch = unquote(headers['if-match']);
    if (!ifMatch) throw new SyncError('precondition_required', 'If-Match required');
    const m = /^v(\d+)$/.exec(ifMatch);
    if (!m) throw new SyncError('conflict', 'unknown etag', (await this.prisma.item.findFirst({ where: { id: parsed.uuid, ownerId: user.id, deletedAt: null } })) ?? undefined);
    const row = await this.files.replaceContent(user, parsed.uuid, asStream(body), { ifMatchVersion: Number(m[1]), modifiedAt: modifiedAt(headers) });
    return this.one(user, row);
  }

  @Post('items/upload')
  @HttpCode(201)
  async upload(@CurrentUser() user: AuthUser, @Query('parentId') parentId = ROOT_ID, @Query('name') name = '', @Query('onConflict') onConflict: OnConflict = 'fail', @Headers() headers: Record<string, string>, @Body() body: unknown) {
    if (onConflict !== 'fail' && onConflict !== 'rename') throw new SyncError('invalid_request', 'invalid onConflict');
    const pid = await this.resolveParent(user, parentId);
    const row = await this.files.upload(user, pid, name, asStream(body), { onConflict, modifiedAt: modifiedAt(headers) });
    return this.one(user, row);
  }

  @Post('items')
  @HttpCode(201)
  async create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    const pid = await this.resolveParent(user, body.parentId);
    return this.one(user, await this.files.createFolder(user, pid, body.name, body.onConflict ?? 'fail'));
  }

  @Patch('items/:id')
  async patch(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodPipe(PatchBody)) body: z.infer<typeof PatchBody>, @Headers('if-match') ifMatch?: string) {
    const row = await this.resolve(user, id);
    if (!row) throw new SyncError('forbidden', 'root cannot be changed');
    const current = await this.one(user, row);
    // Sending the current display name (possibly with a "(2)" suffix) keeps the stored name.
    const name = body.name === undefined || body.name === current.name ? undefined : body.name;
    const parentId = body.parentId === undefined ? undefined : await this.resolveParent(user, body.parentId);
    return this.one(user, await this.files.update(user, row.id, { name, parentId }, { ifMatchEtag: unquote(ifMatch) }));
  }

  @Delete('items/:id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    const row = await this.resolve(user, id);
    if (!row) throw new SyncError('forbidden', 'root cannot be deleted');
    await this.files.remove(user, row.id);
  }
}
```

`apps/server/src/sync/sync.module.ts`:
```ts
import { Module, OnModuleInit } from '@nestjs/common';
import type { Item } from '@prisma/client';
import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { SyncErrorFilter } from '../common/sync-error';
import { PrismaService } from '../prisma/prisma.service';
import { DevicesController } from './devices.controller';
import { SerializerService } from './serializer.service';
import { SyncController } from './sync.controller';

@Module({
  imports: [AuthModule, FilesModule],
  controllers: [SyncController, DevicesController],
  providers: [SerializerService, SyncController],
  exports: [SerializerService],
})
export class SyncModule implements OnModuleInit {
  constructor(private readonly serializer: SerializerService, private readonly prisma: PrismaService) {}

  onModuleInit() {
    SyncErrorFilter.serializeItem = async (row: Item) => {
      const owner = await this.prisma.user.findUniqueOrThrow({ where: { id: row.ownerId } });
      return (await this.serializer.toSyncItems({ id: owner.id, username: owner.username }, [row]))[0];
    };
  }
}
```
(`SyncController` is listed as provider so `DevicesController` can reuse `account()`.)

- [ ] **Step 6: Run tests**

Run: `cd apps/server && pnpm test && pnpm typecheck`
Expected: all server tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/sync
git commit -m "feat(server): Buro-compatible Sync API v1 (items, content, changes, devices)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Watcher, scheduler, startup cleanup, status endpoint

**Files:**
- Create: `apps/server/src/indexer/{watcher.service.ts,scheduler.service.ts,status.controller.ts,debounce.ts}`
- Modify: `apps/server/src/indexer/indexer.module.ts`
- Test: `apps/server/src/indexer/debounce.spec.ts`, `apps/server/src/indexer/watcher.spec.ts`, `apps/server/src/indexer/scheduler.spec.ts`

**Interfaces:**
- Consumes: `IndexerService` (Task 5), `JournalService`, `ItemStore` (Task 4), `AuthGuard`, `AdminOnly` (Task 3), `AppEvents`, `APP_CONFIG`, `isIgnored`, `isTempName` (Task 2).
- Produces:
  - `DirDebouncer` (`debounce.ts`): `new DirDebouncer(run: (key: string, recursive: boolean) => Promise<void>, quietMs = 2000, maxMs = 10000)`, `.push(key: string, recursive: boolean)`, `.flushAll(): Promise<void>`, `.stop()`
  - `WatcherService` (OnApplicationBootstrap/OnModuleDestroy): `mode: 'active' | 'scan-only' | 'off'`, `handleEvents(events: { type: 'create' | 'update' | 'delete'; path: string }[]): void` (public for tests), `flush(): Promise<void>`
  - `SchedulerService`: `startupCleanup(): Promise<number>` (deletes stale `.synclet-tmp-*` in every user root), `scanAll(): Promise<void>`, `maintenance(): Promise<void>` (journal trim + tombstone purge), `lastFullScanAt: Date | null`
  - `GET /api/admin/status` → `ServerStatus` (admin only)

- [ ] **Step 1: Write failing tests**

`apps/server/src/indexer/debounce.spec.ts`:
```ts
import { DirDebouncer } from './debounce';

jest.useFakeTimers();

it('coalesces bursts per key and upgrades to recursive', async () => {
  const calls: [string, boolean][] = [];
  const d = new DirDebouncer(async (k, r) => { calls.push([k, r]); }, 2000, 10000);
  d.push('u1\u0000a', false);
  jest.advanceTimersByTime(1500);
  d.push('u1\u0000a', true);
  jest.advanceTimersByTime(1500);
  expect(calls).toEqual([]);
  jest.advanceTimersByTime(600);
  await Promise.resolve();
  expect(calls).toEqual([['u1\u0000a', true]]);
});

it('fires at maxMs even under constant events', async () => {
  const calls: string[] = [];
  const d = new DirDebouncer(async (k) => { calls.push(k); }, 2000, 5000);
  for (let t = 0; t < 6000; t += 1000) { d.push('k', false); jest.advanceTimersByTime(1000); }
  await Promise.resolve();
  expect(calls.length).toBeGreaterThanOrEqual(1);
});
```

`apps/server/src/indexer/watcher.spec.ts`:
```ts
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, createTestUser, TestContext } from '../../test/context';
import { WatcherService } from './watcher.service';

describe('WatcherService.handleEvents', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.close(); });

  it('maps raw events to user directories and indexes them', async () => {
    const user = await createTestUser(ctx);
    const watcher = ctx.app.get(WatcherService);
    await watcher.refreshUsers();
    const root = path.join(ctx.config.dataRoot, user.username);
    await mkdir(path.join(root, 'new'));
    await writeFile(path.join(root, 'new', 'f.txt'), 'x');
    await writeFile(path.join(root, '.synclet-tmp-zz'), 'x');
    watcher.handleEvents([
      { type: 'create', path: path.join(root, 'new') },
      { type: 'create', path: path.join(root, 'new', 'f.txt') },
      { type: 'create', path: path.join(root, '.synclet-tmp-zz') },
      { type: 'create', path: path.join(ctx.config.dataRoot, 'unknown-user', 'x') },
    ]);
    await watcher.flush();
    const paths = (await ctx.prisma.item.findMany({ where: { deletedAt: null } })).map((i) => i.path).sort();
    expect(paths).toEqual(['new', 'new/f.txt']);
  });
});
```

`apps/server/src/indexer/scheduler.spec.ts`:
```ts
import { readdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTestApp, createTestUser, TestContext } from '../../test/context';
import { SchedulerService } from './scheduler.service';

describe('SchedulerService', () => {
  let ctx: TestContext;
  beforeEach(async () => { ctx = await createTestApp(); });
  afterEach(async () => { await ctx.close(); });

  it('removes leftover temp files at startup and scans all users', async () => {
    const user = await createTestUser(ctx);
    const root = path.join(ctx.config.dataRoot, user.username);
    await writeFile(path.join(root, '.synclet-tmp-dead'), 'partial');
    await writeFile(path.join(root, 'real.txt'), 'x');
    const s = ctx.app.get(SchedulerService);
    expect(await s.startupCleanup()).toBe(1);
    expect(await readdir(root)).toEqual(['real.txt']);
    await s.scanAll();
    expect(await ctx.prisma.item.count()).toBe(1);
    expect(s.lastFullScanAt).toBeInstanceOf(Date);
  });

  it('maintenance purges old tombstones', async () => {
    const user = await createTestUser(ctx);
    await ctx.prisma.item.create({ data: { ownerId: user.id, type: 'file', name: 'x', nameKey: 'x', path: 'x', mtime: new Date(), deletedAt: new Date(Date.now() - 48 * 3600 * 1000) } });
    await ctx.app.get(SchedulerService).maintenance();
    expect(await ctx.prisma.item.count()).toBe(0);
  });

  it('status endpoint is admin-only', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/setup', payload: { username: 'jens', displayName: 'Jens', password: 'correct horse battery' } });
    const status = await ctx.app.inject({ method: 'GET', url: '/api/admin/status', headers: { authorization: `Bearer ${res.json().accessToken}` } });
    expect(status.json()).toMatchObject({ watch: 'off', users: 1 });
  });
});
```
Run: `cd apps/server && pnpm jest src/indexer`
Expected: new tests FAIL.

- [ ] **Step 2: Implement debouncer**

`apps/server/src/indexer/debounce.ts`:
```ts
interface Pending { recursive: boolean; timer: NodeJS.Timeout; firstAt: number }

/** Per-key debounce: runs after `quietMs` without new events, but at most `maxMs` after the first one. */
export class DirDebouncer {
  private readonly pending = new Map<string, Pending>();
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly run: (key: string, recursive: boolean) => Promise<void>, private readonly quietMs = 2000, private readonly maxMs = 10000) {}

  push(key: string, recursive: boolean): void {
    const now = Date.now();
    const p = this.pending.get(key);
    if (p) clearTimeout(p.timer);
    const firstAt = p?.firstAt ?? now;
    const wait = Math.max(0, Math.min(this.quietMs, firstAt + this.maxMs - now));
    const entry: Pending = { recursive: recursive || (p?.recursive ?? false), firstAt, timer: setTimeout(() => this.fire(key), wait) };
    this.pending.set(key, entry);
  }

  private fire(key: string): void {
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    // Serialize runs: reconciles of one server never overlap (they lock per user anyway).
    this.running = this.running.then(() => this.run(key, p.recursive)).catch(() => {});
  }

  async flushAll(): Promise<void> {
    for (const [key, p] of [...this.pending]) { clearTimeout(p.timer); this.fire(key); }
    await this.running;
  }

  stop(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }
}
```

- [ ] **Step 3: Implement watcher, scheduler, status**

`apps/server/src/indexer/watcher.service.ts`:
```ts
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { AsyncSubscription } from '@parcel/watcher';
import path from 'node:path';
import { APP_CONFIG, AppConfig } from '../config';
import { AppEvents } from '../common/events';
import { isIgnored } from '../common/names';
import { parentRel } from '../common/paths';
import type { IndexUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { DirDebouncer } from './debounce';
import { IndexerService } from './indexer.service';

export interface RawEvent { type: 'create' | 'update' | 'delete'; path: string }

@Injectable()
export class WatcherService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(WatcherService.name);
  mode: 'active' | 'scan-only' | 'off' = 'off';
  private users = new Map<string, IndexUser>(); // username -> user
  private sub?: AsyncSubscription;
  private readonly debouncer: DirDebouncer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexer: IndexerService,
    private readonly events: AppEvents,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.debouncer = new DirDebouncer(async (key, recursive) => {
      const [username, dir] = key.split('\u0000');
      const user = this.users.get(username);
      if (!user) return;
      try {
        await this.indexer.reconcileDir(user, dir, { recursive });
      } catch (e) {
        this.log.warn(`reconcile ${username}/${dir} failed: ${(e as Error).message}`);
      }
    });
    this.events.on('user.created', (u) => { this.users.set(u.username, u); });
  }

  async refreshUsers(): Promise<void> {
    const rows = await this.prisma.user.findMany({ where: { disabledAt: null }, select: { id: true, username: true } });
    this.users = new Map(rows.map((u) => [u.username, u]));
  }

  async onApplicationBootstrap() {
    await this.refreshUsers();
    if (!this.config.background) return;
    if (!this.config.watch) { this.mode = 'scan-only'; return; }
    try {
      const watcher = await import('@parcel/watcher');
      this.sub = await watcher.subscribe(this.config.dataRoot, (err, events) => {
        if (err) { this.log.warn(`watcher error: ${err.message}`); return; }
        this.handleEvents(events);
      }, { ignore: ['**/.synclet-tmp-*'] });
      this.mode = 'active';
    } catch (e) {
      // Typical cause: inotify watch limit (raise fs.inotify.max_user_watches on the host).
      this.log.error(`file watcher unavailable, falling back to periodic scans: ${(e as Error).message}`);
      this.mode = 'scan-only';
    }
  }

  handleEvents(events: RawEvent[]): void {
    for (const ev of events) {
      const rel = path.relative(this.config.dataRoot, ev.path).split(path.sep).join('/');
      if (rel.startsWith('..') || rel === '') continue;
      const [username, ...rest] = rel.split('/');
      if (!this.users.has(username) || rest.length === 0) continue;
      if (rest.some((seg) => isIgnored(seg))) continue;
      const itemRel = rest.join('/');
      this.debouncer.push(`${username}\u0000${parentRel(itemRel)}`, false);
      if (ev.type === 'create') this.debouncer.push(`${username}\u0000${itemRel}`, true); // new dirs: scan contents
    }
  }

  flush(): Promise<void> { return this.debouncer.flushAll(); }

  async onModuleDestroy() {
    this.debouncer.stop();
    await this.sub?.unsubscribe();
  }
}
```
Note: a `create` event for a file enqueues `itemRel` as a directory too; `reconcileDir` returns `missing-dir` for files (ENOTDIR) and ignores it.

`apps/server/src/indexer/scheduler.service.ts`:
```ts
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { APP_CONFIG, AppConfig } from '../config';
import { isTempName } from '../common/names';
import { userRoot } from '../common/paths';
import { ItemStore } from '../journal/item-store';
import { JournalService } from '../journal/journal.service';
import { PrismaService } from '../prisma/prisma.service';
import { IndexerService } from './indexer.service';

const DAY = 24 * 3600 * 1000;

@Injectable()
export class SchedulerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(SchedulerService.name);
  private timers: NodeJS.Timeout[] = [];
  private scanning = false;
  lastFullScanAt: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexer: IndexerService,
    private readonly journal: JournalService,
    private readonly store: ItemStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap() {
    if (!this.config.background) return;
    await this.startupCleanup();
    void this.scanAll();
    this.timers.push(setInterval(() => void this.scanAll(), this.config.scanIntervalSec * 1000));
    this.timers.push(setInterval(() => void this.maintenance(), DAY));
  }

  onModuleDestroy() { this.timers.forEach(clearInterval); }

  private users() {
    return this.prisma.user.findMany({ where: { disabledAt: null }, select: { id: true, username: true } });
  }

  /** At startup no upload is in flight, so every temp file is a leftover of a crash. */
  async startupCleanup(): Promise<number> {
    let removed = 0;
    for (const u of await this.users()) {
      const root = userRoot(this.config.dataRoot, u.username);
      const names = await readdir(root).catch(() => [] as string[]);
      for (const n of names.filter(isTempName)) { await rm(path.join(root, n), { force: true }); removed++; }
    }
    return removed;
  }

  async scanAll(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      for (const u of await this.users()) {
        const stats = await this.indexer.fullScan(u).catch((e) => { this.log.error(`scan ${u.username}: ${(e as Error).message}`); return null; });
        if (stats && (stats.created || stats.updated || stats.moved || stats.deleted)) this.log.log(`scan ${u.username}: ${JSON.stringify(stats)}`);
      }
      this.lastFullScanAt = new Date();
    } finally {
      this.scanning = false;
    }
  }

  async maintenance(): Promise<void> {
    const before = new Date(Date.now() - this.config.journalRetentionDays * DAY);
    for (const u of await this.users()) await this.journal.trim(u.id, before);
    await this.store.purgeTombstones(new Date(Date.now() - Math.max(this.config.tombstoneWindowSec * 1000, DAY)));
  }
}
```

`apps/server/src/indexer/status.controller.ts`:
```ts
import { Controller, Get, UseGuards } from '@nestjs/common';
import type { ServerStatus } from '@synclet/shared';
import { AuthGuard } from '../auth/auth.guard';
import { AdminOnly } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { SchedulerService } from './scheduler.service';
import { WatcherService } from './watcher.service';

@Controller('admin/status')
@UseGuards(AuthGuard)
@AdminOnly()
export class StatusController {
  constructor(private readonly watcher: WatcherService, private readonly scheduler: SchedulerService, private readonly prisma: PrismaService) {}

  @Get()
  async status(): Promise<ServerStatus> {
    return { watch: this.watcher.mode, lastFullScanAt: this.scheduler.lastFullScanAt?.toISOString() ?? null, users: await this.prisma.user.count({ where: { disabledAt: null } }) };
  }
}
```

`apps/server/src/indexer/indexer.module.ts`:
```ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { IndexerService } from './indexer.service';
import { SchedulerService } from './scheduler.service';
import { StatusController } from './status.controller';
import { WatcherService } from './watcher.service';

@Module({
  imports: [AuthModule],
  controllers: [StatusController],
  providers: [IndexerService, WatcherService, SchedulerService],
  exports: [IndexerService],
})
export class IndexerModule {}
```

- [ ] **Step 4: Run tests**

Run: `cd apps/server && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Manual smoke run against a real folder**

```bash
mkdir -p /tmp/synclet-smoke/data /tmp/synclet-smoke/meta
cd apps/server && DATABASE_URL=postgresql://synclet:synclet@localhost:5434/synclet SYNCLET_DATA_ROOT=/tmp/synclet-smoke/data SYNCLET_META_ROOT=/tmp/synclet-smoke/meta pnpm prisma migrate deploy && \
DATABASE_URL=postgresql://synclet:synclet@localhost:5434/synclet SYNCLET_DATA_ROOT=/tmp/synclet-smoke/data SYNCLET_META_ROOT=/tmp/synclet-smoke/meta PORT=3100 pnpm dev
```
In a second shell: `curl -s -XPOST localhost:3100/api/setup -H 'content-type: application/json' -d '{"username":"jens","displayName":"Jens","password":"correct horse battery"}'`, then `echo hi > /tmp/synclet-smoke/data/jens/live.txt`, wait 3 s, and `curl -s localhost:3100/api/sync/v1/items/root/children -H "authorization: Bearer <accessToken>"`.
Expected: `live.txt` listed (watcher works on macOS FSEvents).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/indexer
git commit -m "feat(server): file watcher with debounced reconcile, periodic scans, cleanup and status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Web app shell, design system, auth screens

**REQUIRED SUB-SKILL:** Use `frontend-design:frontend-design` for the visual direction before writing components.

**Files:**
- Create: `apps/web/` via Vite React-TS template, then: `src/main.tsx`, `src/app/{router.tsx,providers.tsx}`, `src/lib/{api.ts,auth.tsx,format.ts,i18n.ts}`, `src/locales/{de.json,en.json}`, `src/styles/globals.css`, `src/components/ui/*` (shadcn), `src/components/app-shell/{AppShell.tsx,Sidebar.tsx,Topbar.tsx,ThemeToggle.tsx}`, `src/pages/{SetupPage.tsx,LoginPage.tsx,NotFoundPage.tsx}`
- Test: `apps/web/src/lib/{api.test.ts,format.test.ts}`, `apps/web/vitest.config.ts`

**Interfaces:**
- Consumes: `@synclet/shared` types (`AuthResponse`, `PublicUser`, `SetupStatus`, `SyncErrorBody`); server routes from Task 3 (`/api/setup/status`, `/api/setup`, `/api/auth/login|refresh|logout|me`).
- Produces (used by Task 10):
  - `api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T>` – prefixes `/api`, attaches `Authorization: Bearer <access>`, on 401 performs one `POST /api/auth/refresh` (credentials `include`) and retries; throws `ApiError { status: number; code: string; message: string; item?: SyncItem }`
  - `getAccessToken(): string | null`
  - `useAuth(): { user: PublicUser | null; status: 'loading' | 'anonymous' | 'authenticated'; login(login: string, password: string): Promise<void>; logout(): Promise<void>; completeSetup(input): Promise<void> }`, `<AuthProvider>`
  - `formatBytes(n: number, locale: string): string`, `formatDate(iso: string, locale: string): string`
  - `<AppShell>` with `<Outlet/>`; sidebar entries: "Meine Dateien" (`/files`), disabled-with-badge "Zuletzt", "Freigaben", "Papierkorb" (Phase 1b); bottom: storage usage (from `GET /api/sync/v1/account` `usedBytes`), user menu (logout, theme)
  - Routes: `/setup`, `/login`, `/files` and `/files/:folderId` (rendered by Task 10's `FilesPage`; Task 9 registers a placeholder component `src/pages/FilesPage.tsx` exporting `FilesPage` that Task 10 replaces)

Design constraints (from spec §10 + Mobbin references Dropbox Web, Proton Drive, Supabase Storage, Skiff Drive): left sidebar ~240 px, quiet neutral surfaces, one confident accent color, generous whitespace, 13–14 px UI text, crisp 1 px borders, subtle shadows only on overlays, light + dark theme (system default, toggle persisted in `localStorage`), fully keyboard accessible (Radix via shadcn), responsive down to 360 px (sidebar collapses into a sheet). **No external CDNs or Google Fonts** (self-hosted privacy): bundle the font with `@fontsource-variable/*`. All UI strings through i18next (`de` default, `en`).

- [ ] **Step 1: Scaffold**

```bash
cd apps && pnpm create vite@latest web --template react-ts && cd web
pnpm add react-router @tanstack/react-query i18next react-i18next lucide-react sonner clsx tailwind-merge class-variance-authority @fontsource-variable/inter
pnpm add -D tailwindcss @tailwindcss/vite vitest @testing-library/react @testing-library/jest-dom jsdom @synclet/shared@workspace:*
pnpm dlx shadcn@latest init
pnpm dlx shadcn@latest add button input label card dropdown-menu context-menu dialog alert-dialog tooltip breadcrumb table skeleton progress avatar separator sheet sonner toggle-group badge scroll-area
```
Set `package.json` name to `@synclet/web` with scripts `dev`, `build` (`tsc -b && vite build`), `test` (`vitest run`), `typecheck` (`tsc -b --noEmit`). `vite.config.ts`: Tailwind plugin, alias `@` → `src`, dev proxy `'/api' → 'http://localhost:3100'`.

- [ ] **Step 2: Write failing tests for api client and formatting**

`apps/web/src/lib/api.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, setAccessToken } from './api';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('api', () => {
  afterEach(() => { vi.restoreAllMocks(); setAccessToken(null); });

  it('sends the bearer token and parses JSON', async () => {
    setAccessToken('tok');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(200, { ok: 1 }));
    expect(await api('/health')).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tok' }) }));
  });

  it('refreshes once on 401 and retries', async () => {
    setAccessToken('old');
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json(401, { statusCode: 401, code: 'unauthorized', message: 'x' }))
      .mockResolvedValueOnce(json(200, { accessToken: 'new', user: { id: '1' } }))
      .mockResolvedValueOnce(json(200, { ok: 2 }));
    expect(await api('/thing')).toEqual({ ok: 2 });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/auth/refresh');
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ headers: expect.objectContaining({ Authorization: 'Bearer new' }) });
  });

  it('throws ApiError with code and item', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(409, { statusCode: 409, code: 'name_conflict', message: 'exists', item: { id: 'f_1' } }));
    await expect(api('/x', { method: 'POST', json: {} })).rejects.toMatchObject({ status: 409, code: 'name_conflict', item: { id: 'f_1' } });
    await expect(api('/x')).rejects.toBeInstanceOf(ApiError);
  });
});
```
`apps/web/src/lib/format.test.ts`:
```ts
import { expect, it } from 'vitest';
import { formatBytes } from './format';

it('formats bytes in binary units with locale separators', () => {
  expect(formatBytes(0, 'de')).toBe('0 B');
  expect(formatBytes(1536, 'de')).toBe('1,5 KB');
  expect(formatBytes(5 * 1024 ** 3, 'en')).toBe('5 GB');
});
```
Run: `cd apps/web && pnpm test`
Expected: FAIL.

- [ ] **Step 3: Implement lib**

`apps/web/src/lib/api.ts`:
```ts
import type { AuthResponse, SyncErrorBody, SyncItem } from '@synclet/shared';

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<(r: AuthResponse | null) => void>();

export function setAccessToken(t: string | null) { accessToken = t; }
export function getAccessToken() { return accessToken; }
export function onAuthChange(fn: (r: AuthResponse | null) => void) { listeners.add(fn); return () => listeners.delete(fn); }

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly item?: SyncItem) { super(message); }
}

async function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    if (!res.ok) { accessToken = null; listeners.forEach((l) => l(null)); return false; }
    const body = (await res.json()) as AuthResponse;
    accessToken = body.accessToken;
    listeners.forEach((l) => l(body));
    return true;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}, retried = false): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    credentials: 'include',
    ...rest,
    headers: {
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(headers as Record<string, string>),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  if (res.status === 401 && !retried && !path.startsWith('/auth/')) {
    if (await refresh()) return api<T>(path, init, true);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Partial<SyncErrorBody>;
    throw new ApiError(res.status, body.code ?? 'unknown', body.message ?? res.statusText, body.item);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export { refresh as refreshSession };
```

`apps/web/src/lib/format.ts`:
```ts
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(n: number, locale: string): string {
  let i = 0; let v = n;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: i === 0 ? 0 : 1 }).format(v)} ${UNITS[i]}`;
}

export function formatDate(iso: string, locale: string): string {
  const d = new Date(iso);
  const sameDay = new Date().toDateString() === d.toDateString();
  return new Intl.DateTimeFormat(locale, sameDay ? { timeStyle: 'short' } : { dateStyle: 'medium' }).format(d);
}
```

`apps/web/src/lib/auth.tsx`:
```tsx
import type { AuthResponse, PublicUser, SetupStatus } from '@synclet/shared';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, onAuthChange, refreshSession, setAccessToken } from './api';

type Status = 'loading' | 'anonymous' | 'authenticated' | 'needs-setup';
interface AuthCtx {
  user: PublicUser | null;
  status: Status;
  login(login: string, password: string): Promise<void>;
  logout(): Promise<void>;
  completeSetup(input: { username: string; displayName: string; email?: string; password: string }): Promise<void>;
}
const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const accept = useCallback((r: AuthResponse | null) => {
    setAccessToken(r?.accessToken ?? null);
    setUser(r?.user ?? null);
    setStatus(r ? 'authenticated' : 'anonymous');
  }, []);

  useEffect(() => {
    const off = onAuthChange(accept);
    (async () => {
      const s = await api<SetupStatus>('/setup/status');
      if (s.needsSetup) { setStatus('needs-setup'); return; }
      if (!(await refreshSession())) setStatus('anonymous');
    })().catch(() => setStatus('anonymous'));
    return () => { off(); };
  }, [accept]);

  const value: AuthCtx = {
    user, status,
    login: async (login, password) => accept(await api<AuthResponse>('/auth/login', { method: 'POST', json: { login, password } })),
    logout: async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); accept(null); },
    completeSetup: async (input) => accept(await api<AuthResponse>('/setup', { method: 'POST', json: input })),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
```
(`status` also has `'needs-setup'`; the router redirects to `/setup` in that state.)

`apps/web/src/lib/i18n.ts`: initialize i18next with `de` (fallback) and `en` resources from `src/locales/*.json`, language from `navigator.language` (`de*` → de, else en). Keys used in Task 9/10 live under namespaces `common.*`, `auth.*`, `shell.*`, `files.*`. Example `de.json` excerpt (extend as you build; every visible string must have a `de` and `en` entry):
```json
{
  "common": { "cancel": "Abbrechen", "save": "Speichern", "delete": "Löschen", "rename": "Umbenennen", "move": "Verschieben", "download": "Herunterladen", "comingSoon": "Bald" },
  "auth": { "loginTitle": "Bei Synclet anmelden", "login": "Benutzername oder E-Mail", "password": "Passwort", "submit": "Anmelden", "invalid": "Benutzername oder Passwort falsch", "setupTitle": "Synclet einrichten", "setupHint": "Lege das Administrator-Konto an. Der Benutzername ist gleichzeitig der Ordnername im Datenverzeichnis.", "username": "Benutzername", "displayName": "Anzeigename", "email": "E-Mail (optional)", "createAdmin": "Konto anlegen" },
  "shell": { "myFiles": "Meine Dateien", "recent": "Zuletzt", "shared": "Freigaben", "trash": "Papierkorb", "storageUsed": "{{used}} belegt", "logout": "Abmelden", "theme": "Design" }
}
```

- [ ] **Step 4: Shell, pages, router**

Implement (following the frontend-design direction):
- `src/app/providers.tsx`: `QueryClientProvider` (staleTime 10 s, `refetchOnWindowFocus: true`), `AuthProvider`, i18n init, `<Toaster/>` (sonner), theme class on `<html>` (`dark`), persisted under `localStorage['synclet.theme']` (`system|light|dark`, wrapped in try/catch).
- `src/app/router.tsx` (react-router 7 `createBrowserRouter`): `RequireAuth` wrapper → redirects `needs-setup` → `/setup`, `anonymous` → `/login?next=…`, shows a centered spinner while `loading`. Routes: `/setup` (`SetupPage`), `/login` (`LoginPage`), `/` → redirect `/files`, `/files` and `/files/:folderId` inside `AppShell` → `FilesPage`, `*` → `NotFoundPage`.
- `SetupPage`: card with username (live hint: "Ordner: /data/<username>"), display name, optional email, password (min 10, show/hide toggle); server errors shown inline (`invalid_request` → username hint, `setup_done` → redirect to login).
- `LoginPage`: login + password, submit on Enter, error `auth.invalid` on 401, redirects to `next` or `/files`.
- `AppShell`: `Sidebar` (logo wordmark "Synclet", nav items with lucide icons `Folder`, `Clock`, `Share2`, `Trash2`; Phase-1b items disabled with `common.comingSoon` badge), storage usage at the bottom (query key `['account']` → `api<SyncAccount>('/sync/v1/account')`, shows `formatBytes(usedBytes)`), `Topbar` slot for page actions (Task 10 portals breadcrumb + actions into it via a `TopbarSlot` context: `useTopbar(node: ReactNode)`), user avatar menu (name, theme toggle, logout). Mobile: sidebar in `Sheet` behind a menu button.
- `src/pages/FilesPage.tsx` placeholder: `export function FilesPage() { return null; }` (replaced in Task 10).

- [ ] **Step 5: Verify**

Run: `cd apps/web && pnpm test && pnpm typecheck && pnpm build`
Expected: PASS / build succeeds.
Run the server (Task 8 Step 5 command, port 3100) on a fresh DB and `pnpm dev`; open `http://localhost:5173`: setup screen appears, admin can be created, reload keeps you logged in (refresh cookie), logout returns to login. Check light/dark and 360 px width.

- [ ] **Step 6: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): app shell, design system, setup and login

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Web file browser

**REQUIRED SUB-SKILL:** Use `frontend-design:frontend-design` (same direction as Task 9).

**Files:**
- Create: `apps/web/src/features/files/{queries.ts,uploads.ts,UploadPanel.tsx,FileIcon.tsx,FileList.tsx,FileGrid.tsx,FileActions.tsx,NewFolderDialog.tsx,RenameDialog.tsx,MoveDialog.tsx,DeleteDialog.tsx,DropZone.tsx,EmptyState.tsx,Breadcrumbs.tsx}`
- Modify: `apps/web/src/pages/FilesPage.tsx`, `apps/web/src/locales/{de,en}.json`
- Test: `apps/web/src/features/files/{uploads.test.ts,queries.test.ts}`

**Interfaces:**
- Consumes: `api`, `ApiError`, `getAccessToken`, `formatBytes`, `formatDate`, `useTopbar` (Task 9); Sync API v1 routes (Task 7): `GET /sync/v1/items/:id`, `GET /sync/v1/items/:id/children` (follow `nextPageToken` until null), `POST /sync/v1/items`, `POST /sync/v1/items/upload?parentId&name&onConflict`, `PATCH /sync/v1/items/:id`, `DELETE /sync/v1/items/:id`, `POST /sync/v1/items/:id/download-token`.
- Produces:
  - `useFolder(folderId: string)` → `{ folder: SyncItem; items: SyncItem[] }` (query key `['folder', folderId]`, refetch interval 15 s)
  - `useAncestors(folderId)` → `SyncItem[]` from root to folder (walk `parentId` via `GET /items/:id`, cached per id)
  - `useFileMutations()` → `{ createFolder(parentId, name), rename(item, name), move(item, targetFolderId), remove(item), download(item) }`, each invalidating `['folder', …]` and `['account']`
  - `UploadQueue` (`uploads.ts`): `enqueue(files: File[], parentId: string)`, statuses `queued|uploading|done|error|conflict`, `progress: 0..1`, max 3 concurrent, uses `XMLHttpRequest` for progress with `Authorization` header and `Content-Type: application/octet-stream`, `X-Synclet-Modified-At: new Date(file.lastModified).toISOString()`, `onConflict=rename`; `subscribe(fn)`; `useUploads()` hook
  - Folder URL scheme: `/files` = root, `/files/:folderId` with `folderId` = `d_<uuid>`

UI requirements:
- Topbar: breadcrumbs (root label = `shell.myFiles`; middle segments collapse into a dropdown when > 4), view toggle list/grid (persisted in localStorage), "Neu" dropdown (Ordner), "Hochladen" button (hidden `<input type=file multiple>`).
- List view (default): columns Name (icon + name), Geändert, Größe; folders first, then files, sorted by name (`localeCompare` with numeric: true, sensitivity base); clickable column headers toggle sort; row double-click/Enter opens folder or downloads file; hover reveals a "⋯" actions menu; right-click opens the same menu as a context menu (Download, Umbenennen, Verschieben, Löschen).
- Grid view: cards with large file-type icon (`FileIcon` maps mime/extension to lucide icons + tint: folder, image, video, audio, pdf, text/code, archive, spreadsheet, presentation, document, generic); thumbnails come in Phase 1b.
- Keyboard: arrow keys move selection, Enter opens, F2 rename, Delete/Backspace delete (with confirm), Esc clears selection; selection highlighted; multi-select is out of scope for 1a.
- Drag & drop files from the OS anywhere onto the page → overlay "Zum Hochladen ablegen" → enqueue into the current folder. (Folder drag&drop and drag-to-move inside the app are Phase 1b.)
- Upload panel bottom-right (like the Shopify reference): collapsible, per-file progress bars, error retry, "Fertig" summary, auto-hide 5 s after all done.
- Dialogs: New folder (validates client-side with the same forbidden-chars rule; shows server `name_conflict` inline), Rename (preselects base name without extension), Move (folder tree picker that lazily loads children, disables the item itself and its descendants), Delete (confirm; explains "wird in den Papierkorb verschoben").
- Empty folder state with illustration-free, typographic empty state + upload/new-folder CTAs; skeleton rows while loading; error state with retry.
- Download: `POST download-token` → `window.location.assign(url)`.

- [ ] **Step 1: Write failing tests**

`apps/web/src/features/files/uploads.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest';
import { UploadQueue } from './uploads';

class FakeXHR {
  static instances: FakeXHR[] = [];
  upload = { onprogress: null as null | ((e: { loaded: number; total: number }) => void) };
  onload: null | (() => void) = null; onerror: null | (() => void) = null;
  status = 0; responseText = ''; headers: Record<string, string> = {}; url = ''; method = '';
  open(m: string, u: string) { this.method = m; this.url = u; }
  setRequestHeader(k: string, v: string) { this.headers[k] = v; }
  send() { FakeXHR.instances.push(this); }
  abort() {}
}

describe('UploadQueue', () => {
  it('uploads with raw body, progress and max 3 concurrent', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
    const q = new UploadQueue(() => 'tok', () => {});
    const files = Array.from({ length: 4 }, (_, i) => new File(['x'], `f${i}.txt`, { lastModified: 0 }));
    q.enqueue(files, 'root');
    expect(FakeXHR.instances).toHaveLength(3);
    const first = FakeXHR.instances[0];
    expect(first.url).toBe('/api/sync/v1/items/upload?parentId=root&name=f0.txt&onConflict=rename');
    expect(first.headers['Content-Type']).toBe('application/octet-stream');
    expect(first.headers.Authorization).toBe('Bearer tok');
    first.upload.onprogress?.({ loaded: 1, total: 2 });
    expect(q.snapshot()[0].progress).toBe(0.5);
    first.status = 201; first.responseText = JSON.stringify({ id: 'f_x' }); first.onload?.();
    await Promise.resolve();
    expect(q.snapshot()[0].status).toBe('done');
    expect(FakeXHR.instances).toHaveLength(4);
  });
});
```
`apps/web/src/features/files/queries.test.ts`:
```ts
import { expect, it, vi } from 'vitest';
import * as apiMod from '@/lib/api';
import { fetchAllChildren, sortItems } from './queries';

it('follows nextPageToken until exhausted', async () => {
  const spy = vi.spyOn(apiMod, 'api')
    .mockResolvedValueOnce({ items: [{ id: 'a' }], nextPageToken: 't1', cursor: '1' })
    .mockResolvedValueOnce({ items: [{ id: 'b' }], nextPageToken: null, cursor: '1' });
  const items = await fetchAllChildren('root');
  expect(items.map((i) => i.id)).toEqual(['a', 'b']);
  expect(spy.mock.calls[1][0]).toBe('/sync/v1/items/root/children?limit=1000&pageToken=t1');
});

it('sorts folders first, then natural name order', () => {
  const mk = (name: string, type: 'file' | 'folder') => ({ id: name, name, type }) as never;
  expect(sortItems([mk('b10.txt', 'file'), mk('Z', 'folder'), mk('b2.txt', 'file')], 'name', 'asc', 'de').map((i: { name: string }) => i.name))
    .toEqual(['Z', 'b2.txt', 'b10.txt']);
});
```
Run: `cd apps/web && pnpm test`
Expected: FAIL.

- [ ] **Step 2: Implement queries and upload queue**

`apps/web/src/features/files/queries.ts`:
```ts
import type { SyncChildrenPage, SyncItem } from '@synclet/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export async function fetchAllChildren(folderId: string): Promise<SyncItem[]> {
  const out: SyncItem[] = [];
  let token: string | null = null;
  do {
    const qs: string = `limit=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
    const page: SyncChildrenPage = await api<SyncChildrenPage>(`/sync/v1/items/${folderId}/children?${qs}`);
    out.push(...page.items);
    token = page.nextPageToken;
  } while (token);
  return out;
}

export type SortKey = 'name' | 'modifiedAt' | 'size';

export function sortItems(items: SyncItem[], key: SortKey, dir: 'asc' | 'desc', locale: string): SyncItem[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const f = dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    if (key === 'size') return f * (a.size - b.size) || collator.compare(a.name, b.name);
    if (key === 'modifiedAt') return f * a.modifiedAt.localeCompare(b.modifiedAt) || collator.compare(a.name, b.name);
    return f * collator.compare(a.name, b.name);
  });
}

export function useFolder(folderId: string) {
  return useQuery({
    queryKey: ['folder', folderId],
    queryFn: async () => {
      const [folder, items] = await Promise.all([api<SyncItem>(`/sync/v1/items/${folderId}`), fetchAllChildren(folderId)]);
      return { folder, items };
    },
    refetchInterval: 15_000,
  });
}

export function useAncestors(folderId: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['ancestors', folderId],
    queryFn: async () => {
      const chain: SyncItem[] = [];
      let id: string | null = folderId;
      while (id) {
        const cur: string = id;
        const item: SyncItem = await qc.fetchQuery({ queryKey: ['item', cur], queryFn: () => api<SyncItem>(`/sync/v1/items/${cur}`), staleTime: 30_000 });
        chain.unshift(item);
        id = item.parentId;
      }
      return chain;
    },
  });
}

export function useFileMutations() {
  const qc = useQueryClient();
  const done = (...folderIds: (string | null)[]) => {
    for (const f of folderIds) if (f) void qc.invalidateQueries({ queryKey: ['folder', f] });
    void qc.invalidateQueries({ queryKey: ['account'] });
    void qc.invalidateQueries({ queryKey: ['ancestors'] });
  };
  return {
    createFolder: useMutation({
      mutationFn: (v: { parentId: string; name: string }) => api<SyncItem>('/sync/v1/items', { method: 'POST', json: { parentId: v.parentId, type: 'folder', name: v.name } }),
      onSuccess: (_r, v) => done(v.parentId),
    }),
    rename: useMutation({
      mutationFn: (v: { item: SyncItem; name: string }) => api<SyncItem>(`/sync/v1/items/${v.item.id}`, { method: 'PATCH', json: { name: v.name } }),
      onSuccess: (_r, v) => done(v.item.parentId),
    }),
    move: useMutation({
      mutationFn: (v: { item: SyncItem; targetId: string }) => api<SyncItem>(`/sync/v1/items/${v.item.id}`, { method: 'PATCH', json: { parentId: v.targetId } }),
      onSuccess: (_r, v) => done(v.item.parentId, v.targetId),
    }),
    remove: useMutation({
      mutationFn: (item: SyncItem) => api<void>(`/sync/v1/items/${item.id}`, { method: 'DELETE' }),
      onSuccess: (_r, item) => done(item.parentId),
    }),
  };
}

export async function downloadItem(item: SyncItem) {
  const { url } = await api<{ url: string }>(`/sync/v1/items/${item.id}/download-token`, { method: 'POST' });
  window.location.assign(url);
}
```

`apps/web/src/features/files/uploads.ts`:
```ts
import type { SyncItem } from '@synclet/shared';
import { useSyncExternalStore } from 'react';
import { getAccessToken } from '@/lib/api';

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error';
export interface UploadTask { id: number; file: File; parentId: string; status: UploadStatus; progress: number; error?: string; result?: SyncItem }

const MAX_PARALLEL = 3;

export class UploadQueue {
  private tasks: UploadTask[] = [];
  private seq = 0;
  private listeners = new Set<() => void>();
  private snap: UploadTask[] = [];

  constructor(private readonly token: () => string | null, private readonly onDone: (parentId: string) => void) {}

  enqueue(files: File[], parentId: string) {
    for (const file of files) this.tasks.push({ id: ++this.seq, file, parentId, status: 'queued', progress: 0 });
    this.pump();
  }

  retry(id: number) {
    const t = this.tasks.find((x) => x.id === id);
    if (t && t.status === 'error') { t.status = 'queued'; t.progress = 0; t.error = undefined; this.pump(); }
  }

  clearFinished() { this.tasks = this.tasks.filter((t) => t.status !== 'done'); this.emit(); }

  snapshot(): UploadTask[] { return this.snap; }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };

  private emit() { this.snap = this.tasks.map((t) => ({ ...t })); this.listeners.forEach((l) => l()); }

  private pump() {
    const active = this.tasks.filter((t) => t.status === 'uploading').length;
    for (const t of this.tasks.filter((x) => x.status === 'queued').slice(0, Math.max(0, MAX_PARALLEL - active))) this.start(t);
    this.emit();
  }

  private start(t: UploadTask) {
    t.status = 'uploading';
    const xhr = new XMLHttpRequest();
    const qs = `parentId=${encodeURIComponent(t.parentId)}&name=${encodeURIComponent(t.file.name)}&onConflict=rename`;
    xhr.open('POST', `/api/sync/v1/items/upload?${qs}`);
    const tok = this.token();
    if (tok) xhr.setRequestHeader('Authorization', `Bearer ${tok}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Synclet-Modified-At', new Date(t.file.lastModified).toISOString());
    xhr.upload.onprogress = (e) => { t.progress = e.total ? e.loaded / e.total : 0; this.emit(); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        t.status = 'done'; t.progress = 1; t.result = JSON.parse(xhr.responseText) as SyncItem;
        this.onDone(t.parentId);
      } else {
        t.status = 'error';
        try { t.error = (JSON.parse(xhr.responseText) as { code?: string }).code; } catch { t.error = String(xhr.status); }
      }
      this.pump();
    };
    xhr.onerror = () => { t.status = 'error'; t.error = 'network'; this.pump(); };
    xhr.send(t.file);
  }
}

let queue: UploadQueue | null = null;
export function getUploadQueue(onDone: (parentId: string) => void): UploadQueue {
  queue ??= new UploadQueue(getAccessToken, onDone);
  return queue;
}

export function useUploads(q: UploadQueue) {
  return useSyncExternalStore(q.subscribe, () => q.snapshot());
}
```
Note: 401 during an XHR upload (expired access token) → mark error `unauthorized`; the retry button calls `refreshSession()` first, then `retry(id)`.

- [ ] **Step 3: Implement components and page**

Build the components listed under **Files** to satisfy the UI requirements above. `FilesPage` reads `folderId` from the route (default `root`), wires `useFolder`, `useAncestors`, `useFileMutations`, `getUploadQueue((pid) => qc.invalidateQueries({ queryKey: ['folder', pid] }))`, renders `DropZone` → `FileList | FileGrid` → dialogs, and portals breadcrumbs/actions through `useTopbar`. Map `ApiError.code` to localized toasts/inline messages (`files.errors.<code>` for `name_conflict`, `invalid_name`, `not_found`, `conflict`, `too_large`, `forbidden`, fallback `files.errors.unknown`).

- [ ] **Step 4: Verify**

Run: `cd apps/web && pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.
Manual (server on 3100 + `pnpm dev`): create folder, upload 3 files via button and drag&drop (progress visible), open folder via double-click, breadcrumb back, rename (F2), move via dialog, delete (Del) → file disappears; `ls` of the data folder matches the UI exactly; a file created in Finder appears within ~15 s.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): file browser with list/grid, uploads, rename, move, delete

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Docker images, Compose stack, Caddy, README

**Files:**
- Create: `deploy/Dockerfile.server`, `deploy/Dockerfile.caddy`, `deploy/server-entrypoint.sh`, `deploy/compose.yml`, `deploy/Caddyfile`, `deploy/.env.example`, `.dockerignore`
- Modify: `README.md`

**Interfaces:**
- Consumes: `apps/server` build (`dist/main.js`, `prisma/`), `apps/web` build (`dist/`).
- Produces: `docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build` → Synclet on `http://localhost:${SYNCLET_PORT:-8080}`.

- [ ] **Step 1: Server image**

`.dockerignore`:
```
**/node_modules
**/dist
.git
e2e
playwright-report
test-results
```
`deploy/Dockerfile.server`:
```dockerfile
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /src
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @synclet/server...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @synclet/shared build && pnpm --filter @synclet/server build
RUN pnpm --filter @synclet/server deploy --prod /out && cp -r apps/server/dist apps/server/prisma /out/ \
 && cd /out && npx prisma generate

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out /app
COPY deploy/server-entrypoint.sh /usr/local/bin/synclet-entrypoint
RUN chmod +x /usr/local/bin/synclet-entrypoint
ENV NODE_ENV=production PORT=3000 SYNCLET_DATA_ROOT=/data SYNCLET_META_ROOT=/meta
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "synclet-entrypoint"]
```
`deploy/server-entrypoint.sh`:
```sh
#!/bin/sh
set -e
umask 002
npx prisma migrate deploy --schema /app/prisma/schema.prisma
exec node /app/dist/main.js
```
(The container runs as `${PUID}:${PGID}` via compose `user:`, so files in `/data` keep the host owner.)

- [ ] **Step 2: Caddy + web image**

`deploy/Dockerfile.caddy`:
```dockerfile
FROM node:24-bookworm-slim AS web
RUN corepack enable
WORKDIR /src
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @synclet/web...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @synclet/shared build && pnpm --filter @synclet/web build

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=web /src/apps/web/dist /srv/web
```
(Spec §9 lists a separate `web` service; serving the static build from the Caddy image is leaner and equivalent. Recorded as a deviation in README "Architecture".)

`deploy/Caddyfile`:
```
{
	admin off
}

{$SYNCLET_SITE_ADDRESS::80} {
	encode zstd gzip
	request_body {
		max_size 0
	}

	handle /api/* {
		reverse_proxy server:3000 {
			flush_interval -1
			transport http {
				read_timeout 0
				write_timeout 0
			}
		}
	}

	handle {
		root * /srv/web
		try_files {path} /index.html
		file_server
		header /assets/* Cache-Control "public, max-age=31536000, immutable"
	}

	header {
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		X-Frame-Options SAMEORIGIN
	}
}
```
With `SYNCLET_SITE_ADDRESS=files.example.com` Caddy obtains TLS automatically; default `:80` for use behind an existing reverse proxy.

- [ ] **Step 3: Compose + env**

`deploy/compose.yml`:
```yaml
name: synclet
services:
  server:
    build: { context: .., dockerfile: deploy/Dockerfile.server }
    image: synclet/server:dev
    user: "${PUID:-1000}:${PGID:-1000}"
    environment:
      DATABASE_URL: postgresql://synclet:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}@postgres:5432/synclet
      SYNCLET_PUBLIC_URL: ${SYNCLET_PUBLIC_URL:-}
      SYNCLET_WATCH: ${SYNCLET_WATCH:-on}
      SYNCLET_SCAN_INTERVAL: ${SYNCLET_SCAN_INTERVAL:-}
      SYNCLET_MAX_UPLOAD_BYTES: ${SYNCLET_MAX_UPLOAD_BYTES:-}
    volumes:
      - ${SYNCLET_DATA:?set SYNCLET_DATA to your files folder}:/data
      - ${SYNCLET_META:-./meta}:/meta
    depends_on:
      postgres: { condition: service_healthy }
    restart: unless-stopped
  caddy:
    build: { context: .., dockerfile: deploy/Dockerfile.caddy }
    image: synclet/caddy:dev
    environment:
      SYNCLET_SITE_ADDRESS: ${SYNCLET_SITE_ADDRESS:-:80}
    ports:
      - "${SYNCLET_PORT:-8080}:80"
      - "${SYNCLET_TLS_PORT:-8443}:443"
    volumes: [caddy-data:/data]
    depends_on: [server]
    restart: unless-stopped
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: synclet
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: synclet
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U synclet"]
      interval: 3s
      retries: 30
    restart: unless-stopped
volumes:
  pgdata:
  caddy-data:
```
`/meta` is a host bind mount (default `deploy/meta`) so trash survives `docker compose down -v`; it must be writable by `PUID:PGID`.

`deploy/.env.example`:
```
# Folder with your files. Each user gets a subfolder named like the username.
SYNCLET_DATA=/srv/files
# Metadata (trash, later thumbnails/versions). Keep it OUTSIDE SYNCLET_DATA.
SYNCLET_META=/srv/synclet-meta
# Owner of the files on the host (id -u / id -g).
PUID=1000
PGID=1000
POSTGRES_PASSWORD=change-me
SYNCLET_PORT=8080
# Public URL, e.g. https://files.example.com (enables secure cookies)
SYNCLET_PUBLIC_URL=
# Set to your domain to let Caddy fetch TLS certificates, or keep :80 behind a proxy.
SYNCLET_SITE_ADDRESS=:80
# off = no file watcher, scan every 2 minutes instead (NFS/SMB sources)
SYNCLET_WATCH=on
```

- [ ] **Step 4: README**

Write `README.md` (English) with: what Synclet is (one paragraph, the "your folder stays a normal folder" promise), Quickstart (copy `.env.example`, set `SYNCLET_DATA`, `docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build`, open `http://localhost:8080`, setup wizard; username = folder name, existing folders are adopted), "What is written where" table (`/data` only your files + transient `.synclet-tmp-*`; `/meta` trash; Postgres index/journal), Linux inotify note (`fs.inotify.max_user_watches`), NFS/SMB note (`SYNCLET_WATCH=off`; IDs may change on external moves), "Leaving Synclet" (`docker compose down -v` → your folder is untouched), development (`pnpm dev:db`, test DB creation, `pnpm test`), roadmap link to the spec. License section: "TBD by the maintainer before the first public release."

- [ ] **Step 5: Verify**

```bash
mkdir -p /tmp/synclet-docker/files/jens /tmp/synclet-docker/meta && echo hello > /tmp/synclet-docker/files/jens/existing.txt
cp deploy/.env.example deploy/.env && sed -i '' -e 's#^SYNCLET_DATA=.*#SYNCLET_DATA=/tmp/synclet-docker/files#' -e 's#^SYNCLET_META=.*#SYNCLET_META=/tmp/synclet-docker/meta#' -e "s#^PUID=.*#PUID=$(id -u)#" -e "s#^PGID=.*#PGID=$(id -g)#" deploy/.env
docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
curl -s localhost:8080/api/health
```
Expected: `{"ok":true}`; opening `http://localhost:8080` shows setup; creating user `jens` shows `existing.txt` (adopted folder).
Then `docker compose -f deploy/compose.yml --env-file deploy/.env down -v` and `ls -la /tmp/synclet-docker/files/jens` shows only `existing.txt`.

- [ ] **Step 6: Commit**

```bash
git add deploy .dockerignore README.md
git commit -m "build: docker images, compose stack with caddy, README quickstart

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: End-to-end verification – throwaway test and web smoke test

**Files:**
- Create: `scripts/throwaway-test.sh`, `e2e/package.json`, `e2e/playwright.config.ts`, `e2e/tests/files.spec.ts`
- Modify: `pnpm-workspace.yaml` (add `e2e`), root `package.json` (scripts `test:throwaway`, `test:e2e`)

**Interfaces:**
- Consumes: the full stack from Task 11 (`deploy/compose.yml`), Sync API (Task 7), web UI (Tasks 9–10).
- Produces: `pnpm test:throwaway` (exit 0 = folder fidelity proven), `pnpm test:e2e` (Playwright against `http://localhost:8080`).

- [ ] **Step 1: Throwaway test script**

`scripts/throwaway-test.sh`:
```bash
#!/usr/bin/env bash
# Proves the core promise: Synclet writes exactly the visible structure into the folder
# and nothing else; external changes keep IDs; removing the stack leaves a normal folder.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
FILES="$WORK/files"; META="$WORK/meta"
mkdir -p "$FILES/jens/Bestand/Unterordner" "$META"
printf 'alt' > "$FILES/jens/Bestand/alt.txt"
printf 'nfd' > "$FILES/jens/Bestand/$(printf 'Cafe\xcc\x81.txt')"   # NFD name as created by macOS
ENV="$WORK/.env"
cat > "$ENV" <<EOF
SYNCLET_DATA=$FILES
SYNCLET_META=$META
PUID=$(id -u)
PGID=$(id -g)
POSTGRES_PASSWORD=throwaway
SYNCLET_PORT=18080
SYNCLET_SITE_ADDRESS=:80
EOF
DC="docker compose -p synclet-throwaway -f $ROOT/deploy/compose.yml --env-file $ENV"
cleanup() { $DC down -v >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
$DC up -d --build
for i in $(seq 1 60); do curl -fs localhost:18080/api/health >/dev/null && break; sleep 2; done

B=http://localhost:18080/api
TOKEN=$(curl -fs -XPOST $B/setup -H 'content-type: application/json' \
  -d '{"username":"jens","displayName":"Jens","password":"correct horse battery"}' | jq -r .accessToken)
H=(-H "authorization: Bearer $TOKEN")
sleep 3  # initial scan

# 1) API writes land 1:1 on disk.
DOCS=$(curl -fs "${H[@]}" -XPOST $B/sync/v1/items -H 'content-type: application/json' -d '{"parentId":"root","type":"folder","name":"Dokumente"}' | jq -r .id)
F=$(curl -fs "${H[@]}" -XPOST "$B/sync/v1/items/upload?parentId=$DOCS&name=Angebot%20%C3%BC.txt" -H 'content-type: application/octet-stream' --data-binary 'hallo' | jq -r .id)
curl -fs "${H[@]}" -XPATCH "$B/sync/v1/items/$F" -H 'content-type: application/json' -d '{"name":"Angebot final.txt"}' >/dev/null
TMPF=$(curl -fs "${H[@]}" -XPOST "$B/sync/v1/items/upload?parentId=root&name=weg.txt" -H 'content-type: application/octet-stream' --data-binary 'x' | jq -r .id)
curl -fs "${H[@]}" -XDELETE "$B/sync/v1/items/$TMPF" >/dev/null

# 2) External move keeps the ID.
ALT=$(curl -fs "${H[@]}" "$B/sync/v1/items/root/children" | jq -r '.items[] | select(.name=="Bestand") | .id')
ALT_FILE=$(curl -fs "${H[@]}" "$B/sync/v1/items/$ALT/children" | jq -r '.items[] | select(.name=="alt.txt") | .id')
mv "$FILES/jens/Bestand/alt.txt" "$FILES/jens/Dokumente/alt-verschoben.txt"
sleep 6
MOVED=$(curl -fs "${H[@]}" "$B/sync/v1/items/$DOCS/children" | jq -r '.items[] | select(.name=="alt-verschoben.txt") | .id')
[ "$MOVED" = "$ALT_FILE" ] || { echo "FAIL: ID changed on external move ($ALT_FILE -> $MOVED)"; exit 1; }

# 3) NFD name from disk is listed and downloadable.
NFD=$(curl -fs "${H[@]}" "$B/sync/v1/items/$ALT/children" | jq -r '.items[] | select(.type=="file") | .id' | head -1)
[ "$(curl -fs "${H[@]}" "$B/sync/v1/items/$NFD/content")" = "nfd" ] || { echo "FAIL: NFD file not served"; exit 1; }

# 4) Tear down and compare the folder with the expected tree.
$DC down -v
ACTUAL=$(cd "$FILES" && find . -mindepth 1 | LC_ALL=C sort)
EXPECTED=$(printf '%s\n' ./jens ./jens/Bestand "./jens/Bestand/$(printf 'Cafe\xcc\x81.txt')" ./jens/Bestand/Unterordner \
  ./jens/Dokumente "./jens/Dokumente/Angebot final.txt" ./jens/Dokumente/alt-verschoben.txt | LC_ALL=C sort)
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "FAIL: folder differs"; diff <(echo "$EXPECTED") <(echo "$ACTUAL"); exit 1
fi
[ "$(cat "$FILES/jens/Dokumente/Angebot final.txt")" = "hallo" ] || { echo "FAIL: content"; exit 1; }
ls "$META/trash"/*/weg.txt >/dev/null || { echo "FAIL: deleted file not in /meta/trash"; exit 1; }
echo "PASS: folder is a plain 1:1 copy of what Synclet showed, metadata stayed outside"
```
Root `package.json` scripts: `"test:throwaway": "bash scripts/throwaway-test.sh"`.

Run: `pnpm test:throwaway`
Expected: `PASS: …`. Requires `jq`, Docker. This also runs the server's case-sensitive tests' scenario on Linux (container FS is the host bind mount; on macOS hosts the bind mount is case-insensitive – case-variant coverage is the server test suite on Linux CI, see Step 3).

- [ ] **Step 2: Playwright web smoke test**

`e2e/package.json`: name `@synclet/e2e`, devDependency `@playwright/test`, script `"test": "playwright test"`.
`e2e/playwright.config.ts`:
```ts
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: { baseURL: process.env.SYNCLET_URL ?? 'http://localhost:8080', trace: 'retain-on-failure' },
  timeout: 60_000,
});
```
`e2e/tests/files.spec.ts`:
```ts
import { expect, test } from '@playwright/test';

// Runs against a fresh stack (empty DB). Locale forced to German to assert the default UI language.
test.use({ locale: 'de-DE' });

test('setup, upload, rename, move, delete, download', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/setup/);
  await page.getByLabel('Benutzername').fill('e2e');
  await page.getByLabel('Anzeigename').fill('E2E');
  await page.getByLabel('Passwort').fill('correct horse battery');
  await page.getByRole('button', { name: 'Konto anlegen' }).click();
  await expect(page).toHaveURL(/\/files/);

  await page.getByRole('button', { name: 'Neu' }).click();
  await page.getByRole('menuitem', { name: 'Ordner' }).click();
  await page.getByRole('textbox').fill('Projekte');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Projekte')).toBeVisible();

  await page.locator('input[type=file]').setInputFiles({ name: 'notiz.txt', mimeType: 'text/plain', buffer: Buffer.from('hallo') });
  await expect(page.getByText('notiz.txt')).toBeVisible();

  await page.getByText('notiz.txt').click();
  await page.keyboard.press('F2');
  await page.getByRole('textbox').fill('notiz-neu.txt');
  await page.keyboard.press('Enter');
  await expect(page.getByText('notiz-neu.txt')).toBeVisible();

  const downloadPromise = page.waitForEvent('download');
  await page.getByText('notiz-neu.txt').dblclick();
  expect((await downloadPromise).suggestedFilename()).toBe('notiz-neu.txt');

  await page.getByText('notiz-neu.txt').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Verschieben' }).click();
  await page.getByRole('dialog').getByText('Projekte').click();
  await page.getByRole('button', { name: 'Verschieben' }).click();
  await expect(page.getByText('notiz-neu.txt')).toBeHidden();

  await page.getByText('Projekte').dblclick();
  await expect(page.getByText('notiz-neu.txt')).toBeVisible();
  await page.getByText('notiz-neu.txt').click();
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Löschen' }).click();
  await expect(page.getByText('notiz-neu.txt')).toBeHidden();
});
```
Run (fresh stack from Task 11 Step 5 with an empty DB): `pnpm --filter @synclet/e2e exec playwright install chromium && pnpm test:e2e`
Expected: 1 passed. Adjust selectors to the actual accessible names used in Task 10 only if the UI copy differs – never weaken the assertions.

- [ ] **Step 3: Linux run of the server suite**

```bash
docker run --rm --network host -v "$PWD":/src -w /src node:24-bookworm bash -c \
  "corepack enable && pnpm install --frozen-lockfile && cd apps/server && pnpm prisma generate && pnpm test"
```
Expected: all tests pass, including `itIfCaseSensitive` ones (no "skipped" warnings). (Uses the dev Postgres on host port 5434.)

- [ ] **Step 4: Commit**

```bash
git add scripts e2e pnpm-workspace.yaml package.json pnpm-lock.yaml
git commit -m "test: throwaway folder-fidelity test and web e2e smoke test

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Out of scope for Phase 1a (planned later)

- 1b: trash UI + restore with original IDs + auto-empty, share links, thumbnails/QuickLook (pg-boss worker), search, tus resumable uploads, folder drag&drop, multi-select.
- 1c: Euro-Office, optional versions, admin UI (users, status), sync-contract conformance package, PKCE app login (`/app-login`, `/api/auth/app/token`) for native clients.
- Phase 2+: native clients, SSE `/events`, APNs pushes.
