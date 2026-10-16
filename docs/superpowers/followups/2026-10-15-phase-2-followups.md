# Phase 2 – Follow-ups (aus den Reviews)

Stand: 2026-10-16, Branch phase-2 (T1–T8, T5b, T9, T10, Final-Fixwelle).

## Rulings (Entscheidungen während der Umsetzung)
- Ruling: Wave 0 = T1, T2, T3 parallel in eigenen Worktrees — Kosten: Merge-Konflikte in docs/openapi (vom Controller aufgelöst)
- Ruling: manuelle Finder-Prüfungen laufen auf dem Mac des Users gegen einen lokalen Wegwerf-Stack; Agents entfernen ihre File-Provider-Domains danach — Kosten: kurzzeitige Seitenleisten-Einträge während der Tests
- Ruling: SSE-Streams im Web enden nach dem Logout erst mit Ablauf des Access-Tokens (≤ 15 min); der Geräte-Widerruf beendet Streams sofort — Kosten: ein abgemeldeter Browser-Tab kann bis zu 15 min Wake-ups bekommen (ohne Daten, `/changes` verlangt weiter Auth)
- Ruling: eigener Pro-User-Limiter für Stream-Öffnungen (es gab noch keinen Pro-User-Bucket) — Kosten: keine
- Ruling: Space-Ordner bekommen `.allowsAddingSubItems`, wenn `canWrite` (das SDK-Bit entspricht `allowsWriting`; Absicht der Spec: Dateien liegen in „Meine Dateien“); nie umbenennen, verschieben oder löschen; der Root-Container ist vollständig schreibgeschützt — der Plantext war falsch — Kosten: keine
- Ruling: `.cannotSynchronize` für Schreibversuche in den Root bleibt; der manuelle Lauf prüft das Finder-Verhalten, bei hängenden Items Wechsel auf `.fileWriteNoPermission` — Kosten: später eine Zeile Änderung (**offen**, Checkliste Schritt 7)
- Ruling: die Server-Prüfung beim Anmelden akzeptiert 401/403 mit Sync-API-Fehler-JSON auf `/capabilities` (die Route ist nicht anonym) — der Plantext war falsch — Kosten: keine
- Ruling: die manuellen Finder-Prüfungen aus T4–T8 werden in einer vom User auszuführenden Checkliste gesammelt (`apps/macos/README.md`; nötig sind ein entsperrter Mac und ein interaktiver Browser-Login) — Kosten: Fehler auf Finder-Ebene fallen spät auf
- Ruling: der Server konnte per tus nicht ersetzen (Spec §2.6 hatte das vorausgesetzt) → neuer Task 10 (Server, additive tus-Metadaten `itemId` + `ifMatch`); der Client stellt große Ersetzungen in Task 5b auf tus um — Kosten: eine zusätzliche kleine Runde
- Ruling: T7 setzt Strategie B um (explizite `contentPolicy` an jedem Nachfahren über `PinPolicy`), ohne vorherige Probe. B ist korrekt, ob macOS die Policy vererbt oder nicht; die Probe wandert in die User-Checkliste (Schritt 19) — Kosten: eine Parent-Map und Policy-Arbeit pro Item, die Strategie A eventuell erspart hätte
- Ruling: T7 und T8 warten auf den Merge von T5 (gleiche Dateien Extension/ItemMapping) — Kosten: Serialisierung
- Ruling: der Client-Wechsel auf tus-Replace sowie N1/N2 aus dem T5-Re-Review werden Task 5b, nach dem Merge von T10 — Kosten: ein kleiner Extra-Task
- Ruling: die Anzeige des Offline-Speichers im Menü (Spec §2.5) wird beim T8-Merge oder in T9 verdrahtet — **in T9 erledigt** (Zeile „Offline-Inhalte ≈ …“ pro Konto, nur bei vorhandenen Pins)
- Ruling: der Negativ-Cache für Vorschaubilder bei 404 eskaliert 2 s/5 s/15 s/60 s/5 min/10 min (§9.1); 415/400 pauschal 10 min — Kosten: keine
- Ruling (T9): `LiveAPITests` ergänzt die bestehenden Live-Klassen, statt sie zusammenzulegen. `LiveTransferTests` (Abbruch und Resume mit 200 MB), `LiveThumbnailTests` (Cache, 304, PDF, 413) und `EventStreamLiveTests` (Restart) decken mehr ab als der Brief und bleiben. `scripts/macos-live-tests.sh` setzt das Env für alle vier, einschließlich eines Geräte-Tokens für `SYNCLET_LIVE_TOKEN`.

## Offen aus T9 (Auslieferung)
- **Notarisierung nicht gelaufen.** Auf diesem Mac fehlen:
  - ein Xcode-Account („No Accounts“)
  - ein „Developer ID Application“-Zertifikat für das Team JC32M95WLZ (im Schlüsselbund sind nur Apple-Development-Identitäten)
  - die Developer-ID-Provisioning-Profile für `tech.jensk.synclet.mac` und `tech.jensk.synclet.mac.fileprovider`
  - das Notary-Profil `synclet-notary`

  Das Archive (Release) baut. Der Export bricht mit genau diesen Fehlern ab. Den DMG-Teil des Skripts (Hintergrund, Applications-Link, Volume-Icon, Finder-Layout) habe ich separat mit der archivierten App geprüft. Nach der Einrichtung (README „Signing and notarization“) `apps/macos/build_and_notarize.sh` erneut laufen lassen.
- **Manuelle Finder-Checkliste** (`apps/macos/README.md`, 31 Schritte) steht aus. Sie entscheidet über:
  - `.cannotSynchronize` vs. `.fileWriteNoPermission` (Schritt 7)
  - ob die Extension in den Systemeinstellungen aktiviert werden muss (Schritt 4)
  - ob der Resume-Key über `createItem`-Retries stabil ist (Schritt 15)
  - die Pin-Vererbung (Schritt 19)
  - ob ein Upload nach 507 innerhalb von 1 Minute weiterläuft, sobald wieder Platz ist (Schritt 30, Final-Review I2)
- Das Finder-Layout des DMG nutzt AppleScript und braucht eine GUI-Sitzung mit Automation-Recht. Ohne sie warnt das Skript, und die DMG hat dann kein Hintergrundbild. Finder entfernt beim Layout `.VolumeIcon.icns` samt Custom-Icon-Flag, darum setzt das Skript beides erst nach dem Layout.
- Compiler-Warnung `BrowserLogin.swift:49` (implizit starkes `self` neben `[weak self]`) besteht seit T4.

## Bekannte Einschränkungen
- Nur der persönliche Bereich („Meine Dateien“). Geteilte Bereiche kommen in einer späteren Phase; das Format von `spaces` ist dafür vorbereitet.
- Ohne Push: Ist die Menüleisten-App beendet, kommen Server-Änderungen erst beim nächsten Finder-Zugriff an.
- SSE hinter fremden Proxys: Idle-Timeouts unter 25 s brechen den Stream ab. Dann übernimmt Polling alle 60 s.
- Konflikte werden nicht gemergt; die lokale Fassung wird zur Kopie „(Konflikt <Gerät> <Datum>)“.
- Ein leerer `baseVersion` in `modify()` fällt auf den aktuellen Server-ETag zurück und ersetzt damit blind (T5b m4, vorbestehend). Was ein leerer Basisstand bedeuten soll (ablehnen, oder holen und Konflikt), ist eine Produktentscheidung.
- Der Resume-Key eines Uploads ist Template-ID + `contentVersion`. Wechselt das System die Template-ID über Retries, startet ein Upload von vorn. Das ist korrekt, kostet aber Zeit (T5 Concern 2, Checkliste Schritt 15).
- Ein Replace ist an Item-ID + Basis-ETag gebunden. Eine zweite lokale Änderung desselben Basisstands vor dem Abschluss startet das Replace neu, statt es fortzusetzen.
- Neue Uploads über 32 MiB listen vor dem tus-Start einmal den Elternordner (Prüfung auf identische Datei). Bei sehr großen Ordnern sind das einige Requests mehr.
- Pinning eines ganzen Bereichs meldet den ganzen Baum in einem Working-Set-Durchlauf neu. Bei sehr großen Bereichen ist das langsam, und es wiederholt sich nach einem Fehler.
- macOS Docker Desktop (Bind-Mounts): siehe Phase 1c, Inode-Drift. Betrifft die Live-Tests nicht.

## Offene Kleinigkeiten (deferred)
- T1 M3: die Kopie in den Papierkorb über Dateisystemgrenzen (`moveAcrossFs` nach /meta) mappt ENOSPC nicht auf 507.
- T3 M6: Umbenennen und Verschieben senden kein `If-Match` (last writer wins); das war für T5/T7 vorgesehen und ist nicht umgesetzt.
- T4 Nits:
  - ein schneller zweiter Login kann im Callback eine neuere `ASWebAuthenticationSession` auf `nil` setzen
  - ein `URLError.cancelled` während der Server-Prüfung zeigt in einem geschlossenen Fenster „nicht erreichbar“
- T5 M3: beim Abbruch wird der Server-Upload nicht beendet (DELETE). Der Server räumt nach 24 h auf.
- T5 M5 (teilweise, akzeptiert): `LazyHash` ist abbrechbar und gibt alle 16 MiB ab, läuft aber weiter auf dem kooperativen Pool (kein eigener Thread).
- T5 M6 (teilweise, akzeptiert): der Test-Fake liefert `.partial`-Fehler weiter mit `asyncAfter(0.1)`; keine Assertion hängt mehr am genauen Offset.
- T5b n1: der transiente Zweig von m2 vergleicht `item.size` nicht.
- T5b n2: antwortet tus-POST für ein Replace dauerhaft 404, während `GET /items/:id` das Item liefert, löst sich das nie auf. Es fehlt eine Logzeile bzw. eine Eskalation.
- T6:
  - M4: `.polling`-Zustand bzw. echter „zuletzt synchronisiert“-Zeitpunkt aus `spaces/<id>/sync-state.json.updatedAt`
  - M5: kein `isolated deinit` im `ChangeMonitor`
  - M7: Wake-Trigger nicht entprellt (1–2 s). Ein verbundener Stream mit Daten im Idle-Fenster sollte bei Interface-Wechsel nicht neu starten.
- T7:
  - **F1 (Re-Review 2):** eine Pin-Aufgabe wird nach 5 Fehlern verworfen, auch wenn die Fehler transient waren (Timeouts, 5xx). Ihr Re-Report geht dann verloren. Gemildert, weil `item(for:)`, der Change-Feed und Enumerationen später die richtige Policy liefern. Vorschlag: nur nicht-transiente Fehler zählen, oder `failures` nach einer erfolgreichen Runde zurücksetzen.
  - Nit: `setAppliedPins` läuft auch, wenn `queue.flush()` fehlschlägt (nur geloggt). `flush` könnte `Bool` liefern, damit der Bereich unangewendet bleibt und in der nächsten Runde wiederholt wird.
  - Nit: der Doc-Kommentar von `drain` sagt noch, Fehler ließen die Kopfaufgabe für die nächste Runde stehen; tatsächlich rotieren sie jetzt.
  - Nit: wird eine korrupte Queue zuerst außerhalb des Working-Sets geladen, wird keine Runde angefordert. Der Re-Walk wartet dann auf die nächste natürliche Working-Set-Runde.
  - Nit (übernommen): gestapelte Ganz-Bereich-Walks bei schnellem Umschalten; `enqueue` ist O(n).
  - M5 (übersprungen): Darwin-Callback während `deinit`, abgesichert durch Main-Thread-Zustellung.
  - M7 (übersprungen): ein kalter Cache kann zusätzliche `GET /items/:id`-Hops für Einzel-Item-Antworten kosten.
- T8 (Re-Review):
  - der Negativ-Cache ist nicht hart begrenzt (Pruning erst ab 10.000 Einträgen, O(n) pro Aufruf darüber)
  - seltener ETag/Daten-Mismatch bei parallelen `store` verschiedener Versionen (xattr getrennt von der atomaren Datei)
  - der Ablauf-Timer von `ProblemsModel` wird beim Teardown nicht explizit abgebrochen
  - ein wohl unerreichbarer `catch .notFound`-Zweig im Thumbnail-Fetcher
- T8 M4 (erledigt im T8-Re-Review, hier nur vermerkt): `message` wird in der Sprache der Extension gespeichert; die App lokalisiert neu aus `code`, der gespeicherte Text ist nur Fallback für unbekannte Codes.
- T10 Minor 1: der tus-Test „captures the previous content as a version“ prüft nur den Spy, nicht die Versionszeile.
- T10 Minor 4: `validateMeta` wiederholt beim Publish die ungesperrte Vorprüfung (harmlos, liefert früh 412/404).
- T9: die Menüzeile „Offline-Inhalte“ zeigt „noch nicht gemessen“, bis ein Offline-Walk gelaufen ist. Seit der Final-Fixwelle stellt der App-Start die Größen des letzten Walks wieder her (`offline-walk.json`); nur vor dem allerersten Walk fehlt die Zahl.

## Final-Review (c8bd62c..7bd5a29): offen bzw. Restrisiko nach der Fixwelle
- **M5 – Löschen ohne `If-Match` (nicht umgesetzt, Vertrag):** `DELETE /items/:id` kennt laut SYNC_API.md §8.3 kein `If-Match`. Ein lokales Löschen entfernt daher auch eine neuere Server-Version, die dieser Mac noch nicht kennt, und ein rekursives Ordner-Löschen auch zwischenzeitlich remote hinzugefügte Kinder. Beides liegt im Server-Papierkorb. Für eine echte Lösung braucht der Vertrag ein additives `If-Match` auf `DELETE` (Datei: Content-ETag; Ordner: offen, z. B. nur leer-oder-unverändert). Im Code dokumentiert (`SyncletReplicatedExtension.delete`).
- **I2 – Zeitpunkt:** die App hebt `.serverUnreachable`/`.insufficientQuota` bei jedem neuen SSE-`hello` und nach jedem erfolgreichen periodischen `/account`-Refresh auf. Wird der Server-Speicher frei, während der Stream verbunden bleibt, kann das bis zu 15 min dauern, falls macOS nicht von selbst erneut versucht (Checkliste Schritt 30 misst es). `.tooLarge` (413) mappt weiter auf `.insufficientQuota` und wird dabei mit aufgehoben: ein erneuter Versuch endet wieder mit 413 (der Problem-Eintrag wird ersetzt, nicht verdoppelt).
- **M2 – Rest:** die Vorschaubilder eines abgemeldeten Kontos löscht die Extension beim nächsten Start ihres Prozesses (die App erreicht deren Caches nicht). Meldet sich das letzte Konto ab, bleiben sie bis zur nächsten Anmeldung bzw. LRU-Verdrängung liegen.
- **M3 – Rest:** ein 401 einer Operation, die vor dem Speichern des neuen Tokens begann, aber das neue Token schon las, wird einmal ignoriert (wird beim nächsten Fehler gemeldet). Toleranz 1 ms wegen der Millisekunden im Marker.
- **M6 – Rest:** ohne Pins und oberhalb von 50.000 Ordnern wird die Parent-Map geleert. Ein Ordner, den die Map danach nicht kennt und der remote in einen Pin verschoben wird, löst keinen Re-Walk seines Teilbaums aus (seine schon gemeldeten Kinder behalten `.inherited`, bis sie erneut gemeldet werden). Vorher galt das nur für nie gesehene Ordner.
- **M7 – Rest:** der Launch-Walk entfällt nur, wenn die Pins dem letzten abgeschlossenen Walk entsprechen. Von macOS doch verdrängte gepinnte Dateien (sollte mit `keepDownloaded` nicht passieren) werden dann erst beim nächsten Walk (Umschalten, Offline-Tab) erneut angefordert.
