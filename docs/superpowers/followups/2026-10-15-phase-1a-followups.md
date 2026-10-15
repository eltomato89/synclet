# Phase 1a – Follow-ups (aus den Reviews)

Stand: 2026-10-15, Branch phase-1a. Triage aus dem finalen Gesamt-Review (SHOULD-FIX-SOON / FINE) und den per-Task-Reviews.

## Rulings (Entscheidungen während der Umsetzung)
- Ruling: parallel implementers in separate git worktrees (waves of ≤5) instead of strictly sequential — user explicitly asked for up to 5 parallel subagents — costs merge conflicts if wrong (mitigated by T1 module stubs).
- Ruling: T6 dispatched after T5 is merged (T6 tests import IndexerService); wave 2 = T5 + T10 parallel, then T6 — costs some wall-clock.
- Ruling: work on branch phase-1a, not main — skill forbids main without consent; merge to main at finish.
- Ruling: test global-setup uses 'prisma migrate deploy' instead of 'migrate reset' — Prisma blocks AI-run resets without user consent; resetDb() truncates per test anyway — cost if wrong: edited (not new) migrations need a manual test-DB drop
- Ruling: T6 starts on top of unreviewed T5 to save wall-clock — cost if wrong: rebase T6 onto T5 fixes (separate folders, low conflict risk)
- Ruling: mass-delete guard = refuse root diff when root listing empty && live root rows>0 && (!dataRootLooksMounted || rows > SYNCLET_MASS_DELETE_THRESHOLD default 25) — protects clients from journaled mass deletes — cost if wrong: legit "delete everything at root via Finder" needs env override
- Ruling: multi-tab fix client-side via Web Locks + BroadcastChannel; server-side grace window deferred — cost if wrong: non-browser races (e.g. flaky network retry) still revoke all sessions
- Ruling: remove() vacates path inside tx by renaming to user-root staging `.synclet-trash-<id>` (ignored name), post-commit move to /meta/trash, recoverStagedTrash at boot — keeps the "only user files" promise except transient ignored names — cost if wrong: staging dir briefly visible to host users during large cross-FS copies
- Ruling: T7 starts before T6 fix round lands (FilesService interface stable) — cost if wrong: rebase T7
- Ruling: folder etag = opaque `t`+16 hex of sha256(parentId, display name, mtime) instead of t<updatedAtMs> — avoids spurious 412 after ancestor moves — cost if wrong: Buro clients that parse folder etags (they shouldn't) break
- Ruling: admin password reset does not revoke device tokens (devices revoked explicitly; documented) — cost if wrong: stolen device token survives password reset

## Offene Kleinigkeiten (deferred)
- Task 1: minor (deferred): names.spec NFC/NFD test weak — add explicit composed vs decomposed case
- Task 1: minor (deferred): pnpm-workspace onlyBuiltDependencies dead under pnpm 11 (allowBuilds); esbuild missing from allowBuilds
- Task 1: minor (deferred): NODE_OPTIONS inline in test script is POSIX-only; ExperimentalWarning noise
- Task 1: minor (deferred): shared tsconfig ESNext/bundler vs server node resolution — fine while types-only
- Task 1: minor (deferred): octet-stream parser (415 branch) untested
- Task 1: minor (deferred): migrate deploy won't detect edited migrations on existing test DB
- Task 4: minor (deferred): changesSince doesn't validate limit (controller must clamp ≥1)
- Task 4: minor (deferred): tombstoneSubtree returns pre-update rows (deletedAt null)
- Task 4: minor (deferred): prefix predicates can't use path index (per-owner scan)
- Task 4: minor (deferred): concurrency test asserts 1..10 only
- Task 3: minor (deferred): setup race README note; duplicate-user race → 500; '@'/bidi chars in usernames; reuse detection on double refresh (no grace); no max password length/rate limit; Bearer case-sensitive; last-admin self-disable; expired sessions never purged; ServerConfig upsert race
- Task 3: minor (deferred): dummy hash computed lazily (first miss slower)
- Task 5: minor (deferred): source-dir-first move journals subtree delete then upsert (client may re-download); stillAtPath readdir failure treated as moved; document that clients derive child paths from parent
- Task 11: minor (deferred): Caddy max_size 0 block; no HSTS/CSP; Dockerfile.server no USER (compose sets user); prisma CLI via npm (move prisma to dependencies later)
- Task 9: minor (deferred): AuthProvider HMR remount stays loading (dev only); bundle 603kB no code splitting
- Task 5: minor (deferred): raw inode-only UPDATE untested; later chunk stops if parent moved (until next scan); leftover chunk entries not re-checked vs new tombstones; renames/content updates 1 query/row; huge tombstone in one tx
- Task 9: minor (deferred): getSession() stale after login/setup; 401 on refresh not broadcast as logout; no-locks fallback still races
- Task 8: minor (deferred): tombstone purge (1 day) < journal retention (30 d) — T7 changes endpoint must emit delete from FileChange.itemType when row is gone (it does per plan); temp files in subdirs not cleaned; in-flight scan not awaited on destroy; debouncer push after stop
- Task 6: minor (deferred): moveNoReplace check-then-rename TOCTOU for files; copy fallback inside tx can hit timeout; no parent-dir fsync; openRead returns path (symlink swap TOCTOU); rewritePrefix bumps descendant folder updatedAt (spurious 412s) — revisit in T7
- Task 10: minor (deferred): unguarded JSON.parse on 2xx upload response; forget() doesn't evict ['folder', id]; subfolders cache not invalidated after upload; any 400 on folder fetch shown as not found
- Task 6: minor (deferred): m3 EXDEV staging rm failure leaves orphan; m4 undoStaging TrashEntry points at live item, manifest top-only (restore in 1b must handle); m5 ambiguous commit failure leaves empty TrashEntry; m6 replaceAtomic temps in subfolders not cleaned at boot; m7 EXDEV copy inside tx timeout; stale intent files never swept
- Task 7: minor (deferred, final-review triage: fix before native clients): (1) Range resume without If-Range can splice host-edited bytes under old ETag; (3) If-Match: * on PUT returns 412; (4) unknown Content-Type upload → Fastify 415 instead of 400 invalid_request
- Task 7: minor (deferred): download filename uses stored not display name; Range on 0-byte file 416; cross-user tests use random uuid not real second user; open() follows symlink after realpath check (O_NOFOLLOW)
- Task 7: follow-up (Task 2/6 area): display-name shifts beyond same-nameKey siblings not journaled; collisions checked vs stored names not display names
- Task 6: minor (deferred, final-review triage): watcher subscription starts during recovery (delete+recreate churn) — start watcher after SchedulerService.startup(); case-variant hard links same-entry rename no-op; macOS link() follows symlinks in copyThenRemove; crash leftovers in subfolders/meta trash
- Task 12: minor (deferred): throwaway check :622 vacuous on curl failure; new-user scan null not logged; nested folder inode reuse via child-folder evidence; e2e scripts don't install chromium

## Finales Review – Triage
*Fix:* give `WatcherService` an explicit `start()` and have `SchedulerService.onApplicationBootstrap` call it after `startup()`, before `scanAll()`. Keep `refreshUsers()` in the watcher's hook. This is about 10 lines and was already flagged for final triage.

**I2. `SYNCLET_MASS_DELETE_THRESHOLD` (and several other config vars) cannot be set in the shipped deployment.**
`deploy/compose.yml:7-12` passes only `DATABASE_URL`, `SYNCLET_PUBLIC_URL`, `SYNCLET_WATCH`, `SYNCLET_SCAN_INTERVAL` and `SYNCLET_MAX_UPLOAD_BYTES` to the server. `--env-file deploy/.env` only interpolates the compose file; it does not set container env.
*Scenario:* a user deliberately empties their root folder (more than 25 items) in Finder. The scan refuses and logs "set SYNCLET_MASS_DELETE_THRESHOLD=0 temporarily and rescan" (`indexer.service.ts:188-192`). They add it to `deploy/.env` and restart, but nothing changes: the variable never reaches the container. Every scan keeps refusing, `lastFullScanAt` stays null, and the web UI and clients keep showing the deleted files indefinitely.
Also unreachable: `SYNCLET_TOMBSTONE_WINDOW`, `SYNCLET_JOURNAL_RETENTION_DAYS`, `SYNCLET_SECURE_COOKIES`.
*Fix:* add them to `compose.yml` with `${VAR:-}` defaults (empty → default handled by `int()`), list them commented in `deploy/.env.example`, and reword the log message to "…and restart the server (a full scan runs at start)". There is no rescan endpoint.

**I3. README is missing user-relevant facts.** `README.md`:
- No mention of the **macOS Docker Desktop limitation**: Finder renames and moves get new inodes inside the container, so item IDs are not kept (delete + create, clients re-download). Linux hosts are fine. This belongs next to the NFS/SMB note, which says the same thing for network FS.
- No **configuration reference**. `SYNCLET_MASS_DELETE_THRESHOLD` (what the guard does, default 25, 0 = off, when you need it), `SYNCLET_SCAN_INTERVAL`, `SYNCLET_MAX_UPLOAD_BYTES` (default 50 GiB), `SYNCLET_TOMBSTONE_WINDOW`, `SYNCLET_JOURNAL_RETENTION_DAYS`, `SYNCLET_SECURE_COOKIES` and `SYNCLET_PUBLIC_URL` (only affects cookie `Secure`) are undocumented.
- The "What is written where" row lists only `.synclet-tmp-*`. It omits the transient `.synclet-trash-*` staging entries (visible in the user root while a delete is copied to `/meta`, and after a crash until the next start) and the reserved-name rule: files named `.synclet-tmp-<alnum>` in a user root are deleted at startup.
- `/meta` disk usage. `/data` and `/meta` are separate bind mounts, so every delete is a full **copy** into `SYNCLET_META`. That needs free space equal to the deleted folder, and trash is not auto-emptied yet. The spec lists this as a known risk; users should be told.
- Ignored names are never synced (`.DS_Store`, `Thumbs.db`, `desktop.ini`, `~$*`, `._*`, `lost+found`, …).
- Dev section: `pnpm test` uses `TEST_DATABASE_URL` (default `…/synclet_test`), and `migrate deploy` creates the DB, so the manual `CREATE DATABASE` step is unnecessary but harmless.

**I4. `DELETE /items/:id` blocks until the whole entry is copied to `/meta`.**
`apps/server/src/files/files.service.ts:388-393`. `remove()` awaits `finishTrash()` after the commit. Because `/data` and `/meta` are always different mounts, this is `copyThenRemove` (a full recursive copy), not a rename.
*Scenario:* a web user deletes a 40 GB photo folder. The delete is committed and journaled in milliseconds, but the HTTP request (Caddy has no timeouts) and the web `DeleteDialog` (`await onDelete()`) hang for minutes. The `.synclet-trash-…` directory sits visibly in the user's folder the whole time. A user who closes the tab or retries gets `not_found` and is confused.
*Fix:* return after the commit and hand `finishTrash` + `dropIntent` to a serialized background queue. This is safe because the crash case is already covered by `recoverStagedTrash` (TrashEntry exists → `finishTrash`). Await the queue in `onModuleDestroy`.

### Minor

- **M1. Crash leftovers in user data are not cleaned** (core promise "only transient names"). `scheduler.service.ts:65-82` removes only top-level *files* named `.synclet-tmp-*`. Never removed:
  - temps next to the target in subfolders: `replaceAtomic` EXDEV `near` (`fs-ops.ts:73`), and `copyThenRemove` `partial` when restoring into a subfolder (`undoStaging`);
  - `.synclet-tmp-*` *directories* from a folder copy.

  These need a crash plus a nested mount, so they are rare, but they stay forever and are visible to host users. *Fix:* write the temp names into a `/meta/staging` intent (like trash) or sweep recursively during the first full scan (the indexer already walks every dir).
- **M2. Maintenance first runs 24 h after boot** (`scheduler.service.ts:45`). Hosts that restart daily (auto-updates) never trim the journal, purge tombstones, or (later) purge sessions. Run once shortly after the first scan.
- **M3. Expired/revoked `Session` rows are never purged.** Add this to `maintenance()`.
- **M4. Setup on a fresh host whose `SYNCLET_DATA` path Docker auto-created as root.** `users.service.ts:51` runs `mkdir` *after* the user is committed, and it fails with EACCES as `PUID`. Setup returns 500, a retry returns `setup_done`, and the admin exists without a folder (scans refuse). Also, on a wrong or empty mount, `mkdir` creates `/data/<user>`, which then makes `dataRootLooksMounted()` true. *Fix:* `mkdir` (or an access check) before the DB transaction, and a clear error message.
- **M5. Web upload: a transient refresh failure leaves a task stuck in `uploading`.** `uploads.ts:105` calls `void this.refresh().then(...)` without a rejection handler, so a network/5xx refresh error is unhandled. The task never fails and keeps a parallel slot. The same happens with `JSON.parse` on an unexpected 2xx body (`:101`). *Fix:* `.catch(() => { this.fail(t, 'network'); this.pump(); })` and try/catch around the parse.
- **M6. `changes` ordering:** dedupe by `MAX(seq)` can deliver a child before its parent's upsert (parent created, child created, parent renamed). The parent arrives later in the same feed, so a client that applies strictly in order sees an unknown `parentId`. This is likely Buro-compatible, but confirm against the Buro client's apply loop before Phase 2.
- **M7. `BusyPaths` is dead code.** Nothing calls `busy.add()` since FilesService moved all disk mutations under the lock, but the indexer still consults it in five places. Remove it, or document why it is kept.
- **M8. Device tokens survive an admin password reset** (`admin-users.controller.ts:49-51` revokes only web sessions). A stolen device token stays valid after the reset that was meant to evict the attacker. Consider revoking devices too, or offering it as an option.
- **M9. User root that is a symlink is never scanned** (`fullScan` uses `lstat(root).isDirectory()`). This is consistent with the symlink policy, but document it, since some people symlink user folders.
- **M10. Content responses carry no `Cache-Control: private, no-store`.** Shared caches between the user and Caddy could store authenticated content. Low risk, cheap to add.
- **M11. Non-`SyncError` responses lack `code`.** Examples: Nest 404 for unknown routes, Fastify 415/413, 500s. Clients fall back on the status code. This is the same issue as deferred T7(4).

## Deferred-list triage

| # | Item | Verdict |
|---|------|---------|
| T1 | names.spec NFC/NFD test weak | FINE |
| T1 | pnpm `onlyBuiltDependencies` dead / esbuild missing in allowBuilds | FINE |
| T1 | `NODE_OPTIONS` inline POSIX-only, warning noise | FINE |
| T1 | shared tsconfig ESNext/bundler | FINE |
| T1 | octet-stream 415 branch untested | FINE (fold into T7-4) |
| T1 | migrate deploy misses edited migrations on test DB | FINE |
| T4 | `changesSince` doesn't validate limit | FINE (`clampLimit` 1..1000 verified) |
| T4 | `tombstoneSubtree` returns pre-update rows | FINE (callers use id/type/size/path only) |
| T4 | prefix predicates can't use path index | SHOULD-FIX-SOON (multi-TB trees; `text_pattern_ops` index or `parentId` walk) |
| T4 | concurrency test asserts 1..10 only | FINE |
| T3 | setup race (two first admins) | FINE (document: finish setup immediately after first start) |
| T3 | duplicate-user race → 500 | FINE |
| T3 | `@`/bidi chars in usernames | SHOULD-FIX-SOON (reject bidi/control in usernames; folder-name spoofing) |
| T3 | refresh reuse detection without grace | SHOULD-FIX-SOON (client mitigation in place; server grace window for flaky retries) |
| T3 | no login rate limit (max length exists: 200) | SHOULD-FIX-SOON (before recommending public exposure; argon2 makes it a CPU DoS too) |
| T3 | `Bearer` case-sensitive | FINE |
| T3 | last-admin self-disable | SHOULD-FIX-SOON (when admin UI lands) |
| T3 | expired sessions never purged | SHOULD-FIX-SOON (= M3) |
| T3 | ServerConfig upsert race | FINE |
| T3 | dummy hash computed lazily | FINE |
| T5 | source-dir-first move journals delete then upsert | SHOULD-FIX-SOON (before native clients: avoids re-downloads) |
| T5 | `stillAtPath` readdir failure treated as moved | FINE (code now returns "still there" on unreadable parent, `indexer.service.ts:391`) |
| T5 | document clients derive child paths from parent | SHOULD-FIX-SOON (API docs, Phase 2) |
| T5 | raw inode-only UPDATE untested | FINE |
| T5 | later chunk stops if parent moved | FINE (next reconcile catches up) |
| T5 | leftover chunk entries vs new tombstones | FINE |
| T5 | renames/content updates 1 query/row | SHOULD-FIX-SOON (perf) |
| T5 | huge tombstone in one tx | SHOULD-FIX-SOON (an external delete of a ~1M-entry folder can hit the 60 s timeout on every retry; it never converges) |
| T11 | Caddy `max_size 0` block | FINE (0 = unlimited, effectively a no-op; drop or comment) |
| T11 | no HSTS/CSP on web app | SHOULD-FIX-SOON |
| T11 | Dockerfile.server no `USER` | FINE (compose sets `user:`) |
| T11 | prisma CLI via npm | FINE |
| T9 | AuthProvider HMR remount | FINE |
| T9 | 603 kB bundle | FINE |
| T9 | `getSession()` stale / 401 on refresh not broadcast / no-locks fallback races | FINE |
| T8 | tombstone purge < journal retention | FINE (verified: `changes` emits delete from `itemType`) |
| T8 | temp files in subdirs not cleaned | SHOULD-FIX-SOON (= M1, core promise) |
| T8 | in-flight scan not awaited on destroy | FINE (tx rolls back) |
| T8 | debouncer push after stop | FINE |
| T6 | `moveNoReplace` TOCTOU (no-hardlink FS only) | FINE (documented) |
| T6 | copy fallback inside tx can hit timeout | SHOULD-FIX-SOON (nested mounts only; undo path exists) |
| T6 | no parent-dir fsync | FINE |
| T6 | `openRead` returns path (symlink swap TOCTOU) | SHOULD-FIX-SOON (open with `O_NOFOLLOW` + fstat, return the fd) |
| T6 | `rewritePrefix` bumps descendant `updatedAt` → spurious 412 | FINE (resolved by the `folderEtag` ruling) |
| T10 | unguarded `JSON.parse` on 2xx upload | SHOULD-FIX-SOON (= M5) |
| T10 | `forget()` doesn't evict `['folder', id]`; subfolders cache after upload; 400 shown as not found | FINE |
| T6 | m3 EXDEV staging rm failure orphan | SHOULD-FIX-SOON |
| T6 | m4 undoStaging TrashEntry/manifest top-only | SHOULD-FIX-SOON (1b restore must handle) |
| T6 | m5 ambiguous commit failure → empty TrashEntry | SHOULD-FIX-SOON (1b) |
| T6 | m6 `replaceAtomic` temps in subfolders not cleaned | SHOULD-FIX-SOON (= M1) |
| T6 | m7 EXDEV copy inside tx timeout | SHOULD-FIX-SOON |
| T6 | stale intent files never swept | FINE (sweep with M1) |
| T7 | (1) Range resume w/o If-Range splices host-edited bytes under old ETag | SHOULD-FIX-SOON (before native clients: compare fstat with row, reconcile/bump first or 412) |
| T7 | (3) `If-Match: *` on PUT → 412 | SHOULD-FIX-SOON (before native clients) |
| T7 | (4) unknown Content-Type → Fastify 415 without `code` | SHOULD-FIX-SOON (= M11) |
| T7 | download filename uses stored, not display name | FINE (the stored name is the honest one) |
| T7 | Range on 0-byte file → 416 | FINE (RFC-conformant) |
| T7 | cross-user tests use random uuid | SHOULD-FIX-SOON (cheap: add a real second-user test) |
| T7 | `open()` follows symlink after realpath (O_NOFOLLOW) | SHOULD-FIX-SOON (same as openRead) |
| T7 | display-name shifts beyond same-key siblings not journaled; collisions checked vs stored names | SHOULD-FIX-SOON (before native clients; only on case-sensitive hosts with case-duplicates) |
| T6 | **watcher subscription starts during recovery** | **MUST-FIX-BEFORE-MERGE** (= I1) |
| T6 | case-variant hard links same-entry rename no-op | FINE |
| T6 | macOS `link()` follows symlinks in copyThenRemove | FINE (dev-host only) |
| T6 | crash leftovers in subfolders / meta trash | SHOULD-FIX-SOON (= M1) |
| T12 | throwaway check :622 vacuous on curl failure | FINE (cheap to harden) |
| T12 | new-user scan null not logged | FINE (`fullScan` logs the refusal itself) |
| T12 | nested folder inode reuse via child-folder evidence | FINE |
| T12 | e2e scripts don't install chromium | FINE |

## Verdict

**Ready after fixes.** The core is sound: locking, journal, no-clobber I/O, mass-delete guards and security basics all held up under cross-task review, and the full server and web suites pass. Before merging to main, fix:

1. I1 / deferred T6: start the watcher only after `startup()` (cleanup and staged-trash recovery).
2. I2: wire `SYNCLET_MASS_DELETE_THRESHOLD` (plus the tombstone window, journal retention and secure-cookies variables) into `compose.yml` and `.env.example`, and fix the log hint ("restart" instead of "rescan").
3. I3: README covering the macOS Docker Desktop limitation, a configuration reference, `.synclet-trash-*`/reserved and ignored names, and `/meta` copy and disk usage.
4. I4: answer `DELETE` after commit and move to `/meta` in the background.

I1–I3 are small. I4 is a contained change because recovery already covers the background step. Everything else above is SHOULD-FIX-SOON for Phase 1b or before native clients (Phase 2).
