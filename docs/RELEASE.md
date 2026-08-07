# Releases & Auto-Update

Source: privates Repo `a-kowalenko/AeroTandemStudio-v2`  
Binaries: öffentliches Repo [`a-kowalenko/aero-tandem-studio-releases`](https://github.com/a-kowalenko/aero-tandem-studio-releases)

Updater-Endpoint:

```text
https://github.com/a-kowalenko/aero-tandem-studio-releases/releases/latest/download/latest.json
```

## Secrets (privates Repo)

| Secret | Pflicht |
|--------|---------|
| `RELEASES_GITHUB_TOKEN` | ja — PAT, Contents R/W auf Releases-Repo |
| `TAURI_SIGNING_PRIVATE_KEY` | ja |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | ja (Key ist verschlüsselt) |
| Apple / Windows Authenticode | nein (optional, kostet) |

## Neuen Release erstellen (empfohlen)

Voraussetzung: **sauberer** Working Tree auf `master`/`main`, synchron mit `origin`.

### IDE (Play)

Run Configuration **Release** (`.run/Release.run.xml`) → Play.  
Im Terminal: `patch` / `minor` / `major` wählen, mit `y` bestätigen.

Das Skript setzt die Version, committed `release: x.y.z`, taggt `vx.y.z` und pusht Branch + Tag.

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
