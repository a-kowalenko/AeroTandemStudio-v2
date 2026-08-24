# Changelog

Nutzer-sichtbare Release Notes (Update-Dialog & GitHub Release).

Schreibregeln & Struktur: `docs/RELEASE.md` → Abschnitt **Release-Notes**.
Neue Einträge unter **`[Unreleased]`**; `npm run release` versioniert sie.
Patch ohne Unreleased-Text: Notes der Vorgängerversion werden übernommen.

## [Unreleased]

## [0.3.3] - 2026-08-24

### Verbessert

- Beim manuellen Eintrag per Kunden- und Booking-ID: klarere Hinweise, wann noch etwas fehlt
- Der „Vorgang erstellen“-Button und die Hinweise erscheinen erst, wenn die IDs vollständig sind

### Behoben

- Kunden-ID und Booking-ID müssen im ID-Modus ausgefüllt sein (mindestens 4 Ziffern)
- Weniger verwirrende Meldungen während der automatischen Kundendaten-Ladung

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
