# Phase 4 – Follow-ups (Spaces: Team-Ordner, externe Speicher, Gruppen)

Stand: 2026-10-16, Branch phase-4 (T1–T10 und die abschließende Fix-Welle). Spec: `docs/superpowers/specs/2026-10-16-phase-4-spaces-design.md`.

## Rulings (Entscheidungen während der Umsetzung)
- R0: parallele Implementierer in eigenen Worktrees pro Welle (`Synclet-wt/4-tN`) — Kosten: Merge-Konflikte (vom Controller aufgelöst)
- P1: T3 exportiert `apiSpaceId(space, user)` und `spaceIdFromApi(user, apiId)` (`apps/server/src/spaces/space-ids.ts`); T4/T5 müssen sie nutzen — vermeidet abweichende Abbildungen `personal`/uuid — Kosten: keine
- P2: „missing“ = Wurzel ist kein Verzeichnis ODER Wurzel leer, obwohl der Space lebende Items hat (Teams und extern); für Teams zusätzlich: ist `/teams` selbst leer, während ein Team-Space Items hat, sind alle Team-Spaces missing — einfach und sicher (löscht nie) — Kosten: ein absichtlich geleerter Space gilt als „nicht verfügbar“, bis wieder eine Datei darin liegt; Admin kann entfernen und wieder aufnehmen
- R-par: T6, T7, T8 starteten parallel zu T2, gegen die API-Formen aus dem Plan mit Mocks (nur Unit-Tests); die zurückgestellten Playwright- und Live-Schritte liefen vor dem Merge in den Branches (macOS live, iOS live und Playwright grün) — Kosten, falls falsch: Nacharbeit (die Formen waren im Plan fixiert)
- R-early: T4/T5 starteten vom T3-Stand (cb5e939), während T3 noch im Review war — Kosten: Rebase auf die T3-Fixrunde; die Integration von T4+T5 war ein eigener Merge (1a3cc37, `openapi.yaml`-Konflikt)
- R2a: „Entfernen“ eines Space setzt den Status `ignored` (neuer Enum-Wert, neue Migration), für Team und extern; die Erkennung legt ignorierte Spaces nie neu an, `restoreSpace(id)` holt sie ohne Mitglieder zurück — löst den Spec-Widerspruch (jeder `/teams`-Unterordner ist ein Space vs. „Entfernen“) — Kosten: T5 stellt `DELETE` und eine Restore-Route bereit, T7 zeigt ausgeblendete Spaces mit „Wieder aufnehmen“
- R6a: Leseberechtigte bekommen Office im Ansichtsmodus (Plan T4); das Web nennt die Aktion „In Office ansehen“ statt sie zu verstecken — Kosten: keine
- R6b: `SyncSpace` bekommt additiv `status?: 'available'|'missing'` in `/account` — Spec §4 verlangt einen dauerhaften „missing“-Hinweis — Kosten: ein zusätzliches Feld
- R7a: `POST /api/admin/spaces` nimmt `{name, members?}` und legt atomar an — verhindert halb angelegte Team-Ordner (POST+PATCH) — Kosten: kleine Erweiterung in T5
- R9a: Das iPhone zeigt die Space-Liste nur, wenn das Konto Spaces außer `personal` hat, sonst öffnet es „Meine Dateien“ direkt (wie vorher) — spart Einzel-Space-Nutzern eine Ebene — Kosten: keine
- R-inode: Docker Desktop (virtiofs, macOS) vergibt nach einem Rename-over eine neue Inode-Nummer für eine unveränderte Datei; das galt als Host-Speicherung (Version + 1, falsches 412 beim nächsten Ersetzen). Ergebnis: Vor dem gesperrten Schreiben wird bei reiner Inode-Änderung (Größe und mtime gleich, `contentHash` vorhanden) die Datei gehasht; bei gleichem Inhalt werden nur `ino`/`dev` aufgefrischt (keine Version, kein Journal). Ohne Hash bleibt die vorsichtige neue Version. Die drei Conformance-Fehler unter `scripts/e2e-fresh.sh` sind damit behoben — Kosten: ein Hash pro reiner Inode-Änderung
- R10a: T10 startete mit den Docs und der Wegwerf-Test-Erweiterung, bevor die zurückgestellten Branches (Web/macOS/iOS live) gemergt waren; die komplette End-to-End-Verifikation (alle Suiten, Live-Skripte, Playwright) macht der Controller nach dem Merge — Kosten: keine

## Ergebnis T10
- `deploy/README.md` (Abschnitt „Team-Ordner und externe Speicher“, Anker `#team-ordner-und-externe-speicher`, vom Web-Admin verlinkt), Funktionsliste im `README.md`, Geräte-Checklisten für Spaces in `apps/macos/README.md` (Schritt 31) und `apps/ios/README.md` (Schritt 16).
- `scripts/throwaway-test.sh` ist um `/teams` erweitert (`SYNCLET_TEAMS` im Temp-Ordner): ein vorhandener Team-Ordner wird entdeckt und zugewiesen, ein per Admin-API angelegter Team-Ordner (Datei + Unterordner über die Sync-API), „Entfernen“ lässt den Inhalt liegen. Nach `down -v` enthält `/teams` genau die erwarteten Dateien und keine `.synclet-*`-Reste. Lauf grün (PASS).
- Die übrige Verifikation aus Schritt 2 des Briefs liegt beim Controller (R10a).

## Bekannte Einschränkungen
- **Ein absichtlich geleerter Space** gilt als „nicht verfügbar“ (P2), bis wieder eine Datei darin liegt.
- **Netzwerk-Dateisysteme:** nur Scans, keine Ereignisse; Verschieben von außen wird als Löschen + Neuanlegen gesehen (neue ID); Beobachtung aus und Scan-Intervall pro Space (Minimum 10 s) einstellbar.
- **Verschieben über Dateisystemgrenzen** kopiert (außerhalb der Sperren in eine temporäre Datei, danach kurze Veröffentlichungs-Transaktion mit erneuter Prüfung) und entfernt das Original; sehr große Bäume brauchen Zeit, der gesperrte Schritt wächst mit der Baumgröße (Zeilen-Updates, 60 s Timeout).
- **Verschachtelte Mounts** (ein Mount unterhalb eines Space-Ordners) werden nicht gesondert behandelt.
- **Admins haben keinen impliziten Zugriff** auf fremde Spaces; sie weisen sich selbst zu.
- **Ein entfernter (ausgeblendeter) Space** behält seine Ordner auf der Platte; er hat nach „Wieder aufnehmen“ keine Mitglieder.
- Die Geräte-Checklisten (macOS Schritt 31, iOS Schritt 16) sind manuelle Schritte.

## Offene Kleinigkeiten (deferred, aus den Reviews)
- **Server – Spaces/Index (T1):**
  - Watcher-Fill bei `user.created`, fehlender `rootPath`-Guard und Schlüssel nach Space-Name statt `spaceId` wurden in T2 behoben.
  - Der Test „failed insert“ in `spaces.repo.spec` prüft kein Rollback.
  - `by` ist bei `replaceContent`/`restore` optional; sollte Pflicht sein.
  - Testhelfer dupliziert `createPersonal`.
- **Server – Erkennung (T2):**
  - Die `user.created`-Route kann bei laufendem Refresh verloren gehen.
  - `/teams` wird nur abonniert, wenn es beim Start existiert; fehlgeschlagene Abos werden nicht wiederholt.
  - `createTeam` mit dem Namen eines ignorierten Teams gibt `name_conflict`; die UI sollte das erklären. `restoreSpace` prüft den Namen nicht erneut.
  - Lange Kommentarzeile in `.env.example`.
- **Server – Sync-API/Verschieben (T3):**
  - Ein Absturz während eines Verschiebens zwischen Spaces (zwischen Veröffentlichen/Staging und Commit, selten): Das gestagte Original wird beim Start gelöscht, der Inhalt bleibt nur als neue Items (IDs und Versionsverlauf getrennt).
  - Der erneute Abgleich nach einer SSE-Wiederverbindung vergleicht nur die Space-IDs, nicht Rollen- oder Statusänderungen.
  - Der Snapshot eines Verschiebens über Dateisystemgrenzen enthält die Inode-Nummern: auf virtiofs (Docker Desktop) kann eine Inode-Drift während der Kopie ein unnötiges 409 auslösen (erneut versuchen hilft).
- **Server – Freigaben/Office (T4):**
  - Das Speichern in Office hängt an der Sitzung des Öffners (gemeinsames Bearbeiten).
  - Die Freigabeliste des Eigentümers zeigt nach verlorenem Zugriff den aktuellen Itemnamen.
  - Ungetestet: Admin-Filter `?spaceId=`, 400 bei Ordner/Space-Konflikt, Papierkorb überspringt fehlenden Space.
- **Server – Admin-API (T5):**
  - PATCH-Umbenennen und Mitglieder laufen in getrennten Transaktionen (bei Race teilweise, Benachrichtigung entfällt).
  - Gruppen-Änderungen nehmen keine Space-Sperren.
  - Docs §8.3: `r_`-Wurzeln; `r_`-Wurzel `write:false` gegenüber Personal-Wurzel `write:true` (Asymmetrie).
  - Die E2E-Gruppen-Wartefunktion `until` wartet stumm.
- **Web – Browser (T6):**
  - „Neu“/„Hochladen“ sind beim Laden/Fehlschlag deaktiviert; `useCurrentSpaceId` ist `null`, solange `d_` lädt; „…“ solange das Konto lädt.
  - Der Papierkorb-Test entstand nach dem Fix.
- **Web – Admin (T7):**
  - Namensregel (nachgestelltes Leerzeichen, Dateinamenregeln für Gruppennamen) strenger als nötig.
  - Mount-Hinweis steht global im Footer; `UserDetailPage` mit IIFE, Fehler zeigt „–“; gleiches Icon für Benutzer- und Gruppenzeilen.
  - Ungenutztes `members` im Create-Input-Typ; keine Tests für die Intervall-Validierung im Web.
  - Der Gruppen-Verlauf eines Benutzers wird aus `/admin/groups` abgeleitet.
- **macOS-Client (T8):**
  - Leere-Ordner-Cursor-Race bei der ersten Seite.
  - R6b-Status wird in Apple-Clients nicht gelesen (iOS zeigt „Nicht verfügbar“, macOS über 503-Fehler).
  - Container-Enumeratoren führen ebenfalls Lösch-Prüfungen aus (Kosten); `forgetSpace`-Fehler wird nicht wiederholt, Ledger-Entfernung ungetestet.
  - Veralteter Ein-Space-Zustand überspringt die Löschprüfung (erneuter Download); ein verschobener angehefteter Ordner der ersten Ebene behält die Anheftung im alten PinSet.
- **iOS-Client (T9):**
  - `fetchCursor try?` verschluckt 401/403; `.account`-`onChange` kann von einem folgenden `hello` überholt werden; `hasCursors` redundant.
  - Browser-Änderungsereignisse kommen pro Konto, nicht pro Space; `ForegroundMonitor` vergleicht die Cursor aller Spaces.
  - Keine View-Tests für die Nur-Lesen-UI (deckt der Live-Schritt ab).
  - Die Gleichheit bei Statusänderungen in `updateSpaces` ist ungetestet.
  - Eine `spaceId`, die nicht in `account.spaces` steht, gilt als nur lesbar (alter Server); ein zusätzliches `GET /items/:id` pro Ordner-Laden.
