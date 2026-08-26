# Releases & Auto-Update

Source: privates Repo `a-kowalenko/AeroTandemStudio-v2`  
Binaries: öffentliches Repo [`a-kowalenko/aero-tandem-studio-releases`](https://github.com/a-kowalenko/aero-tandem-studio-releases)

Updater-Endpoint (Stable / Latest):

```text
https://github.com/a-kowalenko/aero-tandem-studio-releases/releases/latest/download/latest.json
```

Beta-Updates (nur mit Einstellung **Betatester**): GitHub-Releases-API inkl. Prereleases — auch wenn die App aktuell auf einer Stable-Version läuft.

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

### Alltag

Nutzer-sichtbare Punkte unter **`## [Unreleased]`** eintragen (Bullet-Listen) — bei jeder sichtbaren Änderung bzw. vom Agenten dort anlegen.

### Beta vs. Stable

| Aktion | `[Unreleased]` | Neuer Abschnitt |
|--------|----------------|-----------------|
| **Beta** (`0.3.9-beta.1`) | bleibt erhalten | Snapshot-Kopie → `## [0.3.9-beta.1]` |
| **Stable** (`0.3.9`) | wird geleert (promote) | `## [0.3.9]` |

Bei `beta.2` wird erneut der **gesamte** aktuelle Unreleased-Stand kopiert (inkl. dem, was schon in `beta.1` stand) — Absicht, damit Beta-Tester den Gesamtstand Richtung Stable sehen.

`npm run release`:

- **`[Unreleased]` befüllt** → Notes für Stable-Promote bzw. Beta-Snapshot
- **Beta und Unreleased leer** → Stub „Vorabversion zum Testen“
- **Stable patch und Unreleased leer** → Notes der Vorgängerversion
- **Stable minor/major und leer** → Abbruch

CI liest `## [versionsnummer]` am Tag (`node scripts/changelog.mjs extract …`). Bei fehlendem Beta-Abschnitt kein Walkback auf alte Stable-Notes.

```bash
node scripts/changelog.mjs extract 0.3.9-beta.1
node scripts/changelog.mjs extract 0.3.9
```

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
- …   # optional
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

### IDE (Play)

Run Configuration **Release** (`.run/Release.run.xml`) → Play.

### Terminal

```powershell
npm run release
```

### Menü

**Aktuelle Version ist Stable** (z. B. `0.3.8`):

1. Ziel-Bump: `patch` / `minor` / `major`
2. Kanal: `stable` / `beta`

| Wahl | Ergebnis |
|------|----------|
| patch + beta | `0.3.9-beta.1` |
| minor + beta | `0.4.0-beta.1` |
| major + beta | `1.0.0-beta.1` |
| patch + stable | `0.3.9` |

**Aktuelle Version ist schon Beta** (z. B. `0.3.9-beta.1`):

- `beta` → `0.3.9-beta.2`
- `stable` → `0.3.9` (Suffix weg, Unreleased → finale Notes)

Das Skript setzt die Version in `package.json`, Locks, `tauri.conf.json`, `Cargo.toml`, committed `release: …`, taggt `v…` und pusht Branch + Tag.

### CI-Verhalten

```text
prepare → release (Win + 2× Mac + Linux) → promote-latest (nur Stable)
```

| Tag | GitHub | Latest |
|-----|--------|--------|
| `v0.3.9-beta.1` | Prerelease | nein |
| `v0.3.9` | Release | **ja**, automatisch nach grünem Matrix-Build (`promote-latest`) |

`promote-latest` startet von selbst — kein manueller Trigger. Voraussetzung: Asset `latest.json` vorhanden; ältere Stable-Tags demote kein neueres Latest.

Beispiel-Timeline:

```text
0.3.8 (Latest)
  → v0.3.9-beta.1 (prerelease)
  → v0.3.9-beta.2 (prerelease)
  → v0.3.9 (stable) → CI setzt Latest
```

Normale Commits auf `master` starten **keinen** App-Build. Volle Bundles nur bei Version-Tags (`release.yml`). PRs: leichter Check in `test.yml`.

## Installer-Links (neueste Stable)

Nach Auto-Latest (Stable-Release):

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
- SemVer: `0.3.9-beta.1` &lt; `0.3.9` — Beta-Nutzer erhalten die finale Stable als Update.
