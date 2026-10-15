# Synclet Phase 2 – macOS-Sync-Client + Live-Benachrichtigung (Design)

Stand: 2026-10-15 · Basis: Hauptspec `2026-10-15-synclet-design.md` (§4 Sync-API, §11 Roadmap), Phase 1c (`phase-1c`).

## Ziel
Ein nativer macOS-Client bindet Synclet-Konten über die File-Provider-API in den Finder ein:
Dateien erscheinen als Platzhalter und werden beim Öffnen geladen. Ausgewählte Ordner lassen sich
dauerhaft offline halten. Änderungen auf dem Server kommen per Server-Sent Events (SSE) nahezu sofort an.
Der Client ist ein Port des erprobten Buro-Mac-Clients (`buro/apps/macos-app`, `buro/apps/apple-shared/BuroFileProviderKit`).

**Entscheidungen des Users (2026-10-15):**
- Live-Änderungen per SSE plus Polling als Fallback; kein APNs.
- Eigene Pinning-Auswahl in der App.
- Signiert mit Team `JC32M95WLZ`, Bundle-IDs `tech.jensk.synclet.*`.
- Windows erst als eigene Phase 2b.
- Mindestversion macOS 26.
- tus-Uploads ab einer Schwelle.
- Mehrere Konten gleichzeitig.
- Virtuelle oberste Ebene mit Bereichen: auf dem Mac stehen die Dateien unter „Meine Dateien“. Daneben ist Platz für spätere geteilte und externe Ordner.

**Nicht Teil von Phase 2:**
- Windows-Client (Phase 2b)
- iOS (Phase 3)
- APNs
- automatische Updates (Sparkle)
- geteilte und externe Ordner selbst (Phase 5); nur ihr Platz in der Struktur wird jetzt angelegt
- Android

## 1. Server

### 1.1 Bereiche („Spaces“) in der Kontoabfrage
`GET /sync/v1/account` bekommt das zusätzliche Feld `spaces`. Das ist rein additiv: `areas` bleibt für die Buro-Kompatibilität bestehen.

```ts
SyncSpace = {
  id: string,             // stabil; Phase 2: genau "personal"
  kind: "personal",       // später: "shared" | "external"
  name: string,           // Server-Vorschlag ("Meine Dateien"); Clients lokalisieren nach kind
  rootId: string,         // Item-ID des Bereichs-Wurzelordners; personal → "root"
  canWrite: boolean
}
SyncAccount.spaces: SyncSpace[]   // Reihenfolge = Anzeigereihenfolge
```

- Die Item-ID `root` bleibt der Benutzerordner `/data/<username>`. Alle bestehenden Endpunkte bleiben unverändert.
- Clients bauen die oberste Ebene **virtuell** aus `spaces`: ein Ordner je Bereich. Diese Ebene ist schreibgeschützt; Anlegen, Umbenennen, Verschieben und Löschen sind dort nicht erlaubt.
- Vorwärtskompatibilität: Clients müssen unbekannte `kind`-Werte als normalen Ordner anzeigen. Sie speichern ihren Sync-Zustand (Cursor, Pins) **pro Bereich**, damit spätere Bereiche mit eigenem Änderungs-Feed ohne Migration dazukommen.
- `SYNC_API.md` §3, die OpenAPI-Datei und die Konformitätssuite werden ergänzt.

### 1.2 SSE: `GET /api/sync/v1/events`
- **Authentifizierung:** Geräte-Token (`Authorization: Bearer syd_…`). Eine Web-Session ist ebenfalls zulässig, damit das Web-UI den Endpunkt später nutzen kann.
- **Format:** `text/event-stream`. Ereignisse:
  - `event: hello` beim Verbindungsaufbau, mit `data: {"cursor": "<aktueller Cursor>"}`
  - `event: changes` mit `data: {"space":"personal","cursor":"<neuer Cursor>"}`, sobald im Änderungsjournal des Benutzers neue Einträge committet sind
  - alle 25 s ein Kommentar `: ping`
- **Mechanik:** Nach dem Commit eines Journaleintrags sendet der Server `pg_notify('synclet_changes', userId)`. Das geschieht aus derselben Transaktion heraus, damit Postgres erst nach dem Commit zustellt. Ein `LISTEN` je Server-Prozess verteilt das an die offenen Streams des Benutzers.
  - Mehrere Änderungen innerhalb von 250 ms werden zu einem Ereignis gebündelt.
- **Semantik:** Das Ereignis ist nur ein Weckruf. Clients holen die Daten immer über `GET /changes?cursor=…`. Verlorene Ereignisse schaden daher nicht. Nach jedem Neuverbinden gleicht der Client einmal per `/changes` ab.
- **Grenzen:**
  - höchstens 10 gleichzeitige Streams pro Benutzer; der älteste wird geschlossen
  - widerrufene oder deaktivierte Geräte und Benutzer: Der Stream endet spätestens beim nächsten Ping, weil das Token dabei erneut geprüft wird
- **Caddy:** `flush_interval -1` für `/api/sync/v1/events`, keine Kompression für `text/event-stream`. NPM und andere äußere Proxys reichen SSE ohne Einstellungen durch, solange ihre Lesetimeouts über 25 s liegen. Das wird im README dokumentiert.
- Doku in `SYNC_API.md` (neuer Abschnitt „Events“) und in der OpenAPI-Datei. Der Konformitätstest prüft: `hello` kommt, eine Änderung über die API erzeugt innerhalb von 3 s `changes`, und `ping` kommt (Testintervall per Env verkürzbar).

### 1.3 App-Login
Der Client `macos` mit `synclet://oauth` existiert bereits (Phase 1c). Hier gibt es keine Server-Änderung.

### 1.4 Speicher voll
Schreibt der Server auf `/data` oder `/meta` und das Dateisystem meldet `ENOSPC` (beim Hochladen, Ersetzen, Abschließen eines tus-Uploads, Kopieren, Wiederherstellen oder einem Office-Save), antwortet er mit `507 insufficient_storage` statt `500`. Temporäre Dateien werden dabei aufgeräumt. Das wird in `SYNC_API.md` und in der OpenAPI-Datei dokumentiert und mit einem Unit-Test über einen injizierten `ENOSPC`-Fehler abgesichert.

## 2. macOS-Client

### 2.1 Struktur
```
apps/apple/SyncletKit/          Swift-Package (swift-tools 6.2, macOS 26 / iOS 26), Port von BuroFileProviderKit
  API/        SyncAPIClient, SyncAPIError, TusUploader, EventStream (SSE-Parser + Reconnect)
  Models/     SyncModels (inkl. SyncSpace)
  FileProvider/ SyncletReplicatedExtension, Enumerators, ItemMapping (virtuelle Ebene), ErrorMapping,
                ConflictNaming, Thumbnails
  Credentials/ CredentialStore, SecureStorage (Keychain, Access Group)
  Account/    AccountManager (Konten, Domains), InstallationID, PinStore
apps/macos/                     XcodeGen-Projekt (project.yml, generiertes .xcodeproj eingecheckt wie Buro)
  Synclet/                      Menüleisten-App (SwiftUI MenuBarExtra, LSUIElement)
  SyncletFileProvider/          File-Provider-Extension (dünne Unterklasse aus dem Kit)
  Shared/                       Code für App und Extension (z. B. AuthFailureSignal)
  SyncletTests/                 App-Tests
  build_and_notarize.sh, dmg/
```

**Kennungen:**
- Bundle-IDs `tech.jensk.synclet.mac` und `tech.jensk.synclet.mac.fileprovider`
- App-Group `$(TeamIdentifierPrefix)group.tech.jensk.synclet`
- Keychain-Gruppe `$(AppIdentifierPrefix)tech.jensk.synclet.shared`
- URL-Scheme `synclet`
- Team `JC32M95WLZ`, Developer-ID-Distribution, Hardened Runtime
- Die Extension ist sandboxed (`network.client`). Die App ist nicht sandboxed, wie bei Buro.

**Aus Buro entfernt:**
- Mandanten- und Subdomain-Logik: ServerTarget, OrganizationRegistry, `/auth/organizations`, `/auth/switch`
- Feld „Arbeitsbereich“ bzw. „Firmenkürzel“, Basis-Domain
- Regeln für die Bereiche `customers` und `projects`, Link-Items (`l_…`)
- Feature-Flag `files.storage`
- APNs bzw. PushKit
- Buro-Branding

### 2.2 Konten und Anmeldung
1. Server-URL eingeben (Schema optional, Standard `https://`). Die App prüft `GET /api/health` und `GET /sync/v1/capabilities` bzw. eine Synclet-Kennung. Bei Fehlern erscheint eine klare Meldung.
2. Browser-Login mit `ASWebAuthenticationSession` auf `<server>/app-login` (PKCE S256, `client_id=macos`, `synclet://oauth`). Danach `POST /api/auth/app/token` und `POST /sync/v1/devices` mit Gerätename = Computername. Das liefert das Geräte-Token `syd_…`.
3. **Kontoschlüssel:** `organizationId` (`<serverId>:<userId>`). Ein zweites Konto mit demselben Schlüssel wird erkannt und ersetzt das alte, statt einen Duplikat-Eintrag anzulegen.
4. **Speicherung:**
   - Das Token liegt im geteilten Keychain (Dienst `tech.jensk.synclet.sync`, Account = Kontoschlüssel).
   - Die Kontometadaten (Server-URL, Anzeigename, Benutzername, Bereiche) liegen als JSON in der App-Group.
5. **File-Provider-Domain** je Konto, Anzeigename „Synclet – <benutzer>@<host>“.
6. **Abmelden:** `DELETE /sync/v1/devices/current` (best effort), danach Domain entfernen sowie Token und Pins löschen. Lokale, noch nicht hochgeladene Änderungen werden vorher gemeldet; der Benutzer muss bestätigen.
7. **Token ungültig (401/403):** Die Extension meldet es per App-Group und Darwin-Notification (wie Buro). Das Menü zeigt „Anmeldung erforderlich“, und eine Neuanmeldung behält die Domain.

### 2.3 Virtuelle oberste Ebene
- **Containerebene:** `NSFileProviderItemIdentifier.rootContainer` liefert ein Element je Bereich aus `spaces`.
  - Item-Identifier: `space:<id>`. Der Inhalt wird auf das Server-Item `rootId` abgebildet; Server-IDs unterhalb bleiben unverändert (`d_…`, `f_…`).
  - Anzeigename lokalisiert nach `kind`: personal → „Meine Dateien“ / „My Files“. Unbekannte Kinds zeigen den Server-`name`.
- **Schreibschutz:** Die Wurzel und die Bereichsordner haben keine Rechte für Schreiben, Umbenennen, Löschen oder Umbenennen-Hinein. Versuche werden mit einem passenden File-Provider-Fehler abgelehnt.
- **Änderungen der Bereichsliste:** Ändert sich `spaces` (Abfrage bei Start, bei SSE-Neuverbindung und alle 15 min), signalisiert die App den Root-Enumerator.
- **Changes-Feed:** Alle Items aus `/changes` mit `parentId = root` werden unter `space:personal` einsortiert.

### 2.4 Änderungen erkennen
- **Lokal → Server:** Die File-Provider-API ruft `createItem`, `modifyItem` und `deleteItem` der Extension auf (wie Buro).
- **Server → lokal:**
  - Die App läuft als Login-Item (`SMAppService.mainApp`) und hält je Konto einen `EventStream`.
  - Bei `changes` ruft sie `NSFileProviderManager(for: domain).signalEnumerator(for: .workingSet)` auf; die Extension holt dann `/changes`.
  - Fallback: Ist der Stream nicht verbunden, wird alle 60 s signalisiert.
  - Neuverbindung mit exponentiellem Backoff von 1 s bis 60 s mit Jitter.
  - Bei Netzwechsel (`NWPathMonitor`) und nach dem Aufwachen wird sofort neu verbunden und signalisiert.
- **410 `cursor_expired`:** vollständige Neuaufzählung wie bei Buro.

### 2.5 Offline-Pinning
- **Einstellungen:** Je Konto eine Liste, je Bereich ein Schalter „Ganzer Bereich offline“ plus Schalter für jeden Ordner der ersten Ebene des Bereichs. Die Ordner der ersten Ebene werden live per `GET /items/<rootId>/children` geladen.
- **Speicherung:** im PinStore (App-Group, je Konto und Bereich), als Item-IDs. Bei Umbenennen bleiben die IDs stabil, der Pin bleibt also erhalten. Wird ein gepinnter Ordner gelöscht, verschwindet der Pin.
- **Umsetzung:**
  - Für gepinnte Ordner und alle Nachfahren liefert die Extension `contentPolicy = .downloadEagerlyAndKeepDownloaded`, sonst die Standardregel (Laden bei Bedarf).
  - Nach einer Pin-Änderung signalisiert die App die betroffenen Container, damit macOS die neue Regel übernimmt und herunterlädt.
  - Neue Dateien in gepinnten Ordnern werden dadurch automatisch geladen.
- **Rückfall-Pfad:** Liefert die Prüfung im ersten Plan-Task, dass die Regel nicht an Nachfahren vererbt wird, setzt die Extension sie für jedes Item explizit. Sie bestimmt dazu beim Mappen den Vorfahren auf der ersten Ebene über die bekannte Elternkette (State in der App-Group). Notfalls ruft die App `requestDownloadForItem` auf.
- **Anzeige im Menü:** belegter Offline-Speicher je Konto, berechnet aus den Größen der gepinnten Inhalte.
- **Finder:** „Heruntergeladen behalten“ und „Download entfernen“ funktionieren für Einzeldateien unabhängig davon.

### 2.6 Upload und Download
- **Neue Datei ≤ 32 MiB:** `POST /items/upload?parentId&name&onConflict=rename`.
- **Ersetzen ≤ 32 MiB:** `PUT /items/:id/content` mit `If-Match`. Zusätzlich `X-Synclet-Modified-At` setzen.
- **Über 32 MiB:** tus 1.0 (`/api/sync/v1/uploads`) in Stücken zu 16 MiB.
  - Der Upload-Zustand (Upload-URL, Offset, Ziel, Basis-ETag) wird in der App-Group gespeichert, Schlüssel = File-Provider-Item plus Inhaltsversion.
  - Bei Wiederaufnahme: `HEAD` und weiter ab dem Offset. Hat sich die lokale Datei geändert, wird der Upload verworfen und neu begonnen.
  - Ersetzungen über tus nutzen den Basis-ETag wie in `SYNC_API.md` §7.
- **Fortschritt:** Die `Progress`-Objekte der File-Provider-API werden befüllt, sodass Finder den Fortschritt zeigt.
- **Download:** `GET /items/:id/content` mit Range-Unterstützung, Fortsetzen nach Abbruch.

### 2.7 Konflikte, Vorschaubilder, Fehler
- **Konflikt:** `412 conflict` beim Ersetzen → lokale Fassung als „<Name> (Konflikt <Computername> <JJJJ-MM-TT HH-mm>).<ext>“ im selben Ordner hochladen, danach die Server-Fassung neu holen (Buro-Logik).
  - Lokal geänderte Datei, die remote gelöscht wurde → als neue Datei wieder hochladen.
- **Vorschaubilder:** Die Extension implementiert `fetchThumbnails` über `GET /items/:id/thumbnail` (ETag-gecacht in der Extension). Für Dateien ohne Server-Thumbnail kein Bild.
- **Fehler:** Die Abbildung der HTTP-Codes auf File-Provider-Fehler übernimmt das ErrorMapping (aus Buro portiert). Dazu kommen:
  - `413 too_large` → nicht wiederholen, Meldung im Menü
  - `423` (tus belegt) → später erneut versuchen
  - `507` (Speicher voll) → Meldung
- **Menüleiste:**
  - je Konto Status: verbunden / synchronisiert / Fehler / Anmeldung nötig, mit Zeitpunkt des letzten Abgleichs
  - „Im Finder öffnen“, „Web öffnen“
  - die letzten 20 Fehler mit Dateiname
  - Einstellungen (Konten, Pinning, Autostart), Beenden
- **Logging:** `os.Logger`, Subsystem `tech.jensk.synclet`. Es werden keine Tokens geloggt.

## 3. Tests
- **SyncletKit:** Buros Tests werden mitportiert. Neue Tests:
  - virtuelle Ebene und Mapping von `space:`-IDs
  - Schreibschutz der obersten Ebene
  - TusUploader gegen einen Fake-Server: Abbruch, Wiederaufnahme, geänderte Datei
  - SSE-Parser: Ereignisse, Kommentare, Mehrzeilen-Daten, Reconnect und Backoff
  - PinStore und contentPolicy-Ableitung
  - ConflictNaming
- **Server:** Unit- und E2E-Tests für `spaces` und `/events`:
  - Benachrichtigung nach Commit, nicht bei Rollback
  - Bündelung
  - Limit von 10 Streams
  - Widerruf beendet den Stream
  - Auth
- **Live-Tests (opt-in per Env):** Kit gegen den lokalen Docker-Stack. Login per App-Token-Endpunkt mit Testbenutzer, Upload, Ersetzen, Konflikt und tus.
- **Manuelle E2E-Checkliste** (`apps/macos/README.md`):
  - Anmeldung und zweites Konto
  - Finder: Struktur „Meine Dateien“, Öffnen, Bearbeiten, Umbenennen, Verschieben, Löschen
  - Änderung im Web erscheint in ≤ 3 s
  - Konflikt
  - große Datei mit WLAN-Abbruch
  - Pinning eines Ordners und eines ganzen Bereichs
  - Abmelden, widerrufenes Gerät, Server nicht erreichbar
- **Build:** `xcodegen generate`, dann `xcodebuild test` für Kit und App; läuft lokal auf dem Mac (keine CI).

## 4. Auslieferung
- `apps/macos/build_and_notarize.sh`: Archiv, Developer-ID-Export, `notarytool` (Profil `synclet-notary`, einmalig lokal einzurichten), Stapling, DMG mit Hintergrundbild.
- Version 0.1.0.
- Die DMG wird nicht ins Repo eingecheckt. Ausgabe nach `apps/macos/build/` (gitignored).

## 5. Risiken
- **Pinning:** Die Vererbung von `contentPolicy` an Nachfahren muss sich in der Praxis bestätigen. Darum steht die Prüfung als erster Task im Plan, mit dem Rückfall-Pfad aus §2.5.
- **SSE hinter fremden Proxys:** Timeouts unter 25 s brechen die Verbindung ab. Der Fallback per Polling fängt das auf, und das README dokumentiert es.
- **macOS 26 als Mindestversion:** schließt ältere Macs aus (bewusst, Entscheidung des Users).
- **Ohne Push:** Ist die Menüleisten-App beendet, kommen Server-Änderungen erst beim nächsten Finder-Zugriff an. macOS fragt die Extension dann selbst ab.
