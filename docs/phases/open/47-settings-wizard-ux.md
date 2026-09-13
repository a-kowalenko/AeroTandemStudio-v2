# Phase 47 — Settings + Setup-Wizard UX Rebuild

> **Agent-Attach:** Diese Datei (nicht Archiv/ganzen Plan).
> Regeln: `@AGENTS.md` · Index: `@docs/IMPLEMENTATION_PLAN.md`

**Status:** ✅ Erledigt  
**Abhängigkeiten:** keine offenen Feature-Phasen; bestehendes Settings-/Wizard-Verhalten ist Source of Truth  
**Ziel:** Settings und Setup-Wizard nach **derselben Informationsarchitektur** neu aufbauen: Sidebar statt 7 wrappender Tabs, Progressive Disclosure, gemeinsamer **Einfach-** vs. **Erweitert/Benutzerdefiniert**-Modus. Kein neues Backend-Verhalten außer einem Persist-Feld für den UI-Modus.

> Eine Agent-Session = nur Phase 47. Kein Scope-Creep in USB-MTP (23.x), Extra-Files (31.5), Encoding-Pipeline oder AMS-API.

---

##### Ausgangslage (Ist)

**Settings** (`src/components/settings/SettingsDialog.tsx` + 7 Tabs):

- Tabs: Allgemein · Crew · QR · Encoding · SD · Server · System
- Shell: Modal `max-w-2xl` / `h-[min(85vh,42rem)]`, `TabsList` mit `flex-wrap`
- Schwere Tabs (SD / Server / System / Encoding) = lange Checkbox-Listen + dauerhafte Hint-Zeilen
- Encoding hat bereits Accordion „Erweitert“; andere Tabs nicht
- Deep-Links: `openSettings({ tab, focus })` — Focus-Targets nur im Server-Tab (`server-url`, `server-credentials`, `server-backup-url`, `ams-bridge-url`, `ams-bridge-token`)
- SD verweist für Backup-URL nach Server (`openSettings({ tab: "server", focus: "server-backup-url" })`)
- Persist: `useSettingsDraft` (`patch` / `patchNow` / `flush`) — **behalten**
- Theme liegt in `themeStore`, nicht in `AppConfig`

**Setup-Wizard** (`SetupWizard.tsx`):

- Linear: Appearance (Sprache, Theme, Operator/Rollen) → Storage → Import (Backup, Import, Eject, QR-Toggles) → Upload (`WizardUploadServerStep`) → Finish
- Skip pro Schritt + Skip-all; Factory-Reset öffnet den Wizard erneut
- Dicht, aber schon nah an den Alltags-Entscheidungen — **kein** USB-/Encoding-/QR-Parameter-Step heute
- Wizard und Settings teilen bereits viele i18n-Keys (`settings.*`)

**Config-Defaults (nicht überschreiben):** `video_codec=auto`, `sd_backup_mode=confirm`, `sd_auto_backup=true`, `sd_auto_import=true`, QR-Scan an, `hardware_acceleration_enabled=false`, `sd_eject_after_workflow=false`. Fleet-Preset v1 (`settings_fleet_preset_v1_applied`) bleibt unberührt.

---

##### Out of Scope

- Keine Änderung an FFmpeg-/Encoding-Semantik, Upload-/SD-Workflow-Logik, AMS-Protokoll
- Kein neues Factory-Default-Set; kein Anfassen von `apply_fleet_settings_preset_v1`
- Kein Full-Route / Settings als eigene Seite; Modal bleibt
- Kein Dark-Mode-Redesign der gesamten App
- Kein neuer „Wizard erneut starten“-Einstieg (weiter nur First-Run + Factory-Reset)
- Phase 23 / 31.5 / OPT nicht anfassen
- Kein Erzwingen von Server-Verbindung (Skip bleibt)
- Keine neuen `AppConfig`-Keys außer `settings_ui_mode`

---

##### Entscheidungen

| # | Thema | Entscheidung |
|---|--------|----------------|
| 1 | Phasenform | **Eine** Phase 47 = Settings + Wizard + shared IA. Work-Packages A–E, ein Deliverable |
| 2 | Settings-Shell | Modal bleibt. Breite ↑ (`max-w-4xl` o.ä., ~90vh). **Linke Sidebar-Nav** statt wrappender Tab-Leiste. Bestehende Dismiss-/Combobox-Guards behalten |
| 3 | Settings-IA (5 Areas) | `workplace` · `media` · `connection` · `output` · `maintenance` |
| 4 | Mapping Alt → Neu | `allgemein`+`crew`→`workplace`; `qr`+`sd`→`media`; `server`→`connection`; `encoding`→`output`; `system`→`maintenance` |
| 5 | Tab-Aliase | `SettingsTab` akzeptiert **alte und neue** IDs. `resolveSettingsArea(tab)` mappt immer auf eine Area. Alle `openSettings`-Aufrufe und `DialogPrimaryAction` bleiben gültig |
| 6 | Focus-Targets | String-IDs unverändert. Deep-Link wechselt Area + scrollt/fokusiert wie heute |
| 7 | Complexity-Feld | `settings_ui_mode: "simple" \| "advanced"` in Rust + TS |
| 8 | Migrate Legacy | Key fehlt + `setup_completed == true` → `"advanced"` (bestehende Operatoren sehen alles). Key fehlt + First-Run / `setup_completed == false` → `"simple"`. `AppConfig::default()` → `"simple"` |
| 9 | Labels | Settings-Toggle: **Einfach** / **Erweitert**. Wizard-Karten: **Einfach** / **Benutzerdefiniert**. Beide schreiben dasselbe Enum (`simple` / `advanced`) |
| 10 | Simple filtert | Nur Primärcontrols sichtbar. Alles andere hinter Toggle oder Accordion „Weitere Optionen“ |
| 11 | Deep-Link vs. Simple | Focus-Target **zeigt das Feld trotzdem** (temporär reveal), **ohne** persistierten Modus umzuschalten. Optional kurzer Hinweis „Erweitertes Feld“ |
| 12 | Shared primitives | `SettingsNav`, `SettingsSection` (bestehend), neu `SettingsRow`, `ComplexityToggle`. Wizard darf Rows/Sections nutzen, bleibt aber Fullscreen-Overlay |
| 13 | Wizard-Moduswahl | **Neuer Schritt 0.** Setzt `settings_ui_mode` und die Step-Machine. Zurück zu Schritt 0 und Wechsel: Step-Liste neu, bereits gesetzte Pfade/Operator **nicht** löschen |
| 14 | Wizard Einfach | Heutiger Kern, entschlackt: Appearance+Operator → Storage → kompaktes Medien (Backup-Ordner, Auto-Import, Eject, QR an/aus) → Upload optional → Finish. **Kein** USB-Mode, Size-Limit, QR-Sekunden, Encoding, AMS-Discover |
| 15 | Wizard Benutzerdefiniert | Einfach-Pfad **plus** Media-Accordion (USB, Size, QR-Parameter, Clear-after, Server-Zweitpfad-Strategie) **plus** Output-Kernstep (Codec/Strategie/HW) **plus** voller Connection-Step (AMS Discover/Token wie heute im Upload-Step, nicht kürzen) |
| 16 | Keine stillen Presets | Einfach schreibt **keine** Encoding-/Eject-/HW-Werte. Factory-Defaults bleiben. Nur `settings_ui_mode` + User-Eingaben |
| 17 | Skip | Skip pro Schritt + Skip-all bleiben (Skip-all-Confirm wie heute) |
| 18 | Finish | `setup_completed=true`; Modus bleibt; Hinweis „Feintuning unter Einstellungen“ |
| 19 | Factory-Reset | `reset_config` → Default inkl. `settings_ui_mode=simple`, `setup_completed=false`, Wizard öffnet (bestehender `onAfterFactoryReset`) |
| 20 | Persist-Engine | `useSettingsDraft` + Wizard-`persist` behalten; weiter auto-persist, kein Save-Button |
| 21 | Danger Zone | Nur `maintenance`. In Simple hinter Accordion „Erweitert“; Confirms unverändert |
| 22 | Backup-URL | Single Source bleibt Connection/Profil. Media: Read-only + Deep-Link (wie heute) |
| 23 | Tests | Rust: Migrate-Fälle (legacy completed → advanced, first-run → simple). TS: Alias-Map. Optional Step-Listen simple vs advanced. `cargo test` + `npm run check` |

---

##### Ziel-Informationsarchitektur

```
workplace     Theme, Sprache, Speicherort, Dropzone, Operator, Crew
media         SD-Backup, Server-Zweitpfad (Anzeige + Deep-Link), Import, Eject,
              USB/MTP, Größenlimit, QR
connection    Server-Profile, SMB-Credentials, Upload-Flags, AMS-Bridge,
              Path-Hints; Backup-URL editierbar hier
output        Codec, Strategie, HW, Parallel, Speculative, Concat;
              Intro/CRF/… = Accordion / nur Erweitert
maintenance   Updates, Cache, Auto-Cleanup, Danger Zone, Factory Reset
```

**Simple — sichtbare Primärcontrols**

| Area | Sichtbar in Einfach |
|------|---------------------|
| workplace | Theme, Sprache, Speicherort, Ort, Operator + Rollen, Crew-Liste kompakt |
| media | Backup-Modus, Auto-Backup + Ordner, Server-Zweitpfad an/aus (URL aus Profil), Auto-Import, Eject |
| connection | Aktives Profil, URL/Login + Test, Upload nach Create, AMS URL/Token + Test |
| output | Codec, Strategie, HW-Accel |
| maintenance | Update-Check, Cache leeren |

**Nur Erweitert (Beispiele):** Intro/CRF/Concat-Details, Speculative, Parallel, QR-Sekunden/Remove-after, USB-Mode, Size-Limit, Eject-Sound, Skip-processed, Clear-after, PC-Name, Copy-Strategie, AMS Discover, Path-Hints-Feintuning, Auto-Cleanup, Danger, Beta-Updates, Log-Level.

Crew-Editor, Folder-Picker und Server-Profile-Editor **nicht** neu erfinden — umhängen und in Simple kompakter zeigen.

---

##### Setup-Wizard

###### Schritt 0 — Sprache + Moduswahl

Oben zuerst Sprache. Darunter zwei Karten (Titel auf gleicher Höhe):

1. **Einfach** — „Schnelle Einrichtung mit empfohlenen Vorgaben.“
2. **Benutzerdefiniert** — „Alle Einstellungen selbst festlegen.“

###### Einfach — Steps

| # | id | Inhalt | Pflicht / Skip |
|---|----|--------|----------------|
| 0 | `mode` | Sprache oben, dann Kartenwahl | ja |
| 1 | `workplace` | Theme, Dropzone, Operator + Rollen | Skip ok |
| 2 | `connection` | Nur AMS-Suche + Token + Verbinden (kein Upload-Toggle, kein SMB-Formular) | Skip ok |
| 3 | `finish` | Kompakte Zusammenfassung (übernommene Standardpfade, Medien-Vorgaben) | Fertig |

Nicht im Einfach-Pfad: Speicherort- und Backup-Picker (Standardordner werden still angelegt/übernommen), Medien-Toggles (alle an: Auto-Backup, Auto-Import, Eject, QR Video/Foto), USB-Mode, Size-Limit, QR-Parameter, Clear-after, Encoding, manuelles SMB / Calden-Gera-Presets / Profilname. Verbindung später in den Einstellungen möglich. Dropzone liegt im Arbeitsplatz-Schritt.

###### Benutzerdefiniert — Steps

| # | id | Inhalt |
|---|----|--------|
| 0 | `mode` | Wahl |
| 1 | `workplace` | Theme, Dropzone, Operator + Rollen |
| 2 | `storage` | wie Einfach |
| 3 | `media` | Einfach-Medien **plus** Accordion: Clear-after, PC-Name-Hinweis, USB, Size, QR-Parameter/Remove |
| 4 | `connection` | voller heutiger Upload-Step inkl. AMS |
| 5 | `output` | Codec, Strategie, HW; Accordion Intro/Concat. Skip → Factory-Defaults unverändert |
| 6 | `finish` | Checkliste + Modus Erweitert |

###### Finish / Skip-all

- Persist inkl. `setup_completed` und `settings_ui_mode`
- Übersprungene Schritte in der Summary markieren (bestehendes Muster)
- Skip-all: Confirm wie heute, markCompleted=true, Modus trotzdem persistieren (was in Schritt 0 gewählt wurde)

---

##### Settings-Shell

```
┌──────────────────────────────────────────────┐
│ Einstellungen           [ Einfach | Erweitert ] │
├────────────┬─────────────────────────────────┤
│ Arbeitsplatz │  SettingsRow / Section         │
│ Medien     │  Accordion „Weitere Optionen“   │
│ Verbindung │                                 │
│ Ausgabe    │                                 │
│ Wartung    │                                 │
├────────────┴─────────────────────────────────┤
│ Footer Version + Persist-Spinner             │
└──────────────────────────────────────────────┘
```

- Nav: Icon + Label, aktiver Eintrag hervorgehoben
- `SettingsRow`: Titel links, Control rechts; lange Hints als Tooltip/`title`, nicht Dauer-Absatz
- Encoding-Accordion-Muster auf Media / Connection / Maintenance / Output übertragen
- Nested Confirms (Reset / Cache / Danger) bleiben eigene Dialoge

---

##### Work-Packages

**A — Fundament**

- [x] `settings_ui_mode` in `config.rs` + `AppConfig` TS + Default/Migrate (Entscheidung 8)
- [x] `resolveSettingsArea` + Aliase; `openSettings` / `ValidationFailure.tab` nutzen die Map
- [x] i18n de / en / es-MX für Areas + Complexity (Wizard-Karten + Settings-Toggle)
- [x] Rust-Tests Migrate; TS-Test Alias-Map

**B — Settings-Shell**

- [x] Sidebar-Layout, größere Shell, Toggle im Header
- [x] Bestehende Tab-Inhalte in 5 Areas umhängen (Verhalten zuerst 1:1)
- [x] Focus-Flash für alle bisherigen Targets (Area `connection`)

**C — Disclosure**

- [x] Simple-Filter laut Tabelle; Deep-Link-Reveal ohne Mode-Flip
- [x] Accordions; weniger dauerhafte 11px-Hints
- [x] Danger in Simple hinter Accordion

**D — Wizard**

- [x] Mode-Step + Step-Machines
- [x] Einfach = entschlackter heutiger Pfad inkl. Medien-Kern
- [x] Benutzerdefiniert = plus Media-Details + Output
- [x] `WizardUploadServerStep` wiederverwenden
- [x] Finish-Summary + Skip-all unverändert semantisch
- [x] Mode-Wechsel zurück zu Schritt 0 löscht keine Pfade

**E — Abnahme**

- [x] Deep-Links: Header-Connection, SD-Backup-URL, AMS-Banners, Draft-Validation
- [x] Factory-Reset → Wizard
- [x] Beide Wizard-Pfade, Toggle Simple↔Erweitert
- [x] `cargo test` && `npm run check` && `npm run tauri dev`

---

##### Referenzen

```
src/components/settings/SettingsDialog.tsx
src/components/settings/tabs/*.tsx
src/components/settings/SettingsSection.tsx
src/components/settings/hooks/useSettingsDraft.ts
src/store/uiStore.ts
src/components/SetupWizard.tsx
src/components/WizardUploadServerStep.tsx
src-tauri/src/storage/config.rs
src/lib/tauri.ts
src/locales/de.json | en.json | es-MX.json
```

---

##### Akzeptanzkriterien

1. Settings: 5 Nav-Areas, keine wrappende 7-Tab-Leiste
2. Toggle Einfach/Erweitert persistiert; Simple blendet Advanced-Controls aus
3. Alle heutigen Settings-Werte bleiben im Erweitert-Modus erreichbar
4. Alte `openSettings({ tab: "server" | "sd" | … })`-Aufrufe funktionieren
5. Focus-Targets scrollen/fokusieren weiter; in Simple temporär sichtbar
6. Wizard: Mode-Step; Einfach behält Storage + Backup-Ordner; Custom deckt Media-Details + Output ab
7. Keine stillen Änderungen an Encoding/HW/Eject-Factory-Defaults
8. Legacy mit `setup_completed` startet in Erweitert
9. Factory-Reset öffnet Wizard, Modus wieder Einfach
10. i18n de/en/es-MX; keine AMS-/Manifest-Jargon-Regression
11. Tests grün

---

##### Agent-Prompt

```
Implementiere Phase 47 aus @docs/phases/open/47-settings-wizard-ux.md
Regeln: @AGENTS.md
Nur 47: Settings-Shell (Sidebar + 5 Areas), settings_ui_mode simple|advanced
(Legacy completed → advanced), Progressive Disclosure, Setup-Wizard
(Einfach vs Benutzerdefiniert) mit gemeinsamer IA.
Persist-Engine und Encoding/SD/Upload-Semantik nicht ändern.
Keine stillen Presets. Deep-Link-Aliase und Focus-Targets behalten.
i18n de/en/es-MX.
Danach cargo test && npm run check && npm run tauri dev.
```
