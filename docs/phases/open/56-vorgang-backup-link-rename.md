# Phase 56 — Vorgang ↔ SD-Backup verknüpfen + Umbenennen (lokal + SMB)

> **Agent-Attach:** Diese Datei (nicht Archiv/ganzen Plan).  
> Regeln: `@AGENTS.md` · Index: `@docs/IMPLEMENTATION_PLAN.md`

**Status:** ⬜ Offen  
**Abhängigkeiten:** Phase 7/SD-Backup (`build_backup_dir_name`, Manifest), Phase 12 (`vorgang_history`), Phase 42 (Auto-Bereinigung Backups), Secondary-Backup (`secondary_backup.rs` / `mirror_backup_to_smb`), SMB-Client (`client.rename`)  
**Ziel:** Pro Vorgang **einen oder mehrere** SD-Backup-Ordner in der Historie führen (Normalfall: Foto-SD + Video-SD) und optional **lokal** sowie auf dem **Server-Backup (SMB)** mit Kundennamen umbenennen — ohne Export-Ordner (`speicherort`) zu verwechseln.

> **Eine Agent-Session = ein Slice (56A–56D).** Kein Bulk-Upload-Umbau, kein Cloud-Ordner-Rename, keine Aufteilung eines Backup-Ordners auf mehrere Vorgänge (nur Edge-Case absichern).

---

## Ausgangslage (Ist)

| Thema | Verhalten heute |
|--------|------------------|
| Backup-Ordner | Unter `config.sd_backup_folder`, Name `SD_Backup_{timestamp}[{pc}]_{hash}` (`monitor.rs` → `build_backup_dir_name`) |
| Import | Nutzt Backup-Pfade **in-place** (`import_sd_files` kopiert nicht weg) |
| Vorgang | `base_output_dir` / `base_filename` unter `speicherort` — getrennt vom Backup |
| Historie | **Keine** Persistenz von `backup_path` / `secondary_backup_path` pro Vorgang |
| Server-Backup | Leaf = Ordnername der lokalen Session (`mirror_backup_to_smb`); oft **async** nach SD-Lauf |
| Auto-Cleanup Backups | Alter aus Ordnername-Präfix `SD_Backup_YYYYMMDD_HHMMSS` (`local_folders.rs`), Fallback `mtime` |

**Normalfall (Produkt):** User steckt SD → Backup+Import (alle oder Auswahl) → ggf. zweite SD für andere Medien → **ein** Create. Erwartung: **N Backups : 1 Vorgang**.  
**Selten:** Ein Backup-Ordner wird fälschlich für zwei Vorgänge genutzt — nicht optimieren, nur idempotent / warnbar.

---

## Leitentscheidungen

| # | Thema | Entscheidung |
|---|--------|--------------|
| 1 | Kardinalität | **N Backup-Ordner pro Vorgang** (1..n Zeilen); gleicher Pfad darf theoretisch mehrfach verknüpft sein → dedupe beim Insert |
| 2 | Zuordnung | Beim erfolgreichen **Create** (`record_create_job`): aus **Quell-Pfaden** (Videos + Fotos des Jobs) alle übergeordneten `SD_Backup_*`-Ordner unter `sd_backup_folder` ableiten |
| 3 | Append / Nachreichung | **Out of Scope v1** — nur Create-Pfad; Appends später optional (56.x) |
| 4 | Umbenennen — wann | Direkt nach Historie-Insert, wenn Kunde bekannt (`Kunde::resolve_gast()` + `sanitize_filename`) |
| 5 | Umbenennen — lokal | Timestamp **behalten** für Phase-42-Parser: `SD_Backup_{ts}_{Gast}[{pc}]_{hash}` — Gast = sanitized `resolve_gast()` (Leerzeichen → `_`) |
| 6 | Kollision lokal | Ziel existiert → Suffix `_2`, `_3` … vor Hash-Segment oder Hash beibehalten (Unit-Test festlegen) |
| 7 | SMB Rename | Gleicher **Leaf-Name** wie lokal unter konfigurierter Server-Backup-URL (`resolve_sd_server_backup_url` + Credentials wie Secondary) |
| 8 | SMB — Remote-Pfad | Gespeichert in DB: `remote_path` + `remote_url` (SMB-URL zum Zeitpunkt des Mirrors/Rename); bei Rename Pfad aus `share/subpath/old_leaf` → `…/new_leaf` via bestehendem SMB-Rename (Ordner) |
| 9 | Async Secondary | Wenn Mirror für `primary_path` **noch läuft**: Rename erst **queue’n** (Post-Mirror-Job) oder auf `SecondaryBackupEvent` `done` warten — **kein** paralleles Upload+Rename desselben Leafs |
| 10 | Secondary nie gestartet | Nur lokales Rename; `remote_path` leer |
| 11 | Settings | Schalter: **Backup-Ordner mit Kundennamen umbenennen** (lokal); Unter-Schalter oder gekoppelt: **… auch auf Server-Backup (SMB)** — nur wenn `sd_server_backup_enabled` |
| 12 | Fehler SMB | **Soft-Fail:** Vorgang + lokales Rename + DB-Link bleiben; Warnung in Log + optional Toast; Feld `remote_rename_error` am Backup-Eintrag |
| 13 | Auto-Cleanup | Unverändert zeitbasiert; Timestamp im Namen **muss** erhalten bleiben |
| 14 | Explorer / UI | Historie-Detail: Sektion **SD-Backups** — Liste, Ordner öffnen, fehlend wie „Ordner fehlt“ |

---

## Datenmodell

Neue Tabelle `vorgang_backups` (Migration in `vorgang_history.rs`):

| Spalte | Typ | Beschreibung |
|--------|-----|--------------|
| `id` | INTEGER PK | |
| `vorgang_id` | INTEGER FK | `vorgaenge.id` ON DELETE CASCADE |
| `kind` | TEXT | `primary_local` \| `secondary_smb` (pro **logischer** Session: 1 Zeile reicht mit beiden Pfaden, siehe unten) |
| `local_path` | TEXT | Absoluter Pfad unter `sd_backup_folder` |
| `local_original_name` | TEXT | Leaf vor Rename |
| `local_renamed_at` | TEXT | ISO oder leer |
| `remote_path` | TEXT | Anzeige-Pfad nach Mirror (wie `secondary_backup_path` heute) |
| `remote_original_leaf` | TEXT | Leaf auf Server vor Rename |
| `remote_renamed_at` | TEXT | ISO oder leer |
| `remote_rename_error` | TEXT | letzter Fehler (soft) |
| `linked_at` | TEXT | ISO |

**Vereinfachung:** Eine Zeile pro **lokalem** Backup-Ordner; SMB-Felder optional auf derselben Zeile (kein zweiter Mirror ohne lokalen Primary).

Index: `idx_vorgang_backups_vorgang ON vorgang_backups(vorgang_id)`.

---

## Pfad-Ableitung (Rust)

Neue Hilfsfunktion z. B. in `local_folders.rs` oder `sd_card/backup_link.rs`:

1. `config.sd_backup_folder` normalisieren (wie `resolve_existing_root`).
2. Für jeden Quellpfad: canonicalize/best-effort; walk parents bis direct child of backup root.
3. Akzeptieren wenn Ordnername `starts_with("SD_Backup_")` **oder** Manifest `_backup_manifest.v1.json` im Ordner (`read_backup_manifest`).
4. Distinct sortiert zurückgeben.

Unit-Tests: Pfad in Unterordner, Escape außerhalb Root, zwei Pfade → ein Backup, zwei Backups → zwei Einträge.

---

## Umbenennen — Namensbuilder

Erweiterung von `build_backup_dir_name` → z. B. `build_backup_dir_name_with_guest(timestamp, pc_name, short_hash, guest_segment)`:

- `guest_segment` aus `sanitize_filename` / gleiche Regeln wie Export (max Länge — PC-Segment-Logik wiederverwenden, Gast max ~32 Zeichen wie `sanitize_pc_name_for_backup`).
- Format: `SD_Backup_{timestamp}_{guest}[{pc}]_{hash}` — wenn `guest` leer → heutiges Verhalten (kein Extra-Segment).
- Parser `parse_sd_backup_folder_timestamp`: weiterhin erste 15 Zeichen nach `SD_Backup_` (= unverändert).

---

## SMB Rename (Technik)

Neue Funktion z. B. `smb::rename_remote_backup_folder`:

- Input: SMB-URL (+ Login/Passwort / Auto-Mount wie Upload), `old_leaf`, `new_leaf` (nur Leaf, kein Path-Escape).
- Remote-Ziel = gleiche `subpath` wie `upload_path` / Mirror (Share-Root + konfiguriertes Unterverzeichnis).
- Implementierung: SMB2 `rename` auf Ordner (analog Staging-Promote in `client.rs`); Session-Pool / Invalidate bei Fehler wie Upload.
- **Nicht** Finder-Mount als Primärpfad — konsistent mit Secondary-Backup.

**Ablauf pro Backup-Eintrag beim Create-Rename:**

```
1. new_leaf = berechnet aus Gast + altem Leaf (Hash/TS/PC extrahieren)
2. fs::rename(local_old, local_new) — Containment-Check
3. Wenn sd_server_backup_enabled && remote_rename_setting:
     a) Wenn Secondary-Job für local_old noch queued/running → Pending-Rename registrieren (In-Memory-Map primary_path → new_leaf) ODER DB-Flag `remote_rename_pending`
     b) Sonst: remote rename old_leaf → new_leaf; remote_path in DB aktualisieren
4. Manifest im Ordner bleibt gültig (liegt im umbenannten Ordner)
```

**Post-Mirror-Hook:** In `SecondaryBackupQueue` nach `done`: prüfen ob Pending-Rename für diese `primary_path` (nach lokalem Rename: Match über `local_original_name` oder gespeicherte Job-Korrelation) → SMB Rename ausführen.

---

## Slices (Implementierung)

### 56A — Link on Create (ohne Rename)

- [ ] Schema + `VorgangBackup` Types + `list_vorgang_backups(vorgang_id)`
- [ ] `resolve_backup_folders_from_source_paths(paths, sd_backup_folder)`
- [ ] Nach `record_create_job`: `link_vorgang_backups(vorgang_id, paths)` (Videos+Fotos aus Create)
- [ ] TS: Types + `listVorgangBackups` in `vorgangHistory.ts`
- [ ] Unit-Tests Pfad-Ableitung + Insert dedupe

### 56B — Lokales Umbenennen + Settings

- [x] Config: `sd_backup_rename_with_guest` (bool, default **true**)
- [x] `rename_vorgang_backup_local` + Namensbuilder + Kollision
- [x] Hook nach Link in Create-Pipeline wenn Schalter an
- [x] i18n Settings (Erweitert / SD-Backup)
- [x] Unit-Tests: Timestamp parse nach Rename, Kollision, Sanitize Gast

### 56C — SMB Umbenennen + Secondary-Race

- [x] Config: `sd_server_backup_rename_with_guest` (bool, nur wirksam wenn Server-Backup an)
- [x] `rename_remote_backup_folder` + Tests (Mock / lokaler SMB-Fallback wie bestehende Tests)
- [x] Pending-Queue: Rename nach async Secondary `done`
- [x] Sync Mirror (selten): Rename sofort nach lokalem Rename wenn `remote_path` bekannt
- [x] Soft-Fail + `remote_rename_error` persistieren
- [x] Logging + optional Toast bei SMB-Fehler

### 56D — Historie-UI

- [ ] Detail-Panel: Sektion SD-Backups (lokal + Server-Zeile wenn `remote_path`)
- [ ] Buttons: Explorer öffnen (lokal); Server-Pfad Copy / Hinweis (kein SMB-Streaming)
- [ ] „Ordner fehlt“ wenn `local_path` nicht existiert
- [ ] i18n de / en / es-MX
- [ ] Manuell: Foto-SD + Video-SD → 2 Einträge; Rename lokal + SMB sichtbar

---

## Out of Scope

- Backup-Ordner manuell nachträglich zuordnen (Reparatur-UI)
- Append-/Nachreichungs-Backups
- Umbenennen des **Export**-Ordners (`base_output_dir`) — bereits durch `build_base_filename`
- AMS-/Cloud-Share-Pfade
- Secondary-Backup-URL-Wechsel nachträglich (alte Remote-Pfade nicht migrieren)
- Aufteilen eines Shared-Backup-Ordners auf mehrere Vorgänge

---

## Akzeptanzkriterien (Gesamt)

1. Create mit Quellen aus zwei `SD_Backup_*`-Ordnern → Historie zeigt **2** Backup-Einträge
2. Mit Rename an: beide lokalen Ordner enthalten Gastname, Timestamp-Präfix parsebar
3. Server-Backup an + Mirror fertig: SMB-Leaf entspricht lokalem Leaf nach Rename
4. Mirror läuft noch beim Create: Rename lokal sofort; SMB folgt nach `done` ohne Datenverlust
5. SMB Rename fehlgeschlagen: Vorgang ok, Fehlerhinweis am Eintrag
6. Auto-Cleanup-Tests / Parser weiter grün
7. `cargo test` + `npm run check`

---

## Referenzen (Code)

```
src-tauri/src/sd_card/monitor.rs           # build_backup_dir_name, backup_path
src-tauri/src/sd_card/secondary_backup.rs  # mirror_backup_to_smb, EVENT_SECONDARY_BACKUP
src-tauri/src/storage/local_folders.rs     # parse_sd_backup_folder_timestamp, root containment
src-tauri/src/storage/vorgang_history.rs   # insert_vorgang, schema
src-tauri/src/commands/video.rs            # record_create_job hook
src-tauri/src/model/kunde.rs               # resolve_gast
src-tauri/src/video/export_paths.rs        # sanitize_filename
src-tauri/src/smb/client.rs                # rename (Ordner)
src-tauri/src/media/dji_paths.rs             # backup manifest
src/lib/vorgangHistory.ts
src/components/history/…                  # Vorgang-Detail
src/components/settings/…                 # SD-Backup
src/locales/de.json | en.json | es-MX.json
```

---

## Agent-Prompts

**56A:**

```
Implementiere Phase 56 Slice A aus @docs/phases/open/56-vorgang-backup-link-rename.md
Regeln: @AGENTS.md
Nur 56A (Schema + Pfad-Ableitung + Link beim Create, ohne Rename).
Danach cargo test && npm run check.
```

**56B:**

```
Implementiere Phase 56 Slice B aus @docs/phases/open/56-vorgang-backup-link-rename.md
Regeln: @AGENTS.md
Nur 56B (lokales Umbenennen + Settings).
Danach cargo test && npm run check.
```

**56C:**

```
Implementiere Phase 56 Slice C aus @docs/phases/open/56-vorgang-backup-link-rename.md
Regeln: @AGENTS.md
Nur 56C (SMB Rename + Secondary-Race).
Danach cargo test && npm run check.
```

**56D:**

```
Implementiere Phase 56 Slice D aus @docs/phases/open/56-vorgang-backup-link-rename.md
Regeln: @AGENTS.md
Nur 56D (Historie-UI + i18n).
Danach cargo test && npm run check && npm run tauri dev.
```

---
