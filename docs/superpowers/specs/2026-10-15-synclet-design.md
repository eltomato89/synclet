# Synclet – Architektur & Roadmap (Design-Spec v1)

## Kontext
Synclet ist ein schlanker, self-hosted, Open-Source-Dropbox/OneDrive-Klon (Docker Compose). Kernversprechen: **Der gemountete Host-Ordner ist die Wahrheit** – was Web/Apps zeigen, liegt 1:1 so auf der Platte. Keine Metadateien, xattrs oder versteckten Ordner im Datenordner; Thumbnails, Papierkorb, Versionen, Suchindex liegen in einem separaten `/meta`-Volume bzw. Postgres. Man kann Synclet auf einen bestehenden Ordner richten und den Container jederzeit wegwerfen – übrig bleibt ein normaler Ordner.

Clients: Web (inkl. Euro-Office-Editing), macOS/Windows-Sync (später Linux), iOS (Dateien-App + In-App-Browser), Android. Der Sync-Stack aus **Buro** (`/Volumes/Daten/Privat/SaaS/BuroApp/buro`) ist erprobt und wird als Vorlage genutzt (Vertrag kompatibel halten → Clients portierbar).

**Entscheidungen des Users:** NestJS + Postgres · mehrere Nutzer, je `/data/<username>/` · Desktop wie Buro: On-Demand-Platzhalter + Pinning von Top-Level-Ordnern · Reihenfolge Server+Web → macOS/Win → iOS → Android · v1: Papierkorb, Freigabe-Links, Volltextsuche; Versionen optional & **standardmäßig aus** · Web-UI: React + Tailwind + shadcn/ui.

## 1. Monorepo (`/Volumes/Daten/Privat/Synclet`)
```
apps/server        NestJS+Fastify+Prisma; Entrypoints main.api.ts (API+Indexer) & main.worker.ts (Jobs)
apps/web           React/Vite/Tailwind/shadcn, Uppy(tus) für Uploads
apps/apple/SyncletKit   Swift-Package (Port von BuroFileProviderKit)
apps/macos, apps/ios    Host-Apps + File-Provider-Extensions
apps/windows       Synclet.Sync.Core/.Windows/.App (Port von Buro.Sync.*)
apps/android       Kotlin/Compose + DocumentsProvider
packages/shared    TS-DTOs + zod
packages/sync-contract  OpenAPI + Konformitätstests gegen den Server
deploy/            compose.yml, Caddyfile, .env.example
docs/sync/SYNC_API.md, docs/adr/
```

## 2. Dateisystem als Source of Truth (Kernstück)
- **`Item`-Tabelle:** id(uuid), ownerId, parentId, name (exakt wie auf Platte), nameKey (NFC+casefold), path, type, size, mtime, ino, dev, contentHash? (sha256, lazy), version (+1 bei jeder Inhaltsänderung, auch extern), officeKey?, deletedAt (Tombstone), lastSeenScan.
- **Stabile IDs bei externen Änderungen:** (1) gleicher Pfad ⇒ gleiche ID (auch bei neuem Inode, z. B. Editor-Save via Temp-Rename); (2) unbekannter Pfad ⇒ Abgleich (dev, ino [+size/mtime]) mit Tombstones ⇒ Move/Rename, ID bleibt; (3) sonst delete+create. Tombstones überleben 2 Scan-Zyklen. Symlinks werden nie gefolgt; jeder Pfad wird per realpath gegen das User-Root geprüft.
- **Watcher:** `@parcel/watcher`, 2 s Debounce pro Ordner → „rescan dir“-Jobs. Best-effort (Docker Desktop/virtiofs, SMB/NFS liefern unzuverlässig Events; inotify-Limit ist Host-Setting → Fallback Scan-only, im Admin-UI sichtbar).
- **Reconcile-Scan:** pro User alle 15 min (2 min wenn `SYNCLET_WATCH=off`), opendir+lstat, Merge gegen DB, Hash nur bei Änderung von size/mtime/ino.
- **Kein Echo:** Jede Mutation (API oder Indexer) unter `pg_advisory_xact_lock(user, dir)`; API aktualisiert Item + Journal in derselben Transaktion wie die Platten-Operation.
- **Atomares Schreiben:** Upload-Chunks in `/meta/uploads`; Commit = Kopie in `.<name>.synclet-<id>` im Zielordner (Watcher-Ignore, Startup-Cleanup) + fsync + `rename` über Ziel. (O_TMPFILE/linkat-Optimierung später.) **Optionaler Same-FS-Modus:** Host-Elternordner nach `/vol` mounten, `files/` = Datenroot, `.synclet/` = tmp/trash/versions ⇒ Papierkorb/Versionen per rename/hardlink statt Kopie.
- **Journal:** `FileChange(seq, scopeId, itemId, op, at)` von der App geschrieben (nicht per Trigger). seq per `UPDATE SyncScope SET seq=seq+1 RETURNING` in der Transaktion ⇒ Commit-Reihenfolge garantiert (Verbesserung ggü. Buro-BIGSERIAL). Cursor opak, `FileChangeWatermark` + `410 cursor_expired` wie Buro.

## 3. Dateinamen
Auf Platte nie umbenannt. Neue Namen via API in NFC; Windows-verbotene Zeichen/Namen, >255 Byte abgelehnt. Kollisionen (Case/NFC-NFD) ⇒ Display-Suffix „(2)“. Unter Windows ungültige Bestandsnamen ⇒ reversibles Mapping im Windows-Client. Ignoriert: `.DS_Store`, `._*`, `Thumbs.db`, `desktop.ini`, `~$*`, `.~lock.*#`, `@eaDir`, `#recycle`, `lost+found`, `.synclet-*` u. a.

## 4. Sync-API = Buro SYNC_API v1 + Deltas
Vorlage: `buro/docs/sync/SYNC_API.md`, `buro/apps/api/src/sync/` (Controller, `sync-changes.service.ts`), Prisma-Modelle FileChange/FileChangeWatermark/SyncDevice.
Deltas: kein Tenant/Subdomain (organizationId = `<serverId>:<userId>`, areas nur personal, kind nur root|folder|file); version zählt auch externe Edits; `X-Synclet-Modified-At` (+ `X-Buro-*` Aliase); **tus 1.0 resumable Upload** (`@tus/server`); `GET /items/:id/thumbnail`; `GET /events` (SSE); Token-Präfix `syd_`; Redirect `synclet://oauth`. Pinning ist rein clientseitig.

## 5. Derivate-Pipeline
**pg-boss** (Postgres, kein Redis) im `worker`-Container. Jobs: hash, thumb, preview, extract. sharp/libvips(+libheif), ffmpeg, pdftoppm/pdftotext, OOXML/ODF-Text via unzip+SAX. Ablage content-addressed `/meta/derived/<sha[0:2]>/<sha>/<kind>-<size>.webp` (Renames kostenlos), GC für unreferenzierte Hashes.

## 6. Papierkorb · Versionen · Freigaben · Suche
- **TrashEntry** (originalPath, Subtree-Manifest, storePath in `/meta/trash/<id>`); Restore mit Original-IDs. Externe Löschungen auf der Platte landen nicht im Papierkorb (dokumentiert). Auto-Leeren nach N Tagen.
- **FileVersion** (aus per Default; `SYNCLET_VERSIONS=on`) – vor Server-Overwrites kopiert/gehardlinkt nach `/meta/versions`; externe Edits nicht versionierbar.
- **ShareLink** (tokenHash, itemId, Passwort argon2id?, expiresAt?, allowDownload, revokedAt) – an ID gebunden, überlebt Renames; Routen `/s/:token`, `/api/public/shares/:token`.
- **Suche:** `ItemText(tsvector)` GIN + unaccent, `pg_trgm` auf Namen; `websearch_to_tsquery`.

## 7. Euro-Office (nur Web)
Übernahme aus `buro/apps/api/src/files/office.service.ts` + `office.controller.ts` + `apps/web/src/pages/OfficeEditorPage.tsx`: JWT-signierte Editor-Config, Kurzzeit-Token `?t=`, Callback (Status 2/6). `document.key = <itemId>-<version>`; bei veraltetem Stand Konfliktkopie „(Konflikt Office …)“. Container `ghcr.io/euro-office/documentserver` als Compose-Profil `office` (Subdomain `office.`). „Neu → Word/Excel/PowerPoint“ legt leere Vorlagen an.

## 8. Auth
`User(username = Ordnername, email, role)`, `Identity(provider 'local'|'oidc:<issuer>', subject, passwordHash?)`. Web: kurzer Access-JWT + rotierendes httpOnly-Refresh-Cookie. Geräte-Tokens wie Buro (SHA-256-Hash, widerrufbar). Native Apps loggen sich immer über die PKCE-Browserseite ein ⇒ OIDC später nur serverseitig, keine Client-Änderung. Erster Start: Setup-Wizard legt Admin an; Admin kann bestehende Unterordner von `/data` Usern zuordnen.

## 9. Docker Compose
Services: `caddy`, `server` (1 Replica, hält Watcher), `worker` (gleiches Image), `web` (statisch), `postgres:16`, `office` (Profil). Volumes: `${SYNCLET_DATA}:/data` (oder Same-FS `/vol`), `meta`, `pgdata`. Läuft als `PUID/PGID`, umask 002 ⇒ Host-Eigentümer bleiben korrekt. Caddyfile nach Buro-Vorbild ohne Tenant-Routing; TLS durch Caddy oder Upstream-Proxy.

## 10. Web-Design (Mobbin-Referenzen)
Dropbox Web (Quick-Actions-Leiste + „Suggested“-Kacheln), Proton Drive (Sidebar + Grid mit Thumbnails), Supabase Storage (rechtes Detail-Panel mit Vorschau/Metadaten), Skiff Drive (minimalistische Liste). Ergebnis: linke Sidebar (Meine Dateien, Zuletzt, Freigaben, Papierkorb, Speicher-Anzeige), Toolbar mit Breadcrumb + ⌘K-Suche, Grid/Listen-Toggle, Drag&Drop-Upload mit Upload-Toast, Detail-Panel, QuickLook-Modal (Space-Taste), Hell/Dunkel. Konkretes visuelles Design entsteht in Phase 1 mit frontend-design.

## 11. Roadmap
1. **Phase 1 – Server + Web** · 1a: Auth, Indexer+Reconcile, Items, Journal, Sync-API, Browsen/Upload/Download · 1b: Papierkorb, Freigaben, Thumbnails/QuickLook, Suche · 1c: Euro-Office, Versionen (opt.), Admin-UI, Konformitätssuite.
2. **Phase 2** – macOS (SyncletKit/File Provider) + Windows (Cloud Files) portiert, Pinning, SSE.
3. **Phase 3** – iOS: File Provider (Dateien-App) + In-App-Browser, APNs.
4. **Phase 4** – Android: DocumentsProvider + Browser.
5. **Phase 5** – Linux-Client, OIDC, geteilte Ordner zwischen Usern.

**Hauptrisiken:** unzuverlässige FS-Events (Scan als Netz), instabile Inodes auf Netzwerk-FS (IDs degradieren zu delete+create), Editor-Save-Sequenzen mitten im Scan, EXDEV-Kopierkosten ohne Same-FS-Modus, Host-Edit vs. API-Write (Last-Writer-Wins-Fenster), Scan/Hash-Kosten bei Multi-TB, Euro-Office AGPL (separater Container).

## Nächste Schritte nach Freigabe
1. `git init` in `/Volumes/Daten/Privat/Synclet`, diese Spec als `docs/superpowers/specs/2026-10-15-synclet-design.md` committen, ADRs für Stack/FS-Truth anlegen.
2. User-Review der Spec-Datei.
3. writing-plans-Skill → detaillierter Implementierungsplan **nur für Phase 1a** (jede Phase eigener Plan-Zyklus).

## Verifikation (Phase 1)
- Konformitätstests (`packages/sync-contract`) gegen laufenden Server: Cursor/Changes, 412/428, 410, Range, tus-Resume.
- Indexer-Tests mit Temp-Ordnern: externes Rename/Move ⇒ ID stabil; Editor-Save (Temp+Rename) ⇒ gleiche ID, version+1; NFD-Namen; Ignore-Liste.
- „Wegwerf-Test“: `docker compose up` auf bestehendem Ordner → Dateien via Web anlegen/verschieben/löschen → `docker compose down -v` → Ordner per `diff -r`/Finder prüfen: exakt die erwartete Struktur, keine Fremddateien.
- Web E2E (Playwright) inkl. Upload, QuickLook, Share-Link, Suche; Euro-Office-Profil manuell: docx anlegen, editieren, speichern ⇒ Datei auf Platte aktualisiert.
