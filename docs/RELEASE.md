# Releases & Auto-Update

Source: privates Repo `a-kowalenko/AeroTandemStudio-v2`  
Binaries: öffentliches Repo [`a-kowalenko/aero-tandem-studio-releases`](https://github.com/a-kowalenko/aero-tandem-studio-releases)

Updater-Endpoint:

```text
https://github.com/a-kowalenko/aero-tandem-studio-releases/releases/latest/download/latest.json
```

Die App zeigt beim Update die **GitHub Release Body** (nicht die Notes in `latest.json`).
Quelle der Body: Abschnitt in `CHANGELOG.md` zur Version.

## Secrets (privates Repo)

| Secret | Pflicht |
|--------|---------|
| `RELEASES_GITHUB_TOKEN` | ja — PAT, Contents R/W auf Releases-Repo |
| `TAURI_SIGNING_PRIVATE_KEY` | ja |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | ja (Key ist verschlüsselt) |
| Apple / Windows Authenticode | nein (optional, kostet) |

## Release-Notes (`CHANGELOG.md`)

Zielgruppe: **Operator an Dropzone/PC** — derselbe Text landet im Update-Dialog und als GitHub-Release-Body.

### Ablauf

1. Nutzer-sichtbare Punkte unter **`## [Unreleased]`** eintragen (Bullet-Listen) — empfohlen bei jeder sichtbaren Änderung.
2. `npm run release` zeigt die Notes, legt `## [x.y.z] - Datum` an und committed `CHANGELOG.md` mit.
   - **`[Unreleased]` befüllt** → diese Notes werden für die neue Version verwendet.
   - **`patch` und `[Unreleased]` leer** → Notes der **aktuellen** Version (z. B. 0.3.0 → 0.3.1) werden übernommen.
   - **`minor` / `major` und leer** → Abbruch; eigene Notes unter Unreleased nötig.
3. Workflow `release.yml` liest den Abschnitt zur Tag-Version und setzt ihn als Body im öffentlichen Releases-Repo (auch bei erneutem Lauf: Body wird aktualisiert). Fehlt der Abschnitt am Tag, lädt CI `CHANGELOG.md` vom Default-Branch; `extract` kann bei Patch-Lücken auf die vorherige Same-Minor-Version zurückfallen.

Hilfsskript:

```bash
node scripts/changelog.mjs extract 0.3.0   # Preview der Notes für CI/Updater
```

Bereits veröffentlichtes Release nachträglich aktualisieren: Workflow **release** → *Run workflow* mit Tag (z. B. `v0.3.0`), nachdem `CHANGELOG.md` auf `master` liegt — oder Body im öffentlichen Releases-Repo manuell setzen.

### Struktur

```markdown
## [Unreleased]

### Neu
- …

### Verbessert
- …

### Behoben
- …

### Hinweis
- …   # optional, z. B. bekannte Einschränkungen
```

- Überschriften nur bei Bedarf; leere Abschnitte weglassen.
- Pro Bullet **ein** Nutzen in Alltagssprache (nicht Phasennummern, nicht Ticket-IDs).
- Länge: eher 5–12 Bullets pro Release; Details gehören in `docs/`, nicht in den Update-Dialog.

### Schreibstil (Pflicht)

| Ja | Nein |
|----|------|
| Begriffe wie in der UI (Historie, Nachreichen, Fotos, Einstellungen) | Interne Kürzel: AMS, MTP, WPD, ICA, OPT-*, Phase 24, … |
| Was der Nutzer merkt („Kunden per ID laden“) | Wie es technisch läuft („Lookup-Bridge“, „Stream-Copy“) |
| Plattform nur wenn nötig („Windows & Mac“) | Entwickler-Stack („libmtp“, „react-i18next“) |

„AMS“ und ähnliche Systeme **nicht** nennen — aus Nutzersicht ist es die Buchungs-/Kundensuche bzw. die Übergabe an den bestehenden Upload-Workflow.

## Neuen Release erstellen (empfohlen)

Voraussetzung: **sauberer** Working Tree auf `master`/`main`, synchron mit `origin`.  
Bei **minor/major**: befülltes `[Unreleased]`. Bei **patch** optional (sonst Notes der Vorgängerversion).

### IDE (Play)

Run Configuration **Release** (`.run/Release.run.xml`) → Play.  
Im Terminal: `patch` / `minor` / `major` wählen, mit `y` bestätigen.

Das Skript setzt die Version, promoted den Changelog, committed `release: x.y.z`, taggt `vx.y.z` und pusht Branch + Tag.

### Terminal

```powershell
npm run release
```

Danach: Actions → Workflow **release** (Win + **zwei** Mac-Jobs + Ubuntu AppImage, oft 15–40+ Min. pro Job); öffentliches Repo → [Releases](https://github.com/a-kowalenko/aero-tandem-studio-releases/releases).

Neue Releases bekommen **kein** „Latest“-Label. Nach Prüfung der Assets im öffentlichen Repo manuell auf **Set as the latest release** setzen — erst dann greifen Installer-Links und Auto-Update (`/releases/latest/`).

Normale Commits auf `master` starten **keinen** App-Build. Volle Bundles nur bei Version-Tags (`release.yml`). PRs: leichter Check in `test.yml`.

## Installer-Links (immer neueste Version)

Nach manuellem Setzen von **Latest**:

- Releases-Übersicht: `https://github.com/a-kowalenko/aero-tandem-studio-releases/releases/latest`
- Konkrete Asset-URLs: `…/releases/latest/download/<asset-name>`

macOS erscheint als **zwei** DMGs (Tauri-Namensschema):

| Mac | Asset (Beispiel) |
|-----|------------------|
| Apple Silicon (M1+) | `…_aarch64.dmg` |
| Intel | `…_x64.dmg` |

„Dieses Programm wird auf diesem Mac nicht unterstützt“ = meist falsche Architektur (Intel braucht `_x64.dmg`).

Linux: **AppImage** (`…_amd64.AppImage` o. ä.) — Details: `docs/LINUX_BUILD.md`.

## Hinweise

- Das öffentliche Releases-Repo braucht **mindestens einen Commit** auf dem Default-Branch (z. B. README). Sonst schlägt das Anlegen von Tags/Releases fehl.
- macOS-Builds sind ohne Apple Developer Account **nicht** notarisiert (Gatekeeper-Warnung möglich).
- Windows ohne Authenticode: ggf. SmartScreen-Warnung.
- Auto-Update in der App nutzt die Tauri-Updater-Signatur (Pubkey), unabhängig von OS-Code-Signing.
