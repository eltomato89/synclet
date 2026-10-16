# Phase 1b – Follow-ups (aus den Reviews)

Stand: 2026-10-15, Branch phase-1b.

## Rulings (Entscheidungen während der Umsetzung)
- Ruling: same parallel-worktree execution as phase 1a (user asked for ≤5 parallel subagents) — cost: merge conflicts in app.module.ts/bootstrap.ts/scheduler.service.ts (several tasks touch them) → controller resolves on merge
- Ruling: T9 (web) may change apps/server auth.service.ts/sync.controller.ts for the preview-token purpose — smallest owner — cost: cross-area diff in a web task
- Ruling: wave 1 (T2,T3,T4,T5) starts on unreviewed T1 head 6ddbae5 — cost: rebase if T1 review changes schema/interfaces
- Ruling: login limiter = per-IP (all attempts, CPU guard 10/6s) + per-(IP+login) consumed only on failure — cost: slow distributed brute force across many IPs not limited
- Ruling: SYNCLET_TRUST_PROXY default false, compose sets true — cost: users running own proxy must set it or rate limits key on proxy IP
- Ruling: boot temp sweep without age gate (nothing in flight at boot) — cost: none known
- Ruling: expired share → 410 share_expired (brief) over generic 404 constraint — expiry isn't secret to holders of a valid token — cost: confirms the token once existed
- Ruling: Shared page shows only active/expired links (no revoked filter) — server returns non-revoked only; cost: users can't see history of revoked links
- Ruling: PublicShareInfo gains `id` (sync id) — fixes //content URLs breaking behind slash-merging proxies — T11 implements (small server/shared change)
- Ruling: PDF iframe without sandbox (Chrome refuses PDF viewer in sandboxed frames); only .pdf served as application/pdf + nosniff is framed — cost: a crafted PDF's JS runs in Chrome's PDF viewer (isolated plugin process)
- Ruling: name search = trigram % OR word-similarity <% (threshold 0.5, tx-local) OR LIKE on normalized name — needed for typo tolerance — cost: somewhat broader fuzzy hits
- Ruling: office text extraction maps only paragraph/break/cell tags to spaces — avoids splitting words across runs — cost: adjacent text without those tags may merge
- Ruling: public share page keeps its own simple viewers (no public preview-text route; styling differs) — follow-up — cost: text/md/code on public links only downloadable
- Ruling: share links of trashed items are listed on the Shared page flagged "Im Papierkorb" with revoke; restoring the item re-activates them (documented) — cost: owner must revoke explicitly if unwanted

## Offene Kleinigkeiten (deferred)
- Task 1: minor (deferred): @types/archiver ^8 vs archiver ^7; searchLanguage unvalidated (must be whitelisted/regconfig-cast where used — T6); verify prisma migrate diff doesn't try to drop raw indexes (future migrations) — check in T13/final; worker spec timing
- Task 2: minor (deferred): name_conflict orphan folder from ensureUserRoot; shared-NAT users hit IP bucket
- Task 3: minor (deferred): target dir deleted mid-copy → raw ENOENT 500 instead of 409; copy outside lock follows symlink swap briefly; web must treat 409 code 'conflict' on restore
- Task 4: minor (deferred): folder listing shows names of child subfolders swapped for symlinks (not browsable); public PDFs inline without CSP (same as 1a)
- Task 3: minor (deferred): raw updatedAt = now() timezone vs Prisma UTC; busy guard single-process
- Task 7: minor (deferred): 24h expiry from creation kills very slow huge uploads; lost final response → duplicate "(2)"; zero-byte/orphan parts never expired; no per-user staged-upload cap
- Task 7: follow-up for T10: failed non-SyncError publish leaves complete part; tus-js-client sees offset==length → client must send empty PATCH when no SyncItem returned (or server publishes on HEAD)
- Task 5: minor (deferred): shutdown grace vs long ffmpeg/hash; timeouts kill direct child only; SVG kind 'image' → web must use thumbnail only; heif multi-image outputs; no per-tool memory cap
- Task 4: minor (deferred): budget bytes never refunded; uploads map never evicted; zip slot leak if disconnect during zipEntries; hex-mapped IPv6; per-share unlock lockout tradeoff
- Task 5: minor (deferred): GC snapshot vs mid-run trash (self-healing); DerivedStore registered twice (derivatives.module + shares.module) — dedupe later
- Task 11: follow-up d6d5465 (PublicShareInfo.id, download probe)
- Task 11: minor (deferred): PDF iframe without sandbox (by design, Chrome viewer); probe adds a request per download; thumbnails not verified e2e (→ T13)
- Task 8: minor (deferred): async rejection with detached trigger falls back to body; execCommand test mock not restored
- Task 11: minor (deferred): stopPropagation before modifier check; any 416 accepted
- Task 9: minor (deferred): thumbnail URLs contain per-load token → no browser cache across reloads (batch/cookie-based thumbnails later); QuickLook stale source on change; media >1h near token expiry; 6h token survives logout (document); Space opens QuickLook for non-previewable; prev/next buttons not tabbable
- Ruling: public share page keeps its own simple viewers (no public preview-text route; styling differs) — follow-up — cost: text/md/code on public links only downloadable
- Task 12: minor (deferred): Caddyfile untouched (verified working in container per report); graceful stop during ffmpeg untested; HEIC/video/PDF only tool-presence in container (→ T13)
- Task 6: review APPROVED (no Critical/Important); follow-up dispatched for minors 1-3 (unzip -P, GC race w/ job row, snippet cap) + merge phase-1b
- Task 6: minor (deferred): search tx holds pool connection for SET LOCAL; U+FFFD heuristic; «» in content highlighted
- Task 6: follow-up (3 addressed); complete — merged into phase-1b
- Task 10: minor (deferred): StrictMode double reveal (dev); empty PATCH publish path only tested with fakes (→ T13)
- Task 13: minor (deferred): vacuous -z checks at throwaway :610/:620; skip-warning grep depends on text; e2e not re-runnable on initialised stack; upload.spec timing-dependent
- Final: minor (deferred): trashedItems expands all manifests; README "re-activates" not true if tombstone purged (new id); private_ranges + docker userland proxy spoof risk (doc); ensureDatabase broad skip

## Finales Review – Triage
## Deferred items – triage

| Origin | Item | Triage | Note |
|---|---|---|---|
| T1 | @types/archiver ^8 vs archiver ^7 | FINE | Hand-typed factory in `zip.ts`. |
| T1 | searchLanguage unvalidated | FINE | Resolved: `SearchLanguage` validates it against `pg_ts_config` and it is bound as `::regconfig`. |
| T1 | verify `migrate diff` doesn't drop raw objects | **MUST-FIX-BEFORE-MERGE** | Verified: it drops the `ItemText.tsv` column and its index → I1. |
| T1 | worker spec timing | FINE | |
| Ruling | login limiter per-IP + per-(IP+login) | **SHOULD-FIX-SOON** | Key by `ipKey` (IPv6 /64) → I3 (one-line fix; do it with I2). |
| Ruling | TRUST_PROXY default false, compose true | **MUST-FIX-BEFORE-MERGE** | The cost note is wrong: Caddy strips `X-Forwarded-For`, so everyone behind an outer proxy shares one bucket → I2. |
| Ruling | boot temp sweep without age gate | FINE | |
| T2 | name_conflict orphan folder from `ensureUserRoot` | SHOULD-FIX-SOON | An empty stray folder in the data root (e.g. `Bob` when `bob` exists). Check for a name conflict before `mkdir`. |
| T2 | shared-NAT users hit IP bucket | FINE | Inherent. |
| T3 | target deleted mid-copy → raw 500 | FINE | |
| T3 | copy outside lock follows symlink swap | FINE | Needs host access; only Synclet's own temp dir is affected. |
| T3 | web treats 409 conflict on restore | FINE | Implemented (`TrashPage.tsx:24`, tested). |
| T3 | raw `updatedAt = now()` timezone | SHOULD-FIX-SOON | Minor 6; one-token fix. |
| T3 | busy guard single-process | FINE | Single server process by design. |
| T4 | listing shows names of symlink-swapped subfolders | FINE | |
| T4 | public PDFs inline without CSP | FINE | Ruling; `nosniff` plus `.pdf` only. |
| T4 | upload budget never refunded / map never evicted | FINE | |
| T4 | ZIP slot leak if disconnect during `zipEntries` | SHOULD-FIX-SOON | Fastify likely destroys the stream on a closed response (which fires `close` → release). Add a test, or check `reply.raw.destroyed` after the await; see also Minor 2. |
| T4 | hex-mapped IPv6 | FINE | |
| T4 | per-share unlock lockout tradeoff | FINE | Documented tradeoff. |
| T5 | shutdown grace vs long ffmpeg/hash | FINE | |
| T5 | timeouts kill the direct child only | FINE | The tools don't fork. |
| T5 | SVG kind `image` → web uses the thumbnail only | FINE | Verified in `ImageViewer` and public `PreviewViewer`. |
| T5 | heif multi-image outputs | SHOULD-FIX-SOON | heif-convert may write `heif-1.jpg` … for burst/multi-image files, so `assertOutput` fails and they get no thumbnail. |
| T5 | no per-tool memory cap | SHOULD-FIX-SOON | Add a `mem_limit` for the worker in compose. Cheap insurance against an OOM-killed host. |
| T5 | GC snapshot vs mid-run trash | FINE | Self-healing. |
| T5 | DerivedStore registered twice | FINE | Minor 1. |
| Ruling | Shared page shows no revoked links | FINE | But see I5: it also hides links of trashed items. |
| T7 | 24 h expiry from creation | FINE | Document it. |
| T7 | lost final response → duplicate "(2)" | FINE | |
| T7 | zero-byte / orphan parts never expired | SHOULD-FIX-SOON | Completed-but-unpublished parts (non-SyncError publish failure) stay in `/meta/uploads` forever, which contradicts the README's "removed after 24 hours". |
| T7 | no per-user staged-upload cap | FINE | Authenticated users only. |
| T7 | empty-PATCH publish follow-up | FINE | Implemented in T10. |
| T8 | async rejection fallback / execCommand mock | FINE | |
| T9 | per-load preview token, no cross-reload cache | SHOULD-FIX-SOON | One POST per visible thumbnail; batch tokens or cookie auth later. |
| T9 | QuickLook stale source / media > 1 h / Space on non-previewable / prev-next not tabbable | FINE | |
| T9 | 6 h preview token survives logout (document) | **MUST-FIX-BEFORE-MERGE** (docs only) | Not documented yet → I6. |
| T11 | PDF iframe without sandbox | FINE | Ruling. |
| T11 | download probe, any 416, stopPropagation | FINE | |
| Ruling | name search fuzzy / office tag mapping / public page own viewers | FINE | |
| T12 | Caddyfile untouched / graceful stop untested / tool presence only | FINE | The Caddyfile needs `trusted_proxies` (I2). |
| T6 | search tx holds a pool connection; U+FFFD heuristic; «» in content | FINE | |
| T10 | StrictMode double reveal; empty PATCH tested only with fakes | FINE | |
| T13 | vacuous `-z` checks, skip grep, not re-runnable, timing | FINE | |

## Verdict

**Ready after fixes.** The architecture, scoping and file-safety core is solid, and I found no critical issue.

Before the PR merges, fix:
- **I1**: schema drift. Cheap, and it prevents a silent search outage in the next phase.
- **I2 + I3**: rate-limit keying. Small config and code changes that make the new hardening actually work behind proxies and over IPv6.
- **I6 / the preview-token doc item**: README only.

I4 and I5 are small and should land in the same pass if possible. Otherwise, track them as the first follow-ups.
