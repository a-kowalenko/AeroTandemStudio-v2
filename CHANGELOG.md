# Changelog

Nutzer-sichtbare Release Notes (Update-Dialog & GitHub Release).

Schreibregeln & Struktur: `docs/RELEASE.md` → Abschnitt **Release-Notes**.
Neue Einträge unter **`[Unreleased]`**; `npm run release` versioniert sie.
Patch ohne Unreleased-Text: Notes der Vorgängerversion werden übernommen.

## [Unreleased]

### Neu

- Vor „Vorgang erstellen“ Hinweis, wenn der Ausgabeordner schon Dateien enthält — mit Option, den Ordner zu ersetzen und neu zu erstellen

### Verbessert

- Beim erneuten Erstellen landen keine alten Fotos oder Videos mehr still mit im Upload

## [0.3.7] - 2026-08-25

### Neu

- Optional Beta-Updates in den Einstellungen: Vorabversionen beim Start und bei „Nach Updates suchen“ einbeziehen

### Verbessert

- Update-Dialog kennzeichnet Beta-Versionen und warnt vor möglichen Fehlern
- Fotos-Tab: Übersicht und Detailpanel auf breiten Bildschirmen besser aufeinander abgestimmt — die Miniatur-Ansicht nutzt die volle Höhe neben den Details

## [0.3.6] - 2026-08-25

### Verbessert

- Upload zum Server schneller bei vielen Fotos (mehrere Dateien gleichzeitig)
- Fortschritt beim Upload zeigt übertragene Datenmenge und Geschwindigkeit statt Dateinamen
- Abgebrochene Uploads werden zuverlässiger erkannt und in der Historie korrekt angezeigt

## [0.3.5] - 2026-08-25

### Neu

- Server-Profile in den Einstellungen: mehrere Upload-Ziele speichern und per Klick umschalten
- Vor „Vorgang erstellen“ Hinweis, wenn ungewöhnlich wenig Videos oder Fotos für das gebuchte Produkt importiert sind

### Geändert

- Optionaler mpv-Player entfernt — Vorschau und Cutter nutzen wieder nur HTML5 (kleineres Bundle, flüssigeres Playback)
- Statuszeile: „Überwachung“ heißt jetzt „SD-Überwachung“

### Verbessert

- Buchungssuche zeigt den verbundenen Dienstnamen in Status und Tooltip
- Abgebrochene Uploads in der Historie werden korrekt als abgeschlossen erkannt

### Behoben

- Hinweise und „Vorgang erstellen“-Bereitschaft springen beim Wechsel des Eingabemodus nicht mehr falsch

## [0.3.4] - 2026-08-24

### Neu

- Optional mpv-Player für den Zuschnitt: flüssigeres Spulen und Springen (Video-Einstellungen; ohne mpv bleibt HTML5)
- Fortschritt beim „Vorgang erstellen“ als Schritt-Leiste (Ordner, Video, Fotos, Upload …)

### Verbessert

- Vorschaubilder der Clips in der Videoliste laden schneller und ruhiger
- QR-Erkennung bei Actioncam-Aufnahmen zuverlässiger (unscharfe Frames überspringen, schwierige Fälle gründlicher prüfen)
- Server- und Upload-Status in Kopfzeile und Abschluss klarer
- Große Foto-Imports sortieren schneller
- Mayo in der Standard-Crew als Tandemmaster und Videospringer

### Behoben

- Stabilere Anzeige und Übergabe beim Upload bzw. Abschluss nach dem Erstellen

## [0.3.2] - 2026-08-22

### Verbessert

- Beim manuellen Eintrag per Kunden- und Booking-ID: klarere Hinweise, wann noch etwas fehlt
- Der „Vorgang erstellen“-Button und die Hinweise erscheinen erst, wenn die IDs vollständig sind

### Behoben

- Kunden-ID und Booking-ID müssen im ID-Modus ausgefüllt sein (mindestens 4 Ziffern)
- Weniger verwirrende Meldungen während der automatischen Kundendaten-Ladung

## [0.3.1] - 2026-08-21

### Verbessert

- Fotos importieren läuft ruhiger und zeigt, was gerade passiert
- Viele Fotos auf einmal gehen schneller
- Medien auf demselben Laufwerk landen schneller im Arbeitsordner
- Leeren und Zurücksetzen: kurze Rückmeldung, die App bleibt bedienbar
- Beim Start siehst du, wenn der Cache bereinigt wird
- In der Log-Konsole bleibt deine Log-Stufe gespeichert
- Update-Hinweise sind übersichtlicher lesbar

### Behoben

- Der Fortschrittsbalken bleibt beim Wechsel der Schritte nicht mehr „hängen“

## [0.3.0] - 2026-08-20

### Neu

- USB-Action-Cams (z. B. GoPro / DJI / Insta360): Medien per Kabel importieren (Windows & Mac)
- Aus der Historie fehlende Dateien nachreichen (mit Kategorie und Vorschau)
- Kunden per Buchungs-/Kunden-ID laden — Name und Medien wie nach QR-Scan
- App-Sprache wählbar: Deutsch, English, Español (México)
- Video-Einstellungen: Profil wählen und Bestätigung vor erneutem Kodieren
- Fotos: Übersicht und große Detailansicht nebeneinander

### Schneller & flüssiger

- Import, Vorschaubilder und Video-Vorschau spürbar schneller
- Weniger unnötiges Neuberechnen, wenn schon eine passende Vorschau da ist
- Beim Foto-Import zuerst QR-Erkennung, danach Vorschaubilder

### Hinweis

- USB-Kameras unter Linux folgen in einem späteren Update
