# Deployment

Quickstart, configuration and the other server topics are in the [top-level README](../README.md). This page covers what depends on your storage layout.

## Team-Ordner und externe Speicher

Neben dem persönlichen Ordner jedes Benutzers (`SYNCLET_DATA/<benutzername>`) kennt Synclet **Spaces**: gemeinsame Team-Ordner und externe Speicher (NAS, andere Platten). Ein Space ist ein Wurzelordner auf der Platte; wer Zugriff hat, sieht ihn als eigenen Bereich in Web und Apps. Synclet schreibt in einen Space dasselbe wie in einen persönlichen Ordner: nur die sichtbare Struktur, keine Metadaten.

### Team-Ordner: das Volume `SYNCLET_TEAMS`

Jeder direkte Unterordner von `/teams` ist ein Team-Ordner. `SYNCLET_TEAMS` (Standard `./teams`, im Repository `deploy/teams/` mit einer getrackten `.gitkeep`) wird nach `/teams` eingehängt, im Worker schreibgeschützt.

- Der Ordner muss **vor dem ersten Start existieren** und für `PUID:PGID` schreibbar sein. Legt Docker ihn selbst an, gehört er `root`, und das Anlegen von Team-Ordnern schlägt fehl.
- Team-Ordner entstehen im Admin-Bereich (Ordner/Spaces) oder indem Sie einen Ordner direkt in `SYNCLET_TEAMS` anlegen; Synclet findet ihn beim nächsten Scan.
- Ein neuer oder gefundener Space ist für **niemanden** sichtbar, bis ein Admin Mitglieder (Benutzer oder Gruppen, je mit Rolle „lesen“ oder „schreiben“) zuweist. Ohne Zuweisung gibt es keinen Zugriff, auch nicht für Admins; sie können sich selbst zuweisen.
- **Gruppen** fassen Benutzer zusammen (Admin-Bereich → Gruppen). Ein Space kann Gruppen als Mitglieder haben; wer in mehreren Einträgen vorkommt, bekommt die höchste Rolle.

### Externe Speicher: `/storage/<name>`

Jeder Ordner, der unter `/storage` eingehängt ist, wird ein Space; der Name ist der Ordnername. Hängen Sie denselben Pfad in `server` (lesend/schreibend) und `worker` (mit `:ro`) ein. `deploy/compose.yml` enthält die Beispiele auskommentiert:

```yaml
services:
  server:
    volumes:
      # Host-Ordner (Bind-Mount):
      - /mnt/archive:/storage/Archiv
      # Netzwerkfreigabe (benanntes CIFS-Volume, siehe unten):
      - nas-fotos:/storage/Fotos
  worker:
    volumes:
      - /mnt/archive:/storage/Archiv:ro
      - nas-fotos:/storage/Fotos:ro

volumes:
  # SMB/CIFS auf einem NAS, von Docker auf dem Host eingehängt:
  nas-fotos:
    driver: local
    driver_opts:
      type: cifs
      device: //nas/share
      o: "username=…,password=…,uid=${PUID},gid=${PGID},file_mode=0664,dir_mode=0775"
  # NFS entsprechend:
  # nas-archiv:
  #   driver: local
  #   driver_opts:
  #     type: nfs
  #     o: "addr=nas,rw,nfsvers=4"
  #     device: ":/export/archiv"
```

### Rechte: PUID/PGID

Server und Worker laufen als `PUID:PGID`. Dieser Benutzer muss in jedem Space lesen, bei schreibbaren Spaces auch schreiben dürfen.

- Bind-Mounts und NFS: Eigentümer und Modus des Quellordners müssen zu `PUID:PGID` passen (`chown`/`chmod` auf dem Host bzw. NAS-Export mit passender Zuordnung).
- CIFS kennt keine Unix-Rechte pro Datei. Setzen Sie `uid=${PUID},gid=${PGID}` (und `file_mode`/`dir_mode`) in den Mount-Optionen, sonst gehören alle Dateien `root` und Synclet kann nicht schreiben.

### Schreibgeschützt einhängen

Hängen Sie einen Speicher mit `:ro` (oder als read-only-Share) auch im `server` ein, wird der Space **schreibgeschützt**: Alle Mitglieder haben nur Leserechte, Schreiben wird abgelehnt (Web, Finder und Dateien-App). Das erkennt Synclet an einem Schreibtest (`access(W_OK)`) im Wurzelordner; Änderungen am Mount gelten nach dem nächsten Scan des Space.

### Fehlender Mount: „Nicht verfügbar“

Ist der Wurzelordner eines Spaces nicht erreichbar (NAS aus, Mount fehlt, Ordner leer, obwohl Synclet dort Dateien kennt), markiert Synclet den Space als **„Nicht verfügbar“**. **Es wird nichts gelöscht**: weder Dateien noch der Index, und Clients erhalten keine Löschungen. Inhalte antworten mit 503, Apps und Web zeigen den Hinweis. Sobald der Mount wieder da ist, wird der Space beim nächsten Scan wieder verfügbar.

Folgen: Ein Space, den Sie absichtlich leeren, gilt so lange als „nicht verfügbar“, bis wieder eine Datei darin liegt (oder Sie ihn entfernen und wieder aufnehmen). Das ist Absicht und schützt vor versehentlichem Massenlöschen durch einen leeren Mount.

### Netzwerk-Dateisysteme (NFS/SMB)

- Änderungen von außen kommen zuverlässig nur über **Scans**, nicht über Dateisystem-Ereignisse. Stellen Sie pro Space im Admin-Bereich **Beobachtung: aus** und ein **Scan-Intervall** ein (Standard: alle 2 Minuten bzw. `SYNCLET_SCAN_INTERVAL`). Der Knopf „Jetzt scannen“ stößt einen Scan an.
- Inode-Nummern sind oft nicht stabil. **Verschieben von außen wird daher als Löschen + Neuanlegen erkannt**, das Item bekommt eine neue ID und Clients laden es erneut. Verschieben über Synclet (Web, Apps) behält die ID, auch zwischen Spaces desselben Dateisystems; zwischen verschiedenen Dateisystemen wird kopiert und das Original danach entfernt.
- Der Start prüft jeden externen Speicher auf liegengebliebene Synclet-Reste; das kann auf einer langsamen Freigabe etwas dauern.

### Entfernen heißt Ausblenden

„Entfernen“ im Admin-Bereich löscht **nichts**: Der Ordner bleibt auf der Platte, der Space verschwindet für alle Mitglieder und wird nicht wieder automatisch entdeckt. In der Liste der ausgeblendeten Spaces bringt **„Wieder aufnehmen“** ihn zurück (ohne Mitglieder; diese müssen neu zugewiesen werden). Wirklich löschen Sie einen Team-Ordner, indem Sie ihn auf dem Host entfernen.

### Backup und Verlassen

Team-Ordner und externe Speicher sind normale Ordner; Sie sichern sie wie `SYNCLET_DATA`. Die Metadaten (Papierkorb, Versionen, Vorschauen) liegen weiter in `SYNCLET_META`.
