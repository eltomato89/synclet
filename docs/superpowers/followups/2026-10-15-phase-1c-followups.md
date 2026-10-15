# Phase 1c – Follow-ups (aus den Reviews)

Stand: 2026-10-15, Branch phase-1c.

## Rulings (Entscheidungen während der Umsetzung)
- Ruling: Caddy-Frontproxy + Office-Subdomain als Wave 0 (T12a) vorgezogen (User-Wunsch) — Kosten: keine
- Ruling: parallele Worktrees wie in 1a/1b — Kosten: Merge-Konflikte (app.module.ts, auth.module.ts, Locale-JSON, router.tsx), vom Controller aufgelöst
- Ruling: Office-Callback akzeptiert ein abgelaufenes (aber korrekt signiertes, item-gebundenes) File-Token, wenn das Document-Server-JWT gültig ist und der Key passt; Warnung im Log — verhindert verlorene Edits langer Sessions — Kosten: Replay-Fenster > 7 d (setzt Document-Server-Secret voraus)
- Ruling: strengere SSO-Regeln aus T5 übernommen (Gruppen-Gate bei jedem Login; kein Ordner-Takeover durch neue SSO-User; unverifizierte E-Mails nicht gespeichert; Forward-Auth verknüpft nie per E-Mail; Identitäten pro Issuer) — Kosten: evtl. später manuelles Identity-Linking nötig
- Ruling: Last-Admin-Schutz = ein gemeinsamer UsersService-Helper (FOR UPDATE auf aktive Admins); „letzter Admin“ zählt nur aktive Admins mit lokalem Passwort; dazu CLI `reset-admin-password` — Kosten: ein reiner SSO-Admin kann nicht alleiniger Admin sein
- Ruling: Versionskopie außerhalb des User-Locks vorbereiten, unter dem Lock inode/size/mtime prüfen, neuen Inhalt zuletzt umbenennen; Hardlink nur bei nlink==1 — Kosten: Host-Änderung zwischen Prepare und Commit → ein Retry, dann 409
- Ruling: Forward-Auth-Header-Trust getrennt von X-Forwarded-For-Trust (`SYNCLET_FORWARD_AUTH_PROXIES`, Default leer = Header immer entfernen) — Final-Review C1
- Ruling: früher 413 hinter Caddy über einen Content-Length-Matcher (gleicher `SYNCLET_MAX_UPLOAD_BYTES`), da `request_body max_size` die deklarierte Länge nicht prüft — Kosten: zwei Stellen kennen das Limit
- Ruling: macOS-Docker-Desktop-Inode-Drift (siehe unten) geparkt; Tests wiederholen auf darwin einmal mit Warnung

## Bekannte Einschränkungen
- macOS Docker Desktop (Bind-Mounts): direkt nach einem Server-Replace vergibt das Datei-Sharing für denselben Pfad eine neue Inode-Nummer; ein sofort folgendes Replace/Restore bekommt 412 „file changed on disk“. Linux-FS/Named Volumes nicht betroffen (Contract 86/0). Mögliche Lösung: Inode-Wechsel tolerieren, wenn size+mtime+Hash übereinstimmen.
- Display-Name-Verschiebung jenseits gleicher Key-Geschwister wird nicht journalisiert (nur case-sensitive Hosts) — SYNC_API §4.3.

## Offene Kleinigkeiten (deferred)
- Final M5: Office-Save bereitet die Versionskopie vor dem Konflikt-Check vor (unnötige Vollkopie bei Konflikt)
- Final M6: Office-Document-Key ändert sich nach Forcesave → zweite DS-Session möglich, endet in Konfliktkopie
- T9 S1: Refresh legt neue Session-Zeile an (Login-Zeit geht verloren, Session-ID instabil) — braucht Migration
- Final-Fix: Sessions, die vor der Revoke-Reason-Migration widerrufen wurden, behalten die strenge Reuse-Regel
- Final-Fix: optionale Startwarnung bei zu weiten Forward-Auth-CIDRs nicht umgesetzt
- Task 1: kein abgeleitetes officeEnabled-Flag in allen Consumern; lenientes base64url-Decode
- Task 2: Versionen werden bei abgeschaltetem Feature nicht gepruned; host-gelöschte Dateien verlieren Historie nach Tombstone-Purge; Item-Download-Token öffnet Versionen; recoverRow-Fehler lässt Datei bis zum Stray-Sweep liegen
- Task 4: kein Audit-Eintrag für App-Login; abgelaufene Codes werden lazy gepurged
- Task 5: FOR UPDATE vs FOR NO KEY UPDATE; Lock-Reihenfolge CLI vs Admin-PATCH; Flow-JWT teilt Access-Secret; Link-by-E-Mail kann Admins treffen; kein PATCH-Test für SSO-only-Passwort
- Task 6: PATCH disabled widerruft nur Sessions (Guard blockiert Geräte ohnehin); adopt check-then-create verlässt sich auf Unique-Constraint; officeReachable ohne Single-Flight
- Task 7: blockierter Popup-Tab ohne Feedback; documentServerUrl nicht protokollvalidiert; Doppelklick/Kontextmenü öffnen Office nicht
- Task 8: keine Tests für QuickLook-History-Button/Seiten-Wiring/Ordner canShowVersions; PDF-Fetch nicht abbrechbar
- Task 10: lange App-Login-Rückpfade können das 2000-Zeichen-Limit von safeReturnPath überschreiten; fehlende Tests (Marker-Mismatch, 401-Retry, No-Loop)
- Task 12b: Satz „what must stay behind the gate …“ im README missverständlich
- Task 13: Forward-Auth-E2E einmal knapp am 5-s-Timeout (geteilter Rate-Limit-Bucket)
- Final-Rereview N1: Caddyfile entfernt X-authentik-*-Header nicht standardmäßig (eigene Header-Namen brauchen passende Caddy-Konfiguration, dokumentiert)
- Final-Rereview N2: Office-Save für eine Datei im Papierkorb ist nicht idempotent pro Callback-Key → jeder Forcesave erzeugt eine weitere Konfliktkopie
- Final-Rereview N3: Retry-Fenster für „Datei kurz fehlt“ ist durch die DS-Callback-Retries begrenzt (Watcher aus → Host-Löschung evtl. später indexiert)
- Final-Rereview N4: seltene Races im selben Browser können eine Session-Zeile verwaist lassen
