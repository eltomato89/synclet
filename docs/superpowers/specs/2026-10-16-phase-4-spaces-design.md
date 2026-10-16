# Synclet Phase 4 – Bereiche: Team-Ordner und externe Speicher (Design)

Stand: 2026-10-16 · Basis: Hauptspec `2026-10-15-synclet-design.md`, Phase-2-Spec (§1.1 Bereiche), Phase-3-Spec, Branch `folder-upload` (PR #5).

## Ziel
Neben dem persönlichen Ordner jedes Nutzers gibt es **Bereiche**, die mehreren Nutzern gehören:
- **Team-Ordner** unter `/teams/<name>` (neues Volume `SYNCLET_TEAMS`), im Admin-Bereich anlegbar.
- **Externe Speicher**: jeder Unterordner von `/storage/<name>` wird automatisch als Bereich erkannt
  (z. B. eine NAS-Freigabe, die per Docker-Volume `type: cifs`/`nfs` eingehängt ist).

Zugriff bekommen **Gruppen** und **einzelne Nutzer**, jeweils mit **Lesen** oder **Lesen und Schreiben**.
Die Rechteverwaltung bleibt bewusst schlicht (Heimgebrauch). Web, Mac (Finder), iOS-App und Dateien-App zeigen
alle Bereiche, auf die man Zugriff hat. Synclet bleibt dabei „der Ordner auf der Platte ist die Wahrheit“:
kein Metadatenmüll in Bereichsordnern, Bereiche werden nie von Synclet gelöscht.

**Entscheidungen des Users (2026-10-16):**
- Team-Ordner + externe Speicher (kein Teilen einzelner Unterordner zwischen Nutzern in dieser Phase).
- Kein SMB-Client in Synclet; SMB/NFS kommt über Docker-Volumes.
- Team-Ordner in eigenem Volume `SYNCLET_TEAMS` → `/teams`.
- Externe Speicher: alles unter `/storage/<name>` wird automatisch erkannt.
- Neu erkannte Bereiche: **niemand hat Zugriff, bis der Admin zuweist**.
- Gruppen + einzelne Nutzer; Rechte Lesen oder Lesen+Schreiben.
- Der User hat Spec und Plan ohne Zwischenfreigabe delegiert („sag Bescheid, wenn alles fertig ist“);
  Entscheidungen des Controllers stehen im Ledger und im PR.

**Nicht Teil von Phase 4:**
- Nutzer teilt eigenen Unterordner mit anderen Nutzern („Mit mir geteilt“) – spätere Phase.
- Quoten pro Bereich.
- Windows-/Android-Clients (folgen; sie bekommen dieselbe API).
- Rechte unterhalb der Bereichsebene (pro Unterordner).

## 1. Datenmodell (Server)

### 1.1 Bereich als Mandantenschlüssel
Neue Tabelle `Space`:
```
Space { id uuid PK, kind personal|team|external, name text, rootPath text (absolut im Container),
        userId uuid? (nur personal, FK User, unique), readOnly bool (erkannt), status available|missing,
        watch auto|off (nur team/external), scanIntervalSec int?, createdAt, updatedAt }
```
- **Persönlicher Bereich: `Space.id = User.id`.** Dadurch bleiben alle bestehenden Schlüssel gültig:
  `Item.ownerId`, `FileChange.scopeId`, `SyncScope.userId`, `TrashEntry.ownerId`, `FileVersion.ownerId`,
  `/meta/versions/<ownerId>/…` enthalten heute die User-ID = künftige Space-ID. Die Migration legt pro
  bestehendem User einen `Space(kind personal, id = user.id, rootPath = <dataRoot>/<username>)` an.
- Umbenennungen im Schema (Spalten, nicht Werte): `Item.ownerId → spaceId` (FK Space),
  `SyncScope.userId → spaceId` (FK Space), `TrashEntry.ownerId → spaceId` (+ neue Spalte `deletedBy uuid?`),
  `FileVersion.ownerId → spaceId`. Indizes/Unique-Constraints entsprechend (`Item_space_path_live_key` usw.).
- `ShareLink` behält `ownerId` (= anlegender Nutzer) und bekommt `spaceId`.
- Neue Tabellen: `Group { id, name unique (nameKey) }`, `GroupMember { groupId, userId }`,
  `SpaceMember { spaceId, userId? , groupId?, role read|write }` (genau eines von userId/groupId).

### 1.2 Zugriff
`SpaceAccess.roleFor(user, space)`:
- personal: Eigentümer → `write`; sonst kein Zugriff (auch nicht für Admins).
- team/external: höchste Rolle aus direkter Mitgliedschaft und Gruppenmitgliedschaften; keine → kein Zugriff.
- `readOnly` (Mount nur lesbar) begrenzt auf `read`; `status missing` sperrt Lesen und Schreiben (§6).
- Deaktivierte Nutzer haben keinen Zugriff.
- Admins haben **keinen** impliziten Zugriff auf fremde Bereiche; sie können sich selbst zuweisen.

Jede Server-Operation, die heute `ownerId: user.id` filtert, prüft stattdessen: Item gehört zu einem Bereich,
auf den der Nutzer mindestens `read` (Lesen) bzw. `write` (Ändern) hat. Kein Zugriff → `404 not_found`
(Existenz nicht verraten); nur Lesen bei Schreibversuch → `403 forbidden`.

## 2. Speicherorte, Erkennung, Indexer

### 2.1 Volumes und Konfiguration
- `SYNCLET_TEAMS_ROOT` (Default `/teams`), `SYNCLET_STORAGE_ROOT` (Default `/storage`). Beide optional:
  fehlt das Verzeichnis, gibt es keine Bereiche dieser Art.
- Compose: zusätzliche Volumes `${SYNCLET_TEAMS:-./teams}:/teams` (server rw, worker ro) und ein Beispiel
  (auskommentiert) für `/storage/<name>` als Bind-Mount und als CIFS-Volume. `deploy/README`/Doku erklärt beides.

### 2.2 Erkennung (Discovery)
- Beim Start und vor jedem Scan-Zyklus: jeder direkte Unterordner von `/teams` und `/storage` (kein Symlink,
  kein Punktname, nicht auf der Ignore-Liste) ist ein Bereich. Name = Ordnername.
- Neu → `Space` anlegen (ohne Mitglieder). Verschwunden oder leer, obwohl Items bekannt sind (Mount fehlt)
  → `status missing`; Items bleiben, kein Scan, keine Löschungen. Wieder da → `available`.
- `readOnly`: Schreibtest per `access(W_OK)` auf den Wurzelordner.
- Team-Ordner anlegen im Admin-Bereich = `mkdir /teams/<name>` + Space. Umbenennen = `rename` auf der
  Platte + Space-Name/RootPath. „Entfernen“ entfernt nur Space, Mitglieder und Index – der Ordner bleibt.
  Externe Speicher können nicht angelegt/umbenannt werden (nur erkannt).

### 2.3 Indexer und Watcher
- Scheduler und Indexer arbeiten pro **Bereich** statt pro Nutzer (`IndexUser` → `IndexSpace {id, rootPath}`).
- Watcher: je eine Subscription auf `/data` (erstes Segment = Benutzername → persönlicher Bereich), auf
  `/teams` (erstes Segment → Team-Bereich) und auf jeden externen Speicher einzeln. Routing über eine
  Wurzel→Bereich-Tabelle; unbekannte Pfade werden ignoriert.
- Externe Speicher: `watch auto` versucht den Watcher, fällt bei Fehlern auf Scan-only zurück;
  `watch off` immer Scan-only. Scan-Intervall pro Bereich einstellbar (Default: wie global).
- Schutz vor Massenlöschung (`refuseEmptyRoot`, `dataRootLooksMounted`) gilt pro Bereichswurzel.
- Sperren: `lockUser` → `lockSpace(spaceId)`; Journal (`SyncScope`, `FileChange`, `pg_notify`) pro Bereich.
- Papierkorb-Staging (`.synclet-trash-*`) und Startup-Aufräumen erfolgen in der jeweiligen Bereichswurzel.
- Neue Dateien in Bereichen gehören auf der Platte `PUID:PGID` (wie bisher); `umask 002`.

## 3. API (Sync API v1, abwärtskompatibel)

### 3.1 Account und Bereiche
`GET /sync/v1/account` → `spaces` enthält alle Bereiche mit Zugriff:
- persönlich: `{ id: "personal", kind: "personal", name: "Meine Dateien", rootId: "root", canWrite: true }` (wie bisher)
- Team: `{ id: "<uuid>", kind: "shared", name, rootId: "r_<uuid>", canWrite }`
- Extern: `{ id: "<uuid>", kind: "external", name, rootId: "r_<uuid>", canWrite }`
Reihenfolge: persönlich, dann Team-Bereiche, dann externe, jeweils nach Name. `usedBytes` bleibt der persönliche Bereich.

### 3.2 Items
- `SyncItem` bekommt `spaceId` (API-ID des Bereichs, additiv). `parentId` eines Items direkt in der
  Bereichswurzel ist deren `rootId` (`root` bzw. `r_<uuid>`).
- `GET /items/r_<uuid>` liefert die virtuelle Wurzel (kind `root`, name = Bereichsname, nicht umbenenn-/
  verschieb-/löschbar; `addChildren` nur mit Schreibrecht).
- Capabilities jedes Items folgen der Rolle (`read` → write/rename/move/delete/addChildren `false`).
- **Verschieben zwischen Bereichen** (`PATCH parentId` in anderem Bereich, beide mit Schreibrecht):
  Server verschiebt auf der Platte (rename, bei EXDEV kopieren + löschen), Item-ID bleibt, Journal:
  `delete` im alten, `upsert` (Teilbaum) im neuen Bereich. Sperren beider Bereiche in fester Reihenfolge.
- Kopieren gibt es weiterhin nicht über die API.

### 3.3 Änderungen pro Bereich
- `GET /sync/v1/cursor?space=<id>` und `GET /sync/v1/changes?space=<id>&cursor=…`; ohne `space` = `personal`
  (alte Clients unverändert). Kein Zugriff auf `space` → `404`.
- `children` liefert den Cursor des Bereichs, zu dem der Ordner gehört.
- SSE `/events`: `hello` bekommt zusätzlich `cursors: { <spaceId>: <cursor> }`; `changes {space, cursor}`
  trägt die echte Bereichs-ID. Neues Ereignis `account` (ohne Daten), wenn sich die Bereichsliste oder
  Rechte eines Nutzers ändern (Mitgliedschaft, Bereich neu/entfernt/missing) → Client lädt `/account` neu.

### 3.4 Übrige Funktionen
- **Suche/Zuletzt:** über alle lesbaren Bereiche; Treffer tragen `spaceId`; `path` bleibt relativ zur
  Bereichswurzel. Optionaler Filter `space=<id>`.
- **Papierkorb:** `GET /api/trash` listet Einträge aller Bereiche mit Schreibrecht (Feld `spaceId`,
  `deletedBy`); Wiederherstellen/Endgültig löschen braucht Schreibrecht; „Papierkorb leeren“ leert nur
  den persönlichen Bereich, optional `?space=<id>`.
- **Versionen:** in allen Bereichen (Ablage `/meta/versions/<spaceId>/…`), Lesen braucht `read`,
  Wiederherstellen `write`.
- **Freigabe-Links:** anlegen braucht `write` im Bereich; öffentlich gültig, solange der anlegende Nutzer
  aktiv ist und noch `write` hat; sonst `404` wie ein widerrufener Link. Admin-Liste zeigt den Bereich.
- **Office:** Dokumente in Bereichen editierbar mit `write`; Callback schreibt in den Bereich des Items.
- **Download-Token, Thumbnails, Text-Vorschau, tus:** Zugriff über Bereichsrolle statt Eigentümer.

### 3.5 Admin-API
- `GET/POST/PATCH/DELETE /api/admin/groups` (+ Mitglieder).
- `GET /api/admin/spaces` (team + external, mit Pfad, Status, readOnly, Mitgliedern, Größe),
  `POST /api/admin/spaces` (Team-Ordner anlegen), `PATCH /api/admin/spaces/:id` (Name nur team, watch,
  scanIntervalSec, Mitglieder), `DELETE /api/admin/spaces/:id` (nur team: entfernt aus Synclet, Ordner bleibt),
  `POST /api/admin/spaces/:id/scan` (sofort scannen).
- Admin-Liste der Nutzer zeigt Gruppen.

## 4. Web
- **Seitenleiste:** „Meine Dateien“, darunter Abschnitt „Bereiche“ mit allen Team- und externen Bereichen
  (Icons: Team = Personen, extern = Festplatte; Schloss für nur Lesen; Hinweis bei `missing`).
- Routen: `/files/:folderId` funktioniert für jeden Ordner; Bereichswurzel = `/files/r_<uuid>`.
  Breadcrumb beginnt mit dem Bereichsnamen.
- Nur-Lesen-Bereiche: Upload, Neu, Umbenennen, Verschieben, Löschen ausgeblendet; Hinweisleiste „Nur lesen“.
- Verschieben-Dialog kann Bereiche als Ziel wählen (nur mit Schreibrecht).
- Suche, Zuletzt, Papierkorb zeigen den Bereich je Treffer.
- **Admin:** neue Seiten „Gruppen“ und „Bereiche“ (Liste mit Pfad/Status/Nur-Lesen/Mitglieder; Team-Ordner
  anlegen/umbenennen/entfernen; Mitglieder-Editor mit Gruppen und Nutzern und Rolle; „Jetzt scannen“;
  Watch-Modus und Scan-Intervall bei externen Speichern). Nutzer-Detail zeigt Gruppen.
- de + en.

## 5. Apple-Clients (SyncletKit, macOS, iOS)
- `SyncAPIClient.cursor(space:)` und `changes(space:since:limit:)` (Default `personal`).
- `SpaceLayout.feedSpaces` = alle Bereiche; der Enumerator holt Cursor und Änderungen pro Bereich
  (der Sync-Anker ist schon eine Map Bereich→Cursor).
- Bereichsliste ändert sich (SSE `account`, Account-Refresh): Layout aktualisieren, Wurzel neu
  signalisieren; verlorene Bereiche verschwinden aus Finder/Dateien-App.
- Nur-Lesen-Bereiche: Capabilities aus dem Server; Fehler beim Schreiben wie bisher (`.cannotSynchronize`).
- Verschieben zwischen Bereichen im Finder: über `PATCH parentId` (Server unterstützt es, §3.2).
- macOS Pinning: pro Bereich wie bisher (Bereich ganz oder Ordner erster Ebene).
- iOS-App: Seitenleiste/„Dateien“-Tab zeigen Bereiche; Upload-Ziel, Suche, Papierkorb bereichsfähig.

## 6. Fehler und Grenzfälle
- **Mount fehlt** (externer Speicher/Teams nicht eingehängt): Bereich `status missing`. Er bleibt in
  `spaces` (mit `canWrite: false`), Lesen und Schreiben von Inhalten liefern `503 space_unavailable`
  (neuer Fehlercode); der Index bleibt erhalten. Clients zeigen „Nicht verfügbar“.
- **Netzlaufwerke:** Moves auf dem NAS selbst erscheinen als Löschen + Neu (Inode-Instabilität, dokumentiert).
- **Zugriff entzogen:** offene Streams bekommen `account`; laufende Uploads in den Bereich scheitern mit `404`.
- **Gruppe gelöscht:** Mitgliedschaften entfallen, `account` an betroffene Nutzer.
- **Nutzername = Ordnername** bleibt nur für persönliche Bereiche; Team-/Speichernamen sind unabhängig.

## 7. Tests
- Migration: bestehende Daten (Items, Journal, Papierkorb, Versionen, Links) funktionieren unverändert nach
  der Migration (Migrationstest mit Vorher-Daten).
- Server-Unit/E2E: Zugriff (Rollen, Gruppen, kein Zugriff → 404, nur Lesen → 403), Erkennung (neu, missing,
  readOnly), Indexer/Watcher pro Bereich, Journal pro Bereich, Verschieben zwischen Bereichen (gleiches und
  anderes Dateisystem), Papierkorb/Versionen/Suche/Links/Office in Team-Bereichen, SSE `account`.
- Konformitätssuite: `spaces`, `?space=` bei cursor/changes, `spaceId`, Rechte.
- Web: Unit + Playwright (Admin legt Gruppe + Team-Ordner an, weist zu; Nutzer sieht Bereich, lädt hoch;
  Nur-Lesen-Nutzer sieht keine Schreibaktionen).
- SyncletKit: Enumerator mit mehreren Bereichen, Cursor pro Bereich, Layout-Wechsel. macOS-/iOS-App-Tests.
- Live-Skripte (`macos-live-tests.sh`, `ios-live-tests.sh`) mit einem Team-Bereich.

## 8. Risiken
- Breiter Umbau (~60 Stellen mit `ownerId`): Migration mit `Space.id = User.id` hält den Datenumbau klein,
  der Code-Umbau bleibt groß → gründliche Tests vor allem für „kein Zugriff auf fremde Bereiche“.
- Watcher auf Netzlaufwerken unzuverlässig → Scan-only als Default-Rückfall.
- Gleichzeitige Änderungen mehrerer Nutzer in einem Team-Bereich: Konflikte wie bisher über ETags/Konfliktkopien.
