# ADR 0002: Das Dateisystem ist die Source of Truth

- Status: akzeptiert (2026-10-15)

## Kontext
Nutzer sollen Synclet auf einen bestehenden Ordner richten und den Container jederzeit wegwerfen können. Was Web und Apps anzeigen, muss 1:1 auf der Platte liegen.

## Entscheidung
- Der Datenordner (`/data/<username>/`) enthält ausschließlich Nutzerdateien – keine Metadateien, keine xattrs, keine versteckten Ordner. Einzige Ausnahme sind kurzlebige Temp-Dateien `.<name>.synclet-<id>` während eines atomaren Schreibvorgangs; sie werden ignoriert und beim Start aufgeräumt.
- Alle Metadaten (Item-Index, Journal, Thumbnails, Papierkorb, Versionen, Suchindex) liegen in PostgreSQL bzw. im Volume `/meta`.
- Der Server erkennt externe Änderungen per Watcher (`@parcel/watcher`, best effort) und periodischem Reconcile-Scan.
- Stabile Item-IDs: Pfad-Match vor Inode-Match vor delete+create.

## Konsequenzen
- Externe Löschungen können nicht in den Papierkorb, externe Edits nicht versioniert werden.
- Auf Netzwerk-Dateisystemen mit instabilen Inodes degradieren externe Moves zu delete+create.
- Ohne optionalen Same-FS-Modus kosten Papierkorb und Versionen eine Kopie (EXDEV).
