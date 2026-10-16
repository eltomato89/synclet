# Phase 3 – Follow-ups (iOS-/iPadOS-Client)

Stand: 2026-10-16, Branch phase-3 (T1–T10).

## Rulings (Entscheidungen während der Umsetzung)
- R0: parallele Implementierer in eigenen Worktrees pro Welle — Kosten: Merge-Konflikte (vom Controller aufgelöst)
- R1: T7 lief allein; T8 und T9 starteten erst nach dem T7-Merge, weil sie T7-Dateien ändern — Kosten: eine Welle mehr Laufzeit
- R2: `AccountsModel.changeEvents` ist ein Broadcast (jeder Zugriff liefert einen eigenen `AsyncStream`), weil mehrere Ordneransichten gleichzeitig zuhören — Kosten: keine
- R3/R4: `LoadState` liegt in `Browser/LoadState.swift` (T7, von T8 genutzt); `ThumbnailCache.clear()` für „Cache leeren“ — Kosten: keine
- R5: Fehlerformat der Sync-API ist das flache `{statusCode, message, code, item?}` (der Plantext `{error:{…}}` war falsch) — Kosten: keine
- R6: Upload-Einträge haben `owner` + `leaseUntil` (10 min, frühestens alle 30 s verlängert); nach einem Start setzt die Wiederherstellung nur eigene Einträge ohne laufende Aufgabe oder abgelaufene Leases zurück (kein Duplikat zwischen App und Share-Extension) — Kosten: zwei Felder mehr in `queue.json`
- R7: Backoff 2 s · 2^n (n = bisherige Wiederholungen), max. 300 s, 10 Versuche — Kosten: keine
- R8: 507 schlägt sofort fehl („Speicher voll“), Kopie und tus-URL bleiben; „Erneut versuchen“ setzt fort — Kosten: der User muss nach dem Freigeben von Platz selbst tippen
- R9: tus-Create und `HEAD` laufen als Download-Tasks (Hintergrund-Sessions kennen nur Upload/Download); `interpret(requestURL:)` löst relative `Location`s auf — Kosten: keine
- R10: Monitore werden beim Wechsel in den Hintergrund verworfen und spielen verpasste Änderungen nicht nach; die sichtbare Ordneransicht lädt deshalb beim Wechsel in den Vordergrund neu — Kosten: ein Listing pro Vordergrund
- R11: der Abschluss-Handler der Hintergrund-Events wird auch dann aufgerufen, wenn die Session vor `handleBackgroundEvents` fertig ist — Kosten: keine
- R12: die Thumbnail-Aufgabe hängt auch an `preview.thumbnail` (frische Uploads bekommen ihr Vorschaubild) — Kosten: keine
- R13: iPad mit zweispaltigem `NavigationSplitView` (Seitenleiste + Inhalt, QuickLook als Sheet) statt drei Spalten wie in Spec §2.3 — Kosten, falls falsch: später eine Detailspalte
- R14: „Suche“ auch in der iPad-Seitenleiste; „Link teilen“ für jedes lesbare Item (der Server hat kein Freigabe-Capability-Bit) — Kosten: kleine UI-Änderung, falls nicht gewollt
- R15 (finale Review, ersetzt die Lease-Dauer aus R6): die Session hat `timeoutIntervalForResource` = 6 h, und jeder Task-Start setzt `leaseUntil` = Start + 6 h + 10 min. Kein Task überlebt den Claim, unter dem er gestartet wurde – auch wenn niemand verlängert (Share-Extension beendet, App suspendiert, Task wartet offline). Die Verlängerung bei Fortschritt entfällt. Chunk-Dateien tragen den Session-Identifier (`<id>-<offset>@<session>`) — Kosten: Einträge eines wirklich toten Prozesses (ohne laufende Aufgabe) übernimmt der andere Prozess erst nach bis zu 6 h 10 min; ein Chunk, der länger als 6 h auf Netz wartet, scheitert und zählt als Versuch
- R16 (finale Review): die App hängt sich nur zeitweise an die Session der Share-Extension, mit einem `drainOnly`-Uploader: beim Zustellen ihrer Events (danach `finishTasksAndInvalidate`, verworfen nach `didBecomeInvalid`) und zum Abbrechen eines Share-Uploads („Abbrechen“, Abmelden: Aufgaben per `taskDescription`-Tag abbrechen, danach wieder freigeben). Der drainOnly-Uploader startet nie einen Request: er verbucht Endergebnisse und gibt jeden Folgeschritt (tus-PATCH nach Create/HEAD) als `waiting` an den App-Uploader zurück. Verworfen: ein Grabstein-Flag im Eintrag – ohne laufenden Prozess sieht ihn niemand, bevor die Systemaufgabe die Datei veröffentlicht — Kosten: siehe Einschränkungen „Share-Upload abbrechen“

## Ergebnis T10 (Tests, Auslieferung)
- `scripts/ios-live-tests.sh` läuft grün: SyncletKit-Live-Tests inkl. `LiveBackgroundUploadTests` (40 MiB per tus, Abbruch während des zweiten PATCH, neuer Uploader setzt per `HEAD` dieselbe tus-Upload-URL fort, sha256 gleich, genau ein Item) und die UI-Tests (`LaunchTests`, `BrowserFlowUITests`) auf einem privaten Simulator.
- Der UI-Flow deckt die offenen Punkte aus dem T7-Review ab, und alle drei funktionieren ohne Änderung an der App:
  - (a) Der Fehler „Name bereits vergeben“ erscheint im offenen Namens-Sheet. `NameSheet` bekommt `fieldError` zwar als `let`, der Sheet-Inhalt wird aber bei Änderungen des Modells neu ausgewertet.
  - (b) Die Löschbestätigung löscht wirklich: Das Item landet im Papierkorb und lässt sich wiederherstellen.
  - (c) QuickLook öffnet die Datei und schließt mit „Fertig“.
- **Archiv nicht gebaut:** `apps/ios/build_archive.sh` bricht mit Exit 2 ab („Kein Apple-Distribution-Zertifikat – in Xcode → Settings → Accounts anlegen“). Im Schlüsselbund sind nur zwei „Apple Development“-Identitäten. Nach dem Anlegen des Zertifikats das Skript erneut laufen lassen; das Hochladen (Organizer/Transporter) macht der User.
- **Simulator-Löschen:** Unter der iOS-27-Simulator-Runtime schlägt `simctl delete` nach einem App-Lauf manchmal mit „Operation not permitted“ fehl: CoreSimulator darf den `data`-Ordner nicht verschieben. Neben dem Gerät liegt dann ein seltsamer Ordner `datacom.apple.modelcatalog`. `ios-live-tests.sh` löscht in diesem Fall den `data`-Ordner seines eigenen Simulators (nur per UDID) und versucht es erneut, was funktioniert. Der alte Simulator `synclet-t7-visual` (C1CC13F2…) aus T7 ist so übrig geblieben. Der User kann ihn auf dieselbe Weise entfernen.

## Bekannte Einschränkungen
- **Kein Offline-Pinning** („Immer auf diesem Gerät behalten“) auf iOS: Die Pin-Logik der SyncletKit bleibt unter `#if os(macOS)`. In der File-Provider-Erweiterung laufen Pin-Aufrufe ins Leere (alle Items `.inherited`). Geöffnete Dateien liegen in der App nur im LRU-Cache (≤ 1 GB); in der Dateien-App verwaltet das System die lokalen Kopien.
- **Kein APNs/Push.** Aktuell ist die App nur im Vordergrund (SSE pro Konto, sonst Polling alle 60 s) und beim Öffnen. Die Dateien-App sieht Server-Änderungen erst, wenn sie den Ort öffnet bzw. aufzählt.
- **Hintergrundaktualisierung:** iOS bestimmt, wann `BGAppRefreshTask` (`tech.jensk.synclet.ios.refresh`, frühestens nach 30 min) läuft. Das kann Stunden dauern oder ganz ausbleiben (Energiesparmodus, selten genutzte App). Auch Hintergrund-Uploads verzögert iOS nach eigenem Ermessen. Der Fortschritt bleibt aber erhalten.
- **Nicht automatisiert getestet:** Dateien-App (File Provider), Share-Extension (Fotos/Safari), Hintergrund-Upload bei gesperrtem Gerät, 507-Pfad auf dem Gerät, Geräte-Widerruf und Abmelden in der Dateien-App, das Zusammenspiel App ↔ Share-Session. Dafür gibt es die Geräte-Checkliste in `apps/ios/README.md` (17 Schritte), die noch aussteht.
- **Verlorene Antwort → „(2)“-Kopie:** Hat der Server ein einzelnes `POST /items/upload` (bzw. den letzten tus-PATCH) bereits übernommen, geht aber die Antwort verloren (Verbindungsabbruch, Timeout), wiederholt der Uploader und `onConflict=rename` legt „Name (2)“ an. Das ist dem Protokoll inhärent (kein Idempotenz-Schlüssel).
- **Backoff nur im Prozess geweckt:** Einen wartenden Retry (`nextAttemptAt`) startet nur ein laufender Prozess (`UploadCenter` plant einen Pump bzw. der nächste Vordergrund/Launch). Nach einem Hintergrund-Wecken wartet er daher bis zum nächsten Vordergrund.
- **Share-Upload abbrechen:** Die App bricht die Aufgabe in der Share-Session ab, bevor sie den Eintrag entfernt. Hat die Systemaufgabe die Datei bis dahin schon veröffentlicht (Antwort unterwegs), bleibt sie auf dem Server; der Eintrag verschwindet trotzdem (kein `done`, kein Löschen auf dem Server). Läuft die Share-Extension in dem Moment noch (iPad Split View, oder Sekunden nach „Hochladen“), benutzen kurz zwei Prozesse dieselbe Session; das Verhalten bestimmt dann das System. Dasselbe gilt, wenn die Extension erneut startet, solange die App die Session noch nicht freigegeben hat (laufende Aufgaben anderer Einträge).
- **Upload im UI-Test:** Der UI-Test kann den System-Dateiimporter im Simulator nicht zuverlässig bedienen. Deshalb nimmt in DEBUG-Builds „Dateien“ mit dem Launch-Argument `-SyncletTestUpload <Pfad>` diese Datei direkt in die Warteschlange; den echten Importer prüft nur die Checkliste.
- **`search.field`:** `.searchable` nimmt keinen Accessibility-Identifier an. Der UI-Test findet das Suchfeld über `app.searchFields.firstMatch`.
- **UI-Tests nur im iPhone-Layout:** Der Flow erwartet Tab-Leiste und „Mehr“. Das iPad-Layout (Seitenleiste) prüft nur die Checkliste (Schritt 15). Drag & Drop aus der Dateien-App in die App gehört nicht zum Umfang.
- `LaunchTests` braucht eine frische Installation. Das Skript startet es deshalb in einem eigenen `xcodebuild test`-Lauf vor dem angemeldeten Flow.

## Offene Kleinigkeiten (deferred, aus den Reviews)
- **SyncletKit – API-Client (T2):**
  - Der Encoder von `sendRaw` sortiert jetzt global die Schlüssel (`.sortedKeys`).
  - Einrückung der Folgezeilen in `send`/`sendNoContent`/`sendRaw`; doppelte Leerzeile in `AppModels.swift`.
  - Es fehlen Tests für `expiresAt: .some(nil)` → `null` und für die Standardwerte der Suche.
- **SyncletKit – Upload-Warteschlange (T4):**
  - `update()` unterscheidet nicht zwischen „Eintrag weg“ und „Schreiben fehlgeschlagen“ (beides `nil`; Schreibfehler werden seit der finalen Review geloggt, und `.finished` löscht die Kopie nur bei gespeichertem `done`).
  - Die `change`-Closure läuft unter dem `flock` (nur dokumentieren).
  - Nur `createdAt` wird auf Millisekunden gerundet. Encoder und Formatter werden pro Datum neu gebaut.
  - `corrupt-*`-Dateien werden nie aufgeräumt.
  - `load()`: Ist der Elternordner unzugänglich, liefert `fileExists` `false` → `.entries([])`. Das kann verwaiste Kopien wegräumen; ein Stat-Fehler außer ENOENT sollte als „nicht verfügbar“ gelten.
  - Eine dauerhaft unlesbare Queue heilt nie von selbst.
  - Testlücken: Retry als No-op, `update` mit unbekannter ID, zwei Prozesse, zeitliches Verhalten beim Kopieren in die Warteschlange.
- **SyncletKit – BackgroundUploader (T5):**
  - `restartTus` ist unbegrenzt und zählt nicht als Versuch; `attempts` wird nach Fortschritt nie zurückgesetzt.
  - `pumpLater` läuft asynchron vor der Suspendierung.
  - Der Bearer-Token bei Cross-Origin-Redirects wird nicht verhindert (wie im übrigen Kit).
  - Es gibt keinen Uploader-Test für den Cross-Origin-Schutz der gespeicherten tus-URL; die Assertion „not runnable before time“ ist fast wirkungslos; der Testname `…IsRetry` prüft einen Fehlschlag.
- **SyncletKit – Testinfrastruktur (T1):**
  - `swiftkit-test-ios.sh` gibt bei fehlendem Gerätetyp nur den nackten `simctl`-Fehler aus.
  - Der Darwin-Notification-Test ist prozessglobal.
  - Einrückung in `report()`.
  - Ein fehlschlagender iOS-Lauf startet `simctl diagnose` (~10 min); `-collect-test-diagnostics never` erwägen.
- **Server/Vertrag (T3):**
  - `GET /shares` mit ungültiger `itemId` (400) ist dokumentiert, aber ungetestet.
  - Die 404-Antwort für ein unbekanntes Item wird nicht gegen das Schema geprüft; eine fehlerhafte (Nicht-UUID-)Share-ID ist ungetestet.
  - Zeilenumbruch in §12.
- **App – Konten/Lebenszyklus (T6):**
  - Das Ablaufen der BG-Aufgabe bricht die Signal-Schleife nicht sofort ab.
  - `addRegistered` speichert den Token vor dem Upsert und überschreibt `deviceId` ohne Widerruf (nur DEBUG).
  - `LoginView` bricht in `onDisappear` ab (auf dem Gerät prüfen).
  - `LoginModel` wird pro Re-Render gebaut.
  - `suspendForSignIn` lässt `trailingSignal`/`accountTask` stehen.
- **App – Browser/Vorschau (T7):**
  - Die Thumbnail-Verdrängung durchsucht bei jedem Schreiben den Ordner, und jeder Treffer berührt die Datei.
  - Ein Mitwartender eines abgebrochenen `FileCache`-Downloads hängt.
  - Gleichzeitige Downloads verschiedener Versionen löschen sich gegenseitig die Dateien.
  - Das Neuladen beim Szenenwechsel ist nicht auf den sichtbaren Ordner beschränkt.
  - `FileCache` nutzt `ThumbnailCache.key`.
  - Scheitert das Neuladen im Hintergrund, verschwindet die Liste.
  - `MovePicker` baut sein `FolderModel` bei jeder Body-Auswertung.
  - Testlücken: 412 beim Einzel-Verschieben; Dedup und Abbruch im Cache.
- **App – Suche/Freigaben (T8):**
  - Ein Fehler bei `loadMore` wird nur geloggt.
  - Der Standard-Ablauf von 7 Tagen im DatePicker ist ungetestet.
  - Ein unlesbares `expiresAt` gilt stillschweigend als inaktiv.
  - Die Suchtests sind zeitabhängig; es fehlen Tests für den Abbruch laufender Anfragen und für den Wechsel des Suchbereichs.
- **App – Uploads/Share-Extension (T9):**
  - „Erledigte entfernen“ leert die Uploads aller Konten.
  - Pro Fortschritts-Callback entsteht eine MainActor-Task; nach einem Retry kann der alte Fortschritt stehen bleiben.
  - Kein Kit-Test für `onProgress`.
  - Die Item-Anzahl der Share-Extension zählt übersprungene Links mit.
  - Die Aktivierungsregel erlaubt 50 Anhänge pro Extension-Item.
  - Ausgewählte Videos werden zweimal kopiert.
