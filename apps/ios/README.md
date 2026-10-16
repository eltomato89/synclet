# Synclet for iOS and iPadOS

Universal SwiftUI app (iOS/iPadOS 26+) with a File Provider extension (Files app) and a
share extension. The logic shared with the macOS client lives in
[`../apple/SyncletKit`](../apple/SyncletKit).

| Target | Bundle ID |
|---|---|
| `Synclet` (app) | `tech.jensk.synclet.ios` |
| `SyncletFileProvider` | `tech.jensk.synclet.ios.FileProvider` |
| `SyncletShare` | `tech.jensk.synclet.ios.Share` |
| `SyncletTests` / `SyncletUITests` | `tech.jensk.synclet.ios.tests` / `.uitests` |

App group `group.tech.jensk.synclet` (no team prefix on iOS), keychain group
`$(AppIdentifierPrefix)tech.jensk.synclet.shared`, OAuth `client_id=ios`, redirect `synclet://oauth`.

## Project

`Synclet.xcodeproj` is generated from `project.yml` with [XcodeGen](https://github.com/yonaskolb/XcodeGen)
and committed. After every change to `project.yml` (or a merge touching it):

```sh
cd apps/ios && xcodegen generate
```

Never edit the `.pbxproj` by hand.

## Build

```sh
cd apps/ios
xcodebuild build -scheme Synclet -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
```

## Tests

Unit tests (scheme `Synclet`) on a private simulator that is deleted afterwards:

```sh
bash scripts/ios-test.sh                                        # iPhone 18 Pro
IOS_DEVICE="iPad Pro 13-inch (M5)" bash scripts/ios-test.sh     # iPad
```

SyncletKit on the iOS simulator: `bash scripts/swiftkit-test-ios.sh`.

The UI tests have their own scheme (`SyncletUITests`). They run against a throwaway server,
together with the SyncletKit live tests:

```sh
bash scripts/ios-live-tests.sh           # Kit live tests (swift test --filter Live) + UI tests
bash scripts/ios-live-tests.sh --ui      # only the UI tests (--kit: only the Kit live tests)
bash scripts/ios-live-tests.sh --serve   # keep the stack up, print URL + a device token
```

The script starts its own compose project (`synclet-ios-live-<pid>`, free ports), creates the
administrator through the setup API, registers device tokens and removes the stack and its private
simulator on exit. `BrowserFlowUITests` (iPhone layout, German) creates a folder, checks the inline
„Name bereits vergeben“, uploads a file (DEBUG hook `-SyncletTestUpload <path>` behind „Dateien“),
opens it in QuickLook, renames, deletes, restores it from „Papierkorb“, finds it in „Suche“ and
creates a share link.

## Debug sign-in without the browser

Debug builds accept a device token registered beforehand (UI tests, scripted checks):

```
-SyncletTestServer http://localhost:18140 -SyncletTestToken syd_…
```

Both arguments are required. Release builds do not contain this code path.

## App icon

`Synclet/Resources/Assets.xcassets/AppIcon.appiconset/icon_1024.png` (single size, opaque) is
rendered from the macOS icon: `cd apps/ios && swift render-app-icon.swift`.

## Archive (App Store Connect / TestFlight)

```sh
cd apps/ios && ./build_archive.sh
```

`xcodegen generate`, `xcodebuild archive` (Release, `generic/platform=iOS`,
`-allowProvisioningUpdates`) and the export with `ExportOptions.plist` (method `app-store-connect`,
team `JC32M95WLZ`) into `build/export`. The script needs an „Apple Distribution“ certificate of the
team in the keychain and otherwise stops with exit code 2 („Kein Apple-Distribution-Zertifikat –
in Xcode → Settings → Accounts anlegen“). Uploading the build is done by hand (Organizer or Transporter).

## Geräte-Checkliste (manuell)

Dateien-App, Share-Extension, Hintergrund-Uploads und mehrere Konten lassen sich in dieser Umgebung
nicht automatisch testen. Voraussetzungen: ein iPhone oder iPad mit iOS/iPadOS 26, ein vom Gerät
erreichbarer Server (eigener Server oder `bash scripts/ios-live-tests.sh --serve` hinter einer
LAN-Adresse) mit zwei Benutzerkonten, die Web-Oberfläche im Browser eines Rechners.

1. **Installieren:** Gerät anschließen, in Xcode das Schema `Synclet` mit dem Gerät als Ziel ausführen
   (Team JC32M95WLZ, automatische Signierung).
   → Die App startet und zeigt „Konto hinzufügen“.
2. **Anmelden, zwei Konten:** Server-Adresse eingeben, im Browser-Fenster mit Konto A anmelden; danach
   über das Kontomenü → „Konten verwalten …“ → „Konto hinzufügen“ Konto B.
   → Beide Konten stehen in „Konten“; „Meine Dateien“ zeigt die Dateien des gewählten Kontos, der
   Kontowechsel oben links wechselt den Inhalt.
3. **Dateien-App:** Dateien-App öffnen → „Durchsuchen“ → „Speicherorte“.
   → Zwei Synclet-Orte (je Konto einer, mit Kontonamen); jeder enthält „Meine Dateien“ mit dem
   Inhalt aus dem Web.
4. **Datei öffnen in Dateien:** in einem Synclet-Ort eine PDF oder ein Bild antippen.
   → Die Datei lädt (Fortschritt) und öffnet sich in der Vorschau.
5. **In anderer App bearbeiten:** ein Bild in Dateien mit „Markup“ bemalen und sichern (oder ein
   Pages-/Numbers-Dokument öffnen, ändern, schließen).
   → Nach wenigen Sekunden zeigt das Web die neue Fassung (Änderungsdatum, Version + 1).
6. **Konfliktkopie:** Gerät in den Flugmodus, dieselbe Datei auf dem Gerät (Dateien-App) ändern; im Web
   dieselbe Datei ändern; Flugmodus aus.
   → Beide Fassungen bleiben erhalten: eine heißt „<Name> (Konflikt <Gerät> <Datum>)“, im Web und in
   der App sichtbar.
7. **Vordergrund-Aktualisierung:** App im Vordergrund auf einem Ordner; im Web dort eine Datei
   anlegen, umbenennen, löschen.
   → Die Liste in der App folgt innerhalb weniger Sekunden ohne Ziehen zum Aktualisieren.
8. **Hintergrund:** App in den Hintergrund; im Web eine Datei ändern; danach die Dateien-App öffnen
   und den Ordner ansehen.
   → Die Dateien-App zeigt die Änderung beim Öffnen (spätestens nach Ziehen zum Aktualisieren).
9. **Share-Extension aus Fotos:** in Fotos 3 Fotos auswählen → Teilen → „Synclet“ → Konto und Ordner
   wählen → „Hochladen“.
   → Die drei Fotos kommen im gewählten Ordner an (Web und App); „Uploads“ zeigt sie als
   „Hochgeladen“.
10. **Share-Extension aus Safari:** in Safari eine PDF öffnen → Teilen → „Synclet“ → Ordner wählen.
    → Die PDF liegt im gewählten Ordner.
11. **Upload bei gesperrtem Gerät:** in der App „+“ → „Fotos“ → ein Video von ca. 200 MB wählen, sofort
    das Gerät sperren, einige Minuten warten.
    → Nach dem Entsperren steht der Upload in „Uploads“ auf „Hochgeladen“ (oder läuft weiter und
    schließt ab); die Datei ist im Web vollständig (gleiche Größe, abspielbar), ohne Duplikat.
12. **Speicher voll (507):** Kontingent des Kontos bzw. den Server-Datenträger füllen (z. B.
    `SYNCLET_MACLIVE_DATA_DIR` auf einem kleinen Disk-Image wie beim Mac), dann eine größere Datei
    hochladen.
    → „Uploads“ zeigt „Speicher voll“ mit „Erneut versuchen“; nach dem Freigeben von Platz und
    „Erneut versuchen“ läuft der Upload weiter und schließt ab.
13. **Gerät widerrufen:** im Web in der Geräteliste das Gerät von Konto A widerrufen.
    → Die App zeigt für Konto A „Neu anmelden“; die Dateien-App meldet für den Ort von Konto A, dass
    eine Anmeldung nötig ist. „Neu anmelden“ führt zum Browser-Login und danach geht alles wieder.
14. **Abmelden:** unter „Konten verwalten …“ Konto B abmelden.
    → Der Synclet-Ort von Konto B verschwindet aus der Dateien-App; seine Uploads verschwinden aus
    „Uploads“. Zuvor geöffnete Dateien und Vorschaubilder sind vom Gerät gelöscht (Einstellungen →
    Cache-Größe 0 bzw. Vorschaubilder laden beim nächsten Öffnen neu).
15. **iPad:** die Schritte 2–7 auf einem iPad; zusätzlich Split View mit einer zweiten App und Drehen.
    → Seitenleiste mit Konten und „Meine Dateien“/„Zuletzt“/„Suche“/„Papierkorb“/„Uploads“, Inhalt
    rechts; das Layout bleibt in Split View und beim Drehen bedienbar (schmale Breite: Tab-Leiste wie
    auf dem iPhone). Drag & Drop aus der Dateien-App in die App gehört nicht zum Umfang (nicht prüfen).
16. **Share-Extension offline, App viel später:** Flugmodus an; in Fotos 3 Fotos → Teilen → „Synclet“ →
    „Hochladen“. Mehr als 10 Minuten warten, dann die App öffnen (Flugmodus noch an), danach den
    Flugmodus ausschalten und warten, bis „Uploads“ alle drei als „Hochgeladen“ zeigt.
    → Im Zielordner liegt jedes Foto genau einmal (kein „IMG_… (2).heic“).
17. **Share-Upload aus der App abbrechen:** Flugmodus an; in Fotos ein Foto → Teilen → „Synclet“ →
    „Hochladen“. App öffnen → „Uploads“ → beim Foto „Abbrechen“. Flugmodus aus, eine Minute warten.
    → Der Eintrag ist weg, und die Datei erscheint nicht im Zielordner (Web und App).
