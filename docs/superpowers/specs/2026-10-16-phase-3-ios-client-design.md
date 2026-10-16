# Synclet Phase 3 – iOS-Client (Design)

Stand: 2026-10-16 · Basis: Hauptspec `2026-10-15-synclet-design.md` (§11 Roadmap), Phase-2-Spec `2026-10-15-phase-2-macos-client-design.md`, Branch `phase-2`.

## Ziel
Eine native Universal-App für iPhone und iPad. Sie bindet Synclet-Konten über eine File-Provider-Erweiterung
in die Dateien-App ein und bringt einen eigenen Datei-Browser mit Vorschau, Verwaltung, Suche,
Papierkorb, Freigabe-Links und Uploads mit. Dazu kommt eine Teilen-Erweiterung („Teilen → Synclet“).
Die Sync-Logik kommt aus `SyncletKit` (Phase 2); die File-Provider-Erweiterung ist dieselbe wie auf dem Mac.

**Entscheidungen des Users (2026-10-16):**
- iOS vor Windows; Windows (Phase 2b) folgt danach.
- App-Umfang: Browser + Vorschau + Upload, Freigabe-Links teilen; dazu Verwalten, Suche, Papierkorb.
- Kein APNs: SSE im Vordergrund, sonst Aktualisierung beim Öffnen der Dateien-App und per Hintergrund-Refresh.
- iPhone und iPad (Universal, iPad mit Sidebar-Layout).
- **Kein Offline-Pinning auf iOS.**
- Foto-/Datei-Upload per Picker in der App und per Share-Extension, Hintergrund-Upload.
- Architektur A: Der In-App-Browser spricht direkt mit dem Server; die File-Provider-Erweiterung läuft daneben.

**Nicht Teil von Phase 3:**
- Offline-Pinning, APNs, automatischer Kamera-Upload
- Euro-Office oder sonstiges Bearbeiten in der App (Bearbeiten geht über die Dateien-App und andere Apps)
- Offline-Cache für den In-App-Browser (außer Vorschaubildern und zuletzt geöffneten Dateien, §2.5)
- Versionen-UI (bleibt Web)
- App-Store-Veröffentlichung (Archiv/TestFlight-Skript ja, Upload macht der User)

## 1. Server

Der Server bringt fast alles mit: `ios` ist als App-Client mit `synclet://oauth` registriert
(`auth/app-clients.ts`), Suche/Zuletzt (`/sync/v1/search`, `/sync/v1/recent`), Papierkorb (`/api/trash`)
und Freigaben (`/api/shares`) nehmen Geräte-Tokens (`syd_`) an.

### 1.1 Freigaben in den Vertrag
`/api/shares` (POST, GET `?itemId=`, POST `:id/rotate`, PATCH `:id`, DELETE `:id`) wird Teil der
Sync API v1 (neuer Abschnitt in `docs/sync/SYNC_API.md`, OpenAPI, Konformitätstests). Bisher stand es in §12
als „Web-Route, kann sich ändern“.
- Antwort `ShareLinkWire` wie heute. `url` ist absolut, wenn `SYNCLET_PUBLIC_URL` gesetzt ist, sonst
  `/s/<token>`; der Client löst eine relative URL gegen seine Server-URL auf.
- Fehler im üblichen Sync-Fehlerformat (`{error:{code,message}}`), auch für Validierungsfehler.
  Wo die Share-Routen heute anders antworten, werden sie angeglichen (das Web nutzt nur `code`/`message`).

### 1.2 Prüfung Papierkorb und Suche
Konformitätstests decken mit einem Geräte-Token ab: `GET /api/trash`, Wiederherstellen (inkl. `409` bei
belegtem Namen bzw. laufender Verarbeitung), endgültig Löschen, `search`, `recent`. Was dabei abweicht,
wird am Server korrigiert, nicht im Client umgangen.

### 1.3 Gerätename
Keine Server-Änderung. Der Client meldet `platform: "ios"` und als Namen den Gerätenamen
(`UIDevice.current.name`, sonst „iPhone“/„iPad“).

## 2. iOS-Client

### 2.1 Struktur
```
apps/apple/SyncletKit          wie Phase 2, zusätzlich:
  API/AppAPI.swift             Suche, Zuletzt, Papierkorb, Freigaben (Geräte-Token)
  Upload/UploadQueue.swift     persistente Warteschlange im App-Group-Container
  Upload/BackgroundUploader.swift  URLSession-Hintergrund-Uploads (einfach + tus)
  FileProvider/…               plattformneutral (Signal-Helfer aus apps/macos/Shared wandern hierher)
apps/ios/                      XcodeGen (project.yml), generiertes Projekt wird committet
  Synclet/                     SwiftUI-App (iPhone + iPad)
  SyncletFileProvider/         File-Provider-Erweiterung (Unterklasse von SyncletReplicatedExtension)
  SyncletShare/                Share-Extension
  SyncletTests/                Unit-Tests der App-Modelle
  SyncletUITests/              UI-Tests gegen Wegwerf-Server
  README.md                    Geräte-Checkliste
scripts/ios-live-tests.sh      Wegwerf-Stack + Simulator-Tests
```
- **Kennungen:** Team `JC32M95WLZ`; App `tech.jensk.synclet.ios`, Erweiterungen
  `tech.jensk.synclet.ios.FileProvider` und `tech.jensk.synclet.ios.Share`.
  App Group `group.tech.jensk.synclet`, Keychain-Gruppe `$(AppIdentifierPrefix)tech.jensk.synclet.shared`,
  Keychain-Service `tech.jensk.synclet.sync`, Schema `synclet://oauth`, `client_id` `ios`.
- **Mindestversion:** iOS/iPadOS 26.
- **SyncletKit für iOS:** Das Paket baut und testet für macOS und den iOS-Simulator. Mac-spezifisches
  (Pinning, Menüstatus, `Host`-Gerätename) bleibt unter `#if os(macOS)` bzw. wird von der iOS-App einfach
  nicht benutzt; Pinning-Aufrufe in der Erweiterung laufen auf iOS ins Leere (alle Items `.inherited`).
- Ein Speicherort pro Konto wie auf dem Mac (`AccountStore`, Schlüssel `organizationId`); App und
  Erweiterungen teilen Konten und Tokens über App Group und Keychain-Gruppe.

### 2.2 Konten und Anmeldung
- Login über `ASWebAuthenticationSession` mit PKCE (`AuthAPI` aus SyncletKit), `client_id=ios`.
- Mehrere Konten. Pro Konto eine File-Provider-Domain; die Dateien-App zeigt pro Konto einen Speicherort
  mit dem Ordner „Meine Dateien“ (gleiche virtuelle oberste Ebene wie Phase 2, `SpaceLayout`).
- Abmelden entfernt Domain, Token und Kontodaten und widerruft das Gerät am Server (best effort).
- Widerrufenes Gerät (`401 device_revoked`/`unauthorized`): Konto zeigt „Neu anmelden“; App und
  Erweiterung nutzen denselben Auth-Fehler-Marker wie auf dem Mac.

### 2.3 App-Oberfläche
- **iPhone:** `NavigationStack` mit Kontowahl oben; Tabs „Dateien“, „Zuletzt“, „Suche“, „Mehr“
  (Papierkorb, Konten, Uploads, Einstellungen).
- **iPad:** `NavigationSplitView`: Sidebar (Konten → Meine Dateien, Zuletzt, Papierkorb, Uploads), Inhalt, Detail.
- **Ordneransicht:** Liste oder Raster (pro Gerät gemerkt), Sortierung Name/Datum/Größe, Ordner zuerst,
  Vorschaubilder vom Server (`GET /items/:id/thumbnail`), Pull-to-Refresh.
- **Datei öffnen:** Download in den App-Cache (`RangeDownloader`, Fortschritt), dann QuickLook
  (`QLPreviewController`). Aus QuickLook: Teilen („Öffnen in …“, Speichern in Fotos/Dateien).
- **Verwalten:** Neuer Ordner, Umbenennen, Verschieben (Ordnerauswahl-Dialog), Löschen (Papierkorb,
  mit Bestätigung). Mehrfachauswahl für Verschieben/Löschen. Alles über die Sync API mit `If-Match`.
- **Suche:** Volltextsuche (`/sync/v1/search`), Treffer mit Pfad und Snippet (`«…»` hervorgehoben),
  optional auf aktuellen Ordner begrenzt.
- **Zuletzt:** `/sync/v1/recent`.
- **Papierkorb:** Liste, Wiederherstellen, endgültig löschen, Papierkorb leeren (mit Bestätigung).
- **Freigabe-Link:** Aus dem Kontextmenü „Link teilen“: bestehenden aktiven Link verwenden oder neuen
  anlegen, optional Passwort, Ablaufdatum, Download erlauben, Upload erlauben (nur Ordner). Danach
  System-Share-Sheet mit der URL. Link widerrufen in derselben Ansicht.
- **Upload:** „+“-Menü: Fotos (`PhotosPicker`), Dateien (`fileImporter`), Neuer Ordner. Ziel ist der
  aktuelle Ordner. Uploads laufen über die Warteschlange (§2.6).
- **Sprache:** Deutsch und Englisch (String Catalog), wie Web und Mac.

### 2.4 Aktualität
- **App im Vordergrund:** Pro aktivem Konto ein SSE-Stream (`EventStream` aus SyncletKit). Bei `changes`
  lädt die App die sichtbare Ordneransicht neu und ruft `signalEnumerator(.workingSet)` für die Domain.
  Fällt der Stream aus: Polling alle 60 s, solange die App aktiv ist.
- **App im Hintergrund:** Stream wird beim Wechsel in den Hintergrund beendet.
  `BGAppRefreshTask` (Ziel: alle 30 min, iOS entscheidet) signalisiert für jede Domain den Working Set;
  die Dateien-App holt Änderungen ohnehin beim Öffnen (`enumerateChanges`).
- **Änderungen aus der App:** Nach jeder erfolgreichen Mutation (Anlegen, Umbenennen, Verschieben,
  Löschen, Upload fertig, Wiederherstellen) signalisiert die App den Working Set.

### 2.5 Caches
- Vorschaubilder: `URLCache`/Dateicache mit `If-None-Match`, Obergrenze 200 MB, LRU.
- Geöffnete Dateien: App-Cache (`Library/Caches`), Obergrenze 1 GB, LRU; Eintrag gilt nur, solange
  `version` übereinstimmt. „Cache leeren“ in den Einstellungen.
- Kein Offline-Browsen: Ohne Netz zeigt der Browser „Offline“ mit „Erneut versuchen“.

### 2.6 Uploads (App und Share-Extension)
- **Warteschlange** `UploadQueue` im App-Group-Container (`uploads/queue.json` + `uploads/files/<id>`),
  versioniertes JSON (`"v":1`), Dateisperre wie `PinStore` (App und Share-Extension schreiben).
  Eintrag: `id`, Konto, Ziel-`parentId`, Name, Größe, Status (`waiting|uploading|done|failed`),
  Fehlercode, tus-URL/Offset.
- **Quelle wird kopiert:** Beim Einreihen wird die Datei in `uploads/files/<id>` kopiert (Fotos als
  Original, z. B. HEIC; Einstellung „Fotos als JPEG hochladen“). Danach braucht es die Quelle nicht mehr.
- **Übertragung:** Hintergrund-`URLSession` (`identifier` pro Prozess, `sharedContainerIdentifier` =
  App Group). Bis 32 MiB: `POST /sync/v1/items/upload?onConflict=rename` als `uploadTask(fromFile:)`.
  Darüber: tus (`onConflict=rename`) mit 16 MiB-Stücken; jedes Stück wird als Datei geschrieben und als
  eigener `PATCH`-Upload-Task gesendet, Offset nach jeder Antwort in der Warteschlange gespeichert.
  Nach Neustart oder Abbruch: `HEAD` auf die tus-URL und an `Upload-Offset` weitermachen; abgelaufene
  tus-URL → neu beginnen.
- **Namenskollision:** Server benennt um („Foto (2).heic“); die App zeigt den endgültigen Namen.
- **Share-Extension:** Zeigt Konto und Zielordner (zuletzt benutzter Ordner vorausgewählt, Ordnerwahl über
  die Sync API), reiht ein und startet die Übertragung über eine eigene Hintergrund-Session mit
  gemeinsamem Container. Ist die Extension beendet, übernimmt die App beim nächsten Start bzw. über
  `application(_:handleEventsForBackgroundURLSession:)`. Kein Login in der Extension; ohne Konto Hinweis
  „In der Synclet-App anmelden“.
- **Fehler:** `507` → „Speicher voll“, `404` Zielordner → „Zielordner gelöscht“, `401` → Konto
  „Neu anmelden“; diese bleiben als `failed` mit „Erneut versuchen“/„Entfernen“ stehen.
  Netzwerkfehler werden still wiederholt (Backoff, max. 10 Versuche, dann `failed`).
- **Aufräumen:** Kopie wird nach `done` gelöscht; `done`-Einträge verschwinden nach 24 h aus der Liste.
- **Uploads-Ansicht:** Fortschritt, Fehler, Erneut versuchen, Abbrechen.

### 2.7 File-Provider-Erweiterung
- Unterklasse von `SyncletReplicatedExtension` wie auf dem Mac (Enumeration, Download, Upload inkl. tus,
  Konfliktkopien, Vorschaubilder, `507`-Fehler, Auth-Fehler-Marker).
- Abweichungen iOS: kein Pinning, kein Menüstatus; `NSExtensionFileProviderDocumentGroup` =
  App Group; Speicherlimit der Erweiterung beachten (Streaming, keine ganzen Dateien im Speicher – wie heute).

### 2.8 Fehler und Grenzfälle
- **Offline:** Browser-Hinweis „Offline“, Uploads warten.
- **Konflikt bei Umbenennen/Verschieben/Löschen** (`412 conflict`): Ansicht neu laden, Meldung
  „Wurde inzwischen geändert“, Aktion nicht automatisch wiederholen.
- **Name vergeben** (`409 name_conflict`) beim Anlegen/Umbenennen: Meldung, Eingabe bleibt offen.
- **Element weg** (`404`): Ansicht neu laden, Meldung „Nicht mehr vorhanden“.
- **Papierkorb `409`** (Name im Ziel belegt bzw. noch in Bearbeitung): Meldung mit Server-Text.
- **Ungültige Namen** (Windows-verbotene Zeichen, >255 Byte): Server lehnt ab (`400`), App zeigt die Meldung;
  zusätzlich Vorprüfung im Eingabefeld.

## 3. Tests
- **SyncletKit:** baut und testet für macOS und iOS-Simulator (`swift test` bzw. `xcodebuild test` mit
  iOS-Simulator-Ziel). Neue Tests: `AppAPI` (Request-Aufbau, Fehlercodes, relative Share-URL),
  `UploadQueue` (Persistenz, Sperre, Versionierung, kaputte Datei, Aufräumen), `BackgroundUploader`
  (einfach vs. tus nach Schwelle, Fortsetzen nach `HEAD`, abgelaufene tus-URL, Fehlerzuordnung) mit
  `URLProtocol`-Stubs.
- **App:** Unit-Tests der View-Modelle (Ordneransicht, Verwalten, Suche, Papierkorb, Freigabe, Uploads,
  Aktualisierung bei SSE-Ereignis) im Simulator.
- **UI-Tests** (`SyncletUITests`) gegen den Wegwerf-Stack aus `scripts/ios-live-tests.sh`: Login mit
  Testkonto (nur in Debug-Builds: Launch-Argument übergibt Server-URL und Geräte-Token statt Browser-Login; in Release-Builds nicht vorhanden), Ordner anlegen, Datei hochladen,
  öffnen, umbenennen, löschen, wiederherstellen, Suche, Freigabe-Link anlegen.
- **Live-Tests** der Upload-Warteschlange gegen einen echten Server: großer Upload mit Abbruch und
  Fortsetzen ohne Duplikat.
- **Server:** Konformitätstests für Freigaben, Papierkorb, Suche mit Geräte-Token.
- **Manuell (Gerät):** Checkliste in `apps/ios/README.md`: Dateien-App (Speicherort, „Meine Dateien“,
  Öffnen, Bearbeiten in anderer App, Konfliktkopie), Share-Extension aus Fotos/Safari, Hintergrund-Upload
  bei gesperrtem Gerät, mehrere Konten, Neu anmelden.

## 4. Auslieferung
- `apps/ios/build_archive.sh`: Archiv + Export für App Store Connect/TestFlight (`ExportOptions.plist`).
  Bricht mit klarer Meldung ab, wenn Zertifikat/Profile fehlen. Hochladen macht der User.
- App-Icon aus dem Mac-Icon abgeleitet.

## 5. Risiken
- Hintergrund-Uploads: iOS verzögert Hintergrund-Sessions; große tus-Uploads mit vielen Stücken können
  im Hintergrund langsam sein. Akzeptiert; Fortschritt bleibt erhalten.
- Share-Extension-Speicherlimit (~120 MB): Dateien werden gestreamt kopiert, nie ganz geladen.
- `BGAppRefreshTask` läuft unregelmäßig; die Dateien-App ist ohne Push nur beim Öffnen aktuell.
- Ohne entsperrtes Gerät/Simulator-UI sind Dateien-App und Share-Extension in dieser Umgebung nicht
  automatisch testbar → Geräte-Checkliste.
