# Synclet Phase 4 – Spaces (Team Folders + External Storage)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Besides each user's personal folder, Synclet serves shared **spaces** — team folders under `/teams/<name>` and auto-detected external storages under `/storage/<name>` — with group/user membership (read or read+write), in the server, web, admin UI, macOS and iOS clients.

**Architecture:** A new `Space` table becomes the tenant key everywhere `ownerId` was. The personal space's id **equals the user id**, so existing rows keep working: the migration renames columns and inserts one personal `Space` per user, with no data rewrite. A `SpaceAccess` service answers "which role does this user have here". All server paths resolve disk locations via the space's `rootPath`. Discovery turns directories under `/teams` and `/storage` into spaces, and the indexer, watcher, journal, SSE and API work per space. The Sync API stays backward compatible: `space` defaults to `personal`.

**Tech Stack:**
- Server: NestJS 11, Fastify 5, Prisma 6, Postgres 16, `@parcel/watcher`, vitest
- Web: React, Vite, Tailwind, shadcn, TanStack Query, react-i18next, Playwright
- Apple: SyncletKit (Swift 6), macOS app, iOS app

**Spec:** `docs/superpowers/specs/2026-10-16-phase-4-spaces-design.md` (binding).

**Read before starting:**
- `docs/sync/SYNC_API.md`, `packages/sync-contract/`
- server `apps/server/src/{common/paths.ts, journal/*, indexer/*, files/*, sync/*, trash/*, versions/*, shares/*, search/*, office/*, events/*, admin/*, uploads/tus.ts, derivatives/*}`
- test helpers `apps/server/test/context.ts`

## Global Constraints

- **Personal spaces:**
  - `Space.id = User.id`; the personal API space id is `"personal"` and its root id is `"root"`. Both must keep working for existing clients.
  - Other spaces: API space id = the Space uuid, root id `r_<uuid>`, `kind` = `"shared"` for team folders and `"external"` for storages.
  - Spaces order: personal, then team folders, then external storages, each by name.
- **Access:**
  - No access → `404 not_found`. A write attempt with read-only access → `403 forbidden`.
  - A space with `status missing` → `503 space_unavailable` for its content, and it is listed with `canWrite: false`.
  - Admins have no implicit access to spaces.
- **API defaults:** `GET /sync/v1/cursor` and `/changes` take `?space=<id>`, defaulting to `personal`. `SyncItem.spaceId` is additive.
- **SSE:** `hello` adds `cursors` (space id → cursor); `changes` carries the real space id; a new event `account` has no data.
- **Config:** `SYNCLET_TEAMS_ROOT` (default `/teams`), `SYNCLET_STORAGE_ROOT` (default `/storage`). Both are optional; a missing directory means no spaces of that kind.
- **Discovery:**
  - Synclet never deletes a space folder. "Remove" only drops the Space row, its members and its index.
  - Newly discovered spaces have no members.
- **Server code style:**
  - English code, de + en UI strings.
  - Mutations run in `prisma.$transaction(..., TX_OPTS)` under the space lock (`journal.lockSpace`).
  - Server error JSON is flat: `{statusCode, message, code, item?}`.
  - `/data`, `/teams` and `/storage` hold only user content.
- **Machine safety:**
  - No `pkill`/`killall` by pattern.
  - No `docker volume/system/image prune`; no `docker rm -f` or `down -v` on anything you didn't create.
  - No `xcrun simctl erase/delete all`.
  - Server tests in parallel worktrees use a private `TEST_DATABASE_URL` database on the dev Postgres (port 5434). Create it yourself, drop only it.
- **Git:** work only in your worktree/branch; never push; never touch `main`.

## Review Focus

- **Leaks between spaces:** every route that takes an item id must 404 for an item in a space the caller cannot read. That includes content, download token, thumbnail, preview-text, children, PATCH, DELETE, tus parent/replace, versions, office, share create and trash restore. Pinned in Task 3 (`access-matrix.e2e.spec.ts`, which iterates all routes).
- **Upgrade of an existing installation:** after the migration, existing items, journal cursors, trash entries, versions and share links still work, and old clients without `?space=` see no difference. Pinned in Task 1 (`migration.spec.ts`, which seeds pre-migration rows via raw SQL on the previous schema).
- **An unplugged NAS:** if `/storage/nas` is empty or missing while items are known, nothing is deleted from the index, the space shows `missing`, and it recovers when the mount returns. Pinned in Task 2 (`discovery.spec.ts`: `testMissingMountKeepsItems`).
- **Moving between personal and team space**, including across file systems (EXDEV): the item id is kept, and both journals report the move correctly. Pinned in Task 3 (`cross-space-move.e2e.spec.ts`, with EXDEV simulated through an injected `moveNoReplace` failure).
- **Losing access while connected:** removing a user from a group sends `account` over SSE, and the space disappears from `/account` at once. Pinned in Task 5 (`admin-spaces.e2e.spec.ts`: `testRemovingMemberEmitsAccountEvent`).

---

## Execution waves (controller)

1. **T1** Schema, migration and the ownerId→spaceId refactor (behaviour unchanged). Runs alone.
2. **T2** Space access, discovery, config and compose; indexer, watcher and journal per space.
3. **T3** Sync API: spaces, roots, `spaceId`, access checks, `?space=`, cross-space move, SSE.
4. **T4** (search, recent, trash, versions, shares, office) and **T5** (admin API for groups and spaces, contract docs and conformance) in parallel.
5. **T6** (web files UI), **T7** (web admin UI) and **T8** (SyncletKit and macOS) in parallel.
6. **T9** iOS app.
7. **T10** live scripts, docs, deploy notes, follow-ups.

Worktrees `/Volumes/Daten/Privat/Synclet-wt/4-tN`, branches `phase4/task-N` off `phase-4`.

---

### Task 1: Space schema, migration, and the ownerId→spaceId refactor

**Files:**
- Modify: `apps/server/prisma/schema.prisma`
- Create: `apps/server/prisma/migrations/20261016120000_phase_4_spaces/migration.sql`
- Modify: every server file that uses `ownerId`, `IndexUser` or `userRoot`/`absPath` for disk or tenant purposes (≈60 sites; see `grep -rn "ownerId\|IndexUser\|userRoot\|absPath\|lockUser" apps/server/src`)
- Modify: `apps/server/src/common/paths.ts`, `apps/server/src/common/types.ts`, `apps/server/src/journal/journal.service.ts`
- Modify: `apps/server/test/context.ts` (`createTestUser` also creates the personal Space; add `"Space","Group","GroupMember","SpaceMember"` to the TRUNCATE list)
- Test: `apps/server/src/spaces/migration.spec.ts`, plus `test/schema-drift.spec.ts` must stay green

**Interfaces:**
- Produces:

```prisma
enum SpaceKind { personal team external }
enum SpaceStatus { available missing }
enum SpaceWatch { auto off }
enum SpaceRole { read write }
model Space {
  id String @id @db.Uuid
  kind SpaceKind
  name String
  rootPath String
  userId String? @unique @db.Uuid
  user User? @relation(fields: [userId], references: [id], onDelete: Cascade)
  readOnly Boolean @default(false)
  status SpaceStatus @default(available)
  watch SpaceWatch @default(auto)
  scanIntervalSec Int?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  items Item[]
  members SpaceMember[]
  scope SyncScope?
}
model Group { id String @id @default(uuid()) @db.Uuid  name String  nameKey String @unique  createdAt DateTime @default(now())  members GroupMember[]  spaces SpaceMember[] }
model GroupMember { groupId String @db.Uuid  userId String @db.Uuid  group Group @relation(fields:[groupId], references:[id], onDelete: Cascade)  user User @relation(fields:[userId], references:[id], onDelete: Cascade)  @@id([groupId, userId]) }
model SpaceMember { id String @id @default(uuid()) @db.Uuid  spaceId String @db.Uuid  userId String? @db.Uuid  groupId String? @db.Uuid  role SpaceRole
  space Space @relation(fields:[spaceId], references:[id], onDelete: Cascade)  user User? @relation(fields:[userId], references:[id], onDelete: Cascade)  group Group? @relation(fields:[groupId], references:[id], onDelete: Cascade)
  @@unique([spaceId, userId]) @@unique([spaceId, groupId]) }
```

- Column renames (values unchanged):
  - `Item.ownerId → spaceId` (relation to Space)
  - `SyncScope.userId → spaceId` (FK to Space)
  - `TrashEntry.ownerId → spaceId`, plus new `deletedBy String? @db.Uuid`
  - `FileVersion.ownerId → spaceId`
  - `ShareLink` keeps `ownerId` and gains `spaceId String @db.Uuid`
- Indexes are renamed to `Item_space_path_live_key` and `Item_space_mtime_idx` (raw SQL partial indexes in the migration) and the `@@index([spaceId, …])` equivalents.
- `common/types.ts`: `export interface IndexSpace { id: string; kind: 'personal'|'team'|'external'; rootPath: string; }`. Disk operations take an `IndexSpace` instead of an `IndexUser`. `AuthUser` stays the caller.
- `common/paths.ts`: `absPath(root: string, rel: string)` replaces `absPath(dataRoot, username, rel)`. `userRoot` stays only for creating personal roots.
- `JournalService.lockSpace(tx, spaceId)`. `record`, `currentCursor`, `changesSince` and `trim` are keyed by `spaceId`, and `pg_notify('synclet_changes', spaceId)` (same values as before for personal).
- `SpacesRepo` (`apps/server/src/spaces/spaces.repo.ts`):
  - `personalFor(userId): Promise<IndexSpace>`
  - `byId(id): Promise<IndexSpace | null>`
  - `toIndexSpace(row)`
- In T1, every request-path call resolves `personalFor(user.id)`, so behaviour is unchanged.
- The migration SQL, in order:
  1. Create the enums and tables.
  2. `INSERT INTO "Space"(id, kind, name, "rootPath", "userId", "createdAt", "updatedAt") SELECT id, 'personal', username, '<placeholder>', id, now(), now() FROM "User"`. `rootPath` for personal spaces is recomputed at boot from config (`dataRoot/username`) by `SpacesRepo.syncPersonalRoots()`, because the container path is config-dependent. Store `''` in the migration and fill it at startup.
  3. Rename the columns.
  4. Re-point the FKs, then add the `ShareLink.spaceId` backfill `UPDATE "ShareLink" SET "spaceId" = "ownerId"` and set it NOT NULL.
  5. Recreate the raw partial indexes under the new names.
- User creation (`users.service.ts` and SSO provisioning) creates the personal Space in the same transaction.

- [ ] **Step 1: Write the failing migration test.**
  - `migration.spec.ts`:
    1. Applies migrations up to `20261015200000_session_revoked_reason` on a fresh database.
    2. Inserts raw rows: a user, items, a SyncScope with seq 7, FileChange rows, a TrashEntry, a FileVersion and a ShareLink.
    3. Applies the Phase 4 migration.
    4. Asserts: Space(personal, id = user.id); `Item.spaceId = user.id`; `SyncScope.spaceId` seq still 7; `ShareLink.spaceId = ownerId`; TrashEntry and FileVersion `spaceId` set.
  - Use `prisma migrate` programmatically through `child_process` with `DATABASE_URL` pointing at a private database. See how `test/global-setup.ts` migrates.
- [ ] **Step 2: Run it to verify it fails.** Run `pnpm --filter @synclet/server exec vitest run src/spaces/migration.spec.ts` → FAIL (migration missing).
- [ ] **Step 3: Write the schema, migration and refactor.**
  - Write the schema, the migration and `SpacesRepo`.
  - Mechanically refactor the code: `ownerId` → `spaceId`, `IndexUser` → `IndexSpace` for disk work, `lockUser` → `lockSpace`.
  - `createTestUser` returns `{ id, username }` and also creates `Space(personal, rootPath: <dataRoot>/<username>)`. Add a helper `personalSpace(ctx, user): IndexSpace`.
  - Update the existing specs only where the renamed field names appear.
- [ ] **Step 4: Run all checks.**
  - `pnpm --filter @synclet/server exec prisma generate`
  - `pnpm --filter @synclet/server typecheck`
  - `pnpm --filter @synclet/server test`: all 647+ existing tests green, plus the migration test
  - `schema-drift.spec` green
- [ ] **Step 5: Commit.** `git commit -m "refactor(server): spaces as tenant key (personal space id = user id)"`

---

### Task 2: Space access, discovery, config/compose, indexer/watcher/journal per space

**Files:**
- Create: `apps/server/src/spaces/space-access.service.ts`, `apps/server/src/spaces/discovery.service.ts`, `apps/server/src/spaces/spaces.module.ts`
- Modify: `apps/server/src/config.ts` (`teamsRoot`, `storageRoot`), `deploy/compose.yml`, `deploy/compose.dev.yml` if relevant, `deploy/.env.example`
- Modify: `apps/server/src/indexer/{scheduler,indexer,watcher}.service.ts`, `apps/server/src/files/files.service.ts` (trash staging per space root; `startupCleanup` per space)
- Test: `apps/server/src/spaces/{space-access,discovery}.spec.ts`, `apps/server/src/indexer/{indexer,watcher,scheduler}.spec.ts` (new cases)

**Interfaces:**
- Consumes (T1): `Space*` models, `IndexSpace`, `SpacesRepo`, `lockSpace`.
- Produces:

```ts
export type Role = 'read' | 'write';
@Injectable() export class SpaceAccess {
  /** Role of `user` in `space` or null (no access). Personal: owner → write. team/external: max(direct, groups);
   *  readOnly → capped at read. Disabled user → null. status missing → role still returned (callers map to 503). */
  roleFor(user: { id: string }, space: { id: string; kind: string; userId: string | null; readOnly: boolean }): Promise<Role | null>;
  /** All spaces the user can read, ordered: personal, team (by name), external (by name). */
  spacesFor(user: { id: string }): Promise<Array<{ space: SpaceRow; role: Role }>>;
  /** Throws SyncError('not_found') if no access, 'forbidden' if write needed but read only, 'space_unavailable' (503) if missing. */
  require(user: { id: string }, spaceId: string, need: Role): Promise<{ space: IndexSpace; role: Role }>;
  /** User ids affected by a membership/space change (for SSE `account`). */
  usersOf(spaceId: string): Promise<string[]>;
}
@Injectable() export class DiscoveryService {
  /** Scans teamsRoot and storageRoot; creates new spaces (no members), marks missing/available, detects readOnly. Returns changed space ids. */
  discover(): Promise<{ created: string[]; changed: string[] }>;
  createTeam(name: string): Promise<SpaceRow>;            // mkdir teamsRoot/<name> + Space(kind team)
  renameTeam(id: string, name: string): Promise<SpaceRow>; // rename on disk + row
  removeSpace(id: string): Promise<void>;                  // team only: drop row/members/items/journal; folder stays
}
```

- `SyncError` gets the code `space_unavailable` with status 503 (`common/sync-error.ts`).
- **Discovery rules:**
  - Direct subdirectories only. Skip symlinks, dot names and the indexer ignore list.
  - Name = directory name.
  - A space is `missing` when its root is not a directory, or when it is empty while the space has more than 0 live items **and** the parent root (`/storage` or `/teams`) looks unmounted. For external storages, an empty mount point counts as missing whenever items are known.
  - `readOnly` = `access(root, W_OK)` fails.
- **Scheduler:** iterates `spaces where status = available`, honours `scanIntervalSec`, and calls `discovery.discover()` before each cycle and at startup.
- **Watcher:** subscribes `dataRoot` (route by the first segment through the personal-space map), `teamsRoot` (route by the first segment) and each external root separately (skipped when `watch = off`; a subscribe error falls back to scan-only for that space). Debounce key `${spaceId}\0${dir}`.
- **Compose:**
  - server: `${SYNCLET_TEAMS:-./teams}:/teams`
  - worker: `:/teams:ro`
  - commented examples for `/storage/<name>`: a bind mount, and a named CIFS volume (`driver: local`, `driver_opts: {type: cifs, device: //nas/share, o: "username=…,password=…,uid=${PUID},gid=${PGID},file_mode=0664,dir_mode=0775"}`)

- [ ] **Step 1: Write the failing tests.**
  - `space-access.spec.ts`:
    - the owner gets write on personal; another user gets null on personal; an admin gets null
    - direct member read vs group member write → write
    - a readOnly space caps at read
    - a disabled user → null
    - `spacesFor` ordering
    - `require` throws 404, 403 and 503 correctly
  - `discovery.spec.ts`:
    - `testNewTeamAndStorageDirsBecomeSpaces`
    - `testDotAndSymlinkDirsIgnored`
    - `testMissingMountKeepsItems`: the space has items, the storage dir is emptied → status missing, items untouched, scan refuses
    - `testReturnedMountBecomesAvailable`
    - `testReadOnlyDetected`: chmod 555 on the root; skip as root
    - `testCreateRenameRemoveTeam`: the folder still exists after remove
  - Indexer and watcher specs:
    - a file created under `/teams/Familie/x.txt` is indexed into the team space and journaled under its `spaceId`
    - an external space with `watch off` is scan-only
- [ ] **Step 2: Run them to verify they fail**, then implement.
- [ ] **Step 3: Run all checks.** Full server tests green and typecheck clean. `docker compose -f deploy/compose.yml config` validates with `SYNCLET_TEAMS` unset (default) and set.
- [ ] **Step 4: Commit.** `git commit -m "feat(server): space access, discovery of /teams and /storage, indexing per space"`

---

### Task 3: Sync API per space (spaces, roots, spaceId, access checks, ?space=, cross-space move, SSE)

**Files:**
- Modify: `apps/server/src/sync/{sync.controller,serializer.service,sync-ids}.ts`, `apps/server/src/files/files.service.ts` (cross-space move), `apps/server/src/uploads/tus.ts`, `apps/server/src/events/{events.controller,change-notifier}.ts`, `apps/server/src/auth/auth.service.ts` (download token carries the space), `apps/server/src/derivatives/*` (thumbnail/preview access), `packages/shared/src/index.ts` (`SyncItem.spaceId`, `SyncSpace`)
- Test: `apps/server/src/sync/access-matrix.e2e.spec.ts`, `apps/server/src/sync/spaces.e2e.spec.ts`, `apps/server/src/files/cross-space-move.e2e.spec.ts`, `apps/server/src/events/events.e2e.spec.ts` (new cases)

**Interfaces:**
- Consumes (T2): `SpaceAccess`, `IndexSpace`, `SyncError('space_unavailable')`.
- Produces:
  - Ids:
    - `sync-ids.ts`: `spaceRootId(spaceId) = 'r_' + spaceId`, `parseRootId(id): string | null`.
    - The API space id is `'personal'` for the caller's own personal space, else the uuid.
    - `SyncController.resolve(user, rawId, need: Role)` returns `{ space, item | null }`, where null means the space root.
  - Account and items:
    - `GET /account` → `spaces` per the Global Constraints.
    - `SyncItem.spaceId`.
    - The virtual root item for `r_<uuid>` (kind `root`, name = space name; capabilities: read only, `addChildren = role === 'write'`).
  - Cursors: `GET /cursor?space=` and `GET /changes?space=&cursor=`. An unknown or inaccessible space → 404. `children` returns the cursor of the folder's space.
  - Cross-space move: `FilesService.update` with a target parent in another space requires write on both, then:
    1. Lock both spaces in ascending id order.
    2. Move on disk with `moveNoReplace`; on EXDEV use copy + remove through the existing `moveAcrossFs`.
    3. Set `Item.spaceId` for the subtree, rewrite the paths, and record a `delete` (subtree) in the source journal and an `upsert` (subtree) in the target journal.
  - SSE:
    - `ChangeNotifier.subscribe(spaceId, cb)`.
    - The events controller subscribes to every readable space of the user and writes `event: changes {space: <apiId>, cursor}`.
    - `hello` → `{ cursor, cursors: { <apiId>: cursor } }`.
    - `notifyAccount(userIds)` publishes `pg_notify('synclet_account', userId)` and is listened to by the notifier, giving `event: account` with `data: {}`. Streams also re-subscribe to the user's new space set.
  - Access in other routes:
    - The download token payload gains `s` (spaceId) and is checked against access on use.
    - tus `validateMeta` resolves the parent and the replace target through `resolve(..., 'write')`.
    - Thumbnail and preview-text require `read`.

- [ ] **Step 1: Write the failing e2e tests.**
  - `access-matrix.e2e.spec.ts`:
    - Users alice (member, write) and bob (no access), plus carol (read).
    - For each route — GET item/children/content/thumbnail/preview-text, POST download-token, PUT content, POST upload, POST items (folder), PATCH, DELETE, tus create (parent) and tus replace — assert: bob → 404; carol read routes → 200 and write routes → 403; alice → 2xx.
    - Also: a missing space → 503 `space_unavailable` on content.
  - `spaces.e2e.spec.ts`:
    - `/account` spaces order and ids
    - `/items/r_<uuid>`
    - children of a team root have `parentId r_<uuid>` and `spaceId`
    - `/changes?space=<uuid>` sees team edits, and `/changes` (personal) does not
    - an old client without `space` gets an unchanged personal feed
  - `cross-space-move.e2e.spec.ts`:
    - personal → team and back: the id is kept, the file is on disk at its new place
    - the personal feed has a delete and the team feed an upsert
    - EXDEV path through an injected `moveNoReplace` that throws EXDEV once
    - a target without write → 403, nothing moved
  - Events:
    - an edit in the team space emits `changes` with the team uuid to member streams only
    - hello contains `cursors`
    - `notifyAccount` emits `account`
- [ ] **Step 2: Run them to verify they fail**, then implement.
- [ ] **Step 3: Run all checks.** Full server tests and typecheck.
- [ ] **Step 4: Commit.** `git commit -m "feat(server): Sync API per space – roots, access checks, per-space changes, cross-space move, SSE"`

---

### Task 4: Search, recent, trash, versions, shares, office per space

**Files:**
- Modify: `apps/server/src/search/{search.service,search.controller}.ts`, `apps/server/src/trash/{trash.service,trash.controller}.ts`, `apps/server/src/versions/*`, `apps/server/src/shares/{shares.service,share-auth}.ts`, `apps/server/src/office/*`, `apps/server/src/admin/admin-shares.controller.ts`, `packages/shared/src/index.ts` (`TrashEntryWire.spaceId`/`deletedBy`, `ShareLinkWire.spaceId`, search hit `item.spaceId`)
- Test: the e2e specs next to each module (new cases)

**Interfaces:**
- Consumes (T2/T3): `SpaceAccess.spacesFor/require`, the API id mapping (`'personal'` / uuid), `IndexSpace`.
- Produces:
  - **Search and recent:** filter `spaceId IN (readable spaces)`, with optional `space=<apiId>`. Each hit's `item.spaceId` is the API id.
  - **Trash:**
    - List: spaces with write.
    - Restore and delete-forever require write.
    - `DELETE /trash` empties only the personal space unless `?space=` is given.
    - `deletedBy` is set on delete.
    - Restore in a team space puts the item back in that space.
  - **Versions:** `/meta/versions/<spaceId>/…`; listing requires read, restore requires write.
  - **Shares:**
    - Create requires write.
    - Public access checks that the creator is enabled **and** still has write in `share.spaceId` (else 404).
    - The owner list shows the user's own links; the admin list shows the space name.
  - **Office:**
    - The token carries the space id.
    - The callback writes into the item's space via `IndexSpace`.
    - Opening requires write for edit mode, otherwise view mode if the Document Server config supports it. Otherwise read-only users get 403.

- [ ] **Step 1: Write the failing tests:**
  - search finds team files for members and not for others
  - `space` filter
  - recent includes team files
  - trash: delete in team → visible to write members, not to read members; restore by another member works; `deletedBy` set
  - versions in team
  - share link created by alice in team stops working (404) after alice is removed from the space
  - office callback writes into the team folder on disk
- [ ] **Step 2: Run them to verify they fail**, then implement. Full server suite green.
- [ ] **Step 3: Commit.** `git commit -m "feat(server): search, recent, trash, versions, shares and office per space"`

---

### Task 5: Admin API (groups, spaces) + contract docs + conformance

**Files:**
- Create: `apps/server/src/admin/admin-groups.controller.ts`, `apps/server/src/admin/admin-spaces.controller.ts`
- Modify: `apps/server/src/admin/admin-users.controller.ts` (groups in the user list/detail), `docs/sync/SYNC_API.md` (§3 spaces, §4 spaceId/roots, §5 `?space=`, §5a cursors/account event, §1 `space_unavailable`, §8.2 cross-space move, §11/§11a space fields, §13), `packages/sync-contract/openapi.yaml`, `packages/sync-contract/tests/*`
- Test: `apps/server/src/admin/admin-spaces.e2e.spec.ts`, `admin-groups.e2e.spec.ts`; conformance `spaces.test.ts`

**Interfaces:**
- Consumes: `DiscoveryService.createTeam/renameTeam/removeSpace/discover`, `SpaceAccess.usersOf`, `ChangeNotifier.notifyAccount`.
- Produces (admin only, `role = admin`, device tokens rejected as today):
  - Groups:
    - `GET /api/admin/groups` → `[{id, name, members: [{id, username, displayName}]}]`
    - `POST {name}`, `PATCH /:id {name?, memberIds?}`, `DELETE /:id`
  - Spaces:
    - `GET /api/admin/spaces` → `[{id, kind: 'team'|'external', name, rootPath, status, readOnly, watch, scanIntervalSec, sizeBytes, itemCount, members: [{kind:'user'|'group', id, name, role}]}]`
    - `POST {name}` creates a team folder
    - `PATCH /:id {name? (team only), watch?, scanIntervalSec?, members?: [{kind, id, role}]}` replaces the member list
    - `DELETE /:id` (team only)
    - `POST /:id/scan`
  - Every membership, space or group change calls `notifyAccount(affected user ids)` (before ∪ after).
  - Validation:
    - Team names follow the same name rules as file names, and must be unique in `/teams` (nameKey).
    - A group name is unique (nameKey).

- [ ] **Step 1: Write the failing tests:**
  - CRUD for groups and spaces
  - a non-admin → 403
  - renaming an external space → 400
  - deleting an external space → 400
  - `testRemovingMemberEmitsAccountEvent`: an SSE stream of the removed user receives `account`, and `/account` no longer lists the space
  - conformance: `spaces` shape, `?space=` cursor/changes with a device token, a non-member gets 404 on the team root
- [ ] **Step 2: Run them to verify they fail**, then implement and write the docs.
  - `pnpm --filter @synclet/sync-contract lint` → valid.
  - The full server suite and the conformance suite are green.
- [ ] **Step 3: Commit.** `git commit -m "feat(server): admin API for groups and spaces; Sync API contract for spaces"`

---

### Task 6: Web files UI with spaces

**Files:**
- Modify: `apps/web/src/components/app-shell/Sidebar.tsx`, `apps/web/src/features/files/{FilesPage,Breadcrumbs,FileActions,MoveDialog,queries,EmptyState}.tsx|ts`, `apps/web/src/features/search/*`, `apps/web/src/features/recent/*`, `apps/web/src/features/trash/*`, `apps/web/src/locales/{de,en}.json`
- Create: `apps/web/src/features/spaces/{useSpaces.ts, SpaceIcon.tsx, ReadOnlyBanner.tsx}`
- Test: unit tests next to the files; Playwright `e2e/tests/spaces.spec.ts`

**Interfaces:**
- Consumes (T3/T4/T5): `/sync/v1/account` `spaces`, `SyncItem.spaceId`, `r_<uuid>` roots, item capabilities, search/trash `spaceId`, admin API (Playwright setup only).
- Produces:
  - `useSpaces()` → `{ spaces: SyncSpace[], byId(apiId), rootOf(apiId) }`, refreshing every 30 s and on window focus.
  - Sidebar: "Meine Dateien", then the section "Bereiche" with one entry per non-personal space, navigating to `/files/r_<uuid>`. Icons: `Users` (shared) and `HardDrive` (external). A lock badge when `!canWrite`; "Nicht verfügbar" when a 503 is hit.
  - Breadcrumb root = space name.
  - `ReadOnlyBanner` „Nur lesen“; write actions hidden by capabilities (`addChildren` for upload/new).
  - The move dialog lists the spaces with write as top-level targets.
  - Search, recent and trash rows show the space name when it is not personal.

- [ ] **Step 1: Write the failing tests:**
  - unit: sidebar renders the spaces from a mocked account; a read-only folder hides upload/new/rename/delete; breadcrumb root label
  - Playwright `spaces.spec.ts`:
    1. The admin creates group "Familie" with user "kim" and a team "Familie" with the group (write) via the admin API.
    2. kim sees "Familie" in the sidebar and uploads a file.
    3. A second user "lu" with read access sees the file but no upload button.
    4. A third user without access gets "nicht gefunden" for the URL.
- [ ] **Step 2: Run them to verify they fail**, then implement. Web unit tests, typecheck, build, and the Playwright suite (`scripts/e2e-fresh.sh`) are green.
- [ ] **Step 3: Commit.** `git commit -m "feat(web): spaces in sidebar, browser, move, search, trash"`

---

### Task 7: Web admin UI – groups and spaces

**Files:**
- Create: `apps/web/src/features/admin/{GroupsPage,GroupDialog,SpacesPage,SpaceDialog,MembersEditor}.tsx`, queries in `apps/web/src/features/admin/queries.ts`
- Modify: `apps/web/src/features/admin/{AdminLayout,UserDetailPage}.tsx`, `apps/web/src/app/router.tsx` (`/admin/groups`, `/admin/spaces`), locales
- Test: unit tests + Playwright `e2e/tests/admin-spaces.spec.ts`

**Interfaces:**
- Consumes (T5): the admin API for groups and spaces.
- Produces:
  - `/admin/groups`: table and dialog (name, members multi-select).
  - `/admin/spaces`: table with name, kind, path, status badge (verfügbar/nicht verfügbar), "nur lesen" badge, size and members summary. Actions:
    - "Team-Ordner anlegen"
    - "Bearbeiten": name (team only), watch mode and scan interval (external only), members editor with rows of group or user + role select
    - "Jetzt scannen"
    - "Entfernen" (team only), with the confirmation text „Der Ordner bleibt auf der Platte erhalten.“
  - Hint text on external storages: how to mount (link to the docs section from T10).
  - The user detail page shows the user's groups.

- [ ] **Step 1: Write the failing tests:** the members editor adds and removes rows and changes roles; the dialog validation (name rules); Playwright: create a group and a team folder, assign, rename, remove.
- [ ] **Step 2: Run them to verify they fail**, then implement. Web tests, typecheck, build and Playwright are green.
- [ ] **Step 3: Commit.** `git commit -m "feat(web): admin pages for groups and spaces"`

---

### Task 8: SyncletKit + macOS – per-space feeds

**Files:**
- Modify: `apps/apple/SyncletKit/Sources/SyncletKit/API/SyncAPIClient.swift` (`cursor(space:)`, `changes(space:since:limit:)`), `Models/SyncModels.swift` (`SyncItem.spaceId: String?`, `SyncSpaceKind` handles `shared`), `FileProvider/{SpaceLayout,FileProviderEnumerator,SyncletReplicatedExtension}.swift`, `Events/EventStream.swift` (`.account` signal, `hello` cursors), `Account/AccountManager.swift` (refresh spaces)
- Modify (macOS app): `apps/macos/Synclet/Core/{ChangeMonitor,AccountsModel,PinningModel}.swift`, `apps/macos/Synclet/Views/PinningSettingsView.swift`
- Test: Kit `EnumeratorTests`, `SpaceLayoutTests`, `SyncAPIClientTests`, `EventStreamTests`, `ExtensionTests`; macOS `ChangeMonitorTests`, `PinningModelTests`

**Interfaces:**
- Consumes (T3): `?space=`, `r_<uuid>` roots, `spaceId`, SSE `cursors`/`account`.
- Produces:
  - `SyncAPIClient.cursor(space: String = "personal")` and `changes(space: String = "personal", since:limit:)`.
  - `SpaceLayout.feedSpaces = spaces` (all).
  - The enumerator fetches the cursor and drains the changes per space. The anchor map is already per space; `firstPageCursor` applies only to the enumerated folder's space.
  - `StreamSignal.account` → `AccountManager.updateSpaces` + `signalEnumerator(.rootContainer)` + `.workingSet`.
  - A lost space → the layout drops it, and its items are reported deleted on the next working-set enumeration (a `delete` of the space container identifier).
  - macOS pinning settings list all spaces.

- [ ] **Step 1: Write the failing tests:**
  - an enumerator with two spaces drains two feeds with separate cursors and stores both in the anchor
  - an old server (no `space` support: a 400 on `?space=` for non-personal) → the personal feed keeps working
  - `.account` triggers a layout refresh and a root signal
  - `SpaceLayout` with the `shared` kind shows the space name
  - a cross-space move in Finder sends `PATCH parentId` with the other space's root id
- [ ] **Step 2: Run them to verify they fail**, then implement.
  - `swift test` and `bash scripts/swiftkit-test-ios.sh` are green.
  - macOS `xcodebuild test` is green.
  - `bash scripts/macos-live-tests.sh` is green, with a new live case: a team space on the throwaway server; seed `/teams/Test` in the stack and assign membership through the admin API.
- [ ] **Step 3: Commit.** `git commit -m "feat(apple): per-space change feeds, account event, macOS spaces"`

---

### Task 9: iOS app – spaces

**Files:**
- Modify: `apps/ios/Synclet/Browser/{BrowserShell,FolderView,FolderModel,MovePicker}.swift`, `apps/ios/Synclet/Core/{AccountsModel,ForegroundMonitor}.swift`, `apps/ios/Synclet/Search/*`, `apps/ios/Synclet/Trash/*`, `apps/ios/Synclet/Upload/*`, `apps/ios/SyncletShare/ShareFolderPicker.swift`, String Catalog
- Test: `apps/ios/SyncletTests/*` (new cases), UI flow addition in `SyncletUITests`

**Interfaces:**
- Consumes (T8): `cursor(space:)`, `changes(space:)`, `StreamSignal.account`, `SyncItem.spaceId`.
- Produces:
  - iPhone: in the "Dateien" tab the root list shows "Meine Dateien" plus the spaces (sections „Bereiche“).
  - iPad: the sidebar lists the spaces under each account.
  - Read-only spaces hide write actions; a missing space shows „Nicht verfügbar“.
  - The move picker and the Share-extension folder picker offer the spaces with write access.
  - Search, trash and recent show the space name.
  - `ForegroundMonitor` handles `.account` (refresh the account and signal the working set) and signals per space.

- [ ] **Step 1: Write the failing tests:** account with two spaces → the browser root lists both; read-only hides actions; `.account` refresh; the share target can pick a team folder.
- [ ] **Step 2: Run them to verify they fail**, then implement. `bash scripts/ios-test.sh` (iPhone and iPad) is green, and `bash scripts/ios-live-tests.sh` is green with the UI flow uploading into a team space.
- [ ] **Step 3: Commit.** `git commit -m "feat(ios): spaces in browser, pickers, search and trash"`

---

### Task 10: Docs, deploy notes, follow-ups, end-to-end verification

**Files:**
- Modify: `deploy/README.md` (or create it if absent) with a section "Team-Ordner und externe Speicher": volumes, a CIFS/NFS example, permissions (PUID/PGID, `uid=`/`gid=` mount options), the read-only mount, behaviour on a missing mount, network-FS caveats (scan-only, moves seen as delete+create)
- Modify: `README.md` (feature list), `apps/macos/README.md` and `apps/ios/README.md` (checklist steps for spaces)
- Create: `docs/superpowers/followups/2026-10-16-phase-4-followups.md` (German; rulings, limits, deferred minors from the ledger)

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run the full verification:**
  - server tests
  - web unit tests + Playwright (`scripts/e2e-fresh.sh`)
  - `bash scripts/throwaway-test.sh` (the "Wegwerf-Test", extended with a `/teams` folder: after `down -v` the team folder contains exactly the expected files)
  - SyncletKit (macOS + iOS lane)
  - macOS app tests + `macos-live-tests.sh`
  - iOS app tests + `ios-live-tests.sh`
  - conformance suite
- [ ] **Step 3: Commit.** `git commit -m "docs: spaces deployment guide, checklists, Phase 4 follow-ups"`
