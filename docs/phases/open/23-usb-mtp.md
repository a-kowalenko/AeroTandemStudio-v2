# Phase 23 — USB-Action-Cams (MTP) erkennen & importieren

> **Agent-Attach:** Diese Datei (nicht Archiv/ganzen Plan).
> Regeln: `@AGENTS.md` · Index: `@docs/IMPLEMENTATION_PLAN.md`

**Status:** 🔄 In Arbeit (23.0 ✅ · … · 23.2f Volume-Dedup ✅ · **23.2g MTP-Whitelist ✅** · 23.2h Geräte-Overrides ⬜ · 23.3 Linux ⬜)  
**Abhängigkeiten:** Phase 7 (SD-Pipeline), Phase 5 (Config)  
**Ziel:** GoPro-, DJI- und Insta360-Kameras per USB (MTP/WPD) erkennen und in denselben Backup-/Import-Workflow bringen wie SD-Karten — **ohne** zusätzliche False Positives bei normalen Datenträgern oder Handys.

#### Problem

Neuere Action-Cams erscheinen per USB oft als **MTP/WPD-Gerät**, nicht als Mass-Storage-Volume. Der bestehende Monitor sieht nur Laufwerke/`/Volumes` + `DCIM` → Kamera bleibt unsichtbar. (Insta360 im U-Disk-Modus bleibt über den Volume-Monitor abgedeckt.)

#### Entscheidungen

| Thema | Entscheidung |
|-------|----------------|
| Volume-Monitor | **unverändert** (`is_removable_drive`, macOS/Linux-Kandidaten, `DCIM`) |
| Neuer Pfad | **23.2g:** MTP nur für **Modell-Whitelist** (Opt-in); sonst Volume-only. Bis 23.2g: paralleler Allowlist-MTP-Monitor |
| Identifikation | Primär USB **VID** (+ bekannte PIDs für Label); sekundär Friendly Name; **immer** Inhalts-Signatur |
| Hersteller | GoPro (`0x2672`), DJI (`0x2CA3`), Insta360/Arashi (`0x2E1A`) |
| DJI-Vorsicht | Gleiche VID auch für Controller/Goggles → **ohne** Action-Cam-Signatur kein Match |
| Dateizugriff | Immer **Staging-Kopie** nach `sd_backup_folder` → danach normale Pfade |
| Plattform | **23a Windows**, **23b macOS**, **23c Linux** (je eigene Abnahme) |
| Eject / Clear | MTP: Soft-Disconnect; Clear nur wenn Delete zuverlässig + Config |
| Config | `usb_camera_import_enabled` + `usb_import_mode` (`auto` \| `volume_only` \| `mtp_preferred`) |
| Nicht-Ziele | Keine Handys; Volume-Heuristik nicht lockern; kein FFmpeg auf MTP; kein FUSE/mtpfs |

#### Architektur

```text
VolumeMonitor (Phase 7)          MtpCameraMonitor (Allowlist)
        │                                    │
        └────────────┬───────────────────────┘
                     ▼
              MediaSourceId
           volume:E:  |  mtp:gopro|dji|insta360:<serial>
                     ▼
         list / backup / progress (bestehende Events)
                     ▼
         Staging → lokaler Backup-Pfad → Import/FFmpeg
```

#### MTP-Allowlist (Vendor + Signatur)

Modul: `src-tauri/src/sd_card/mtp/allowlist.rs`

| Vendor-Slug | USB VID | Bekannte PIDs (Label, nicht exklusiv) | Inhalts-Signatur (DCIM) |
|-------------|---------|--------------------------------------|-------------------------|
| `gopro` | `0x2672` | HERO3+ … HERO11 / MAX aus libmtp; neuere Hero-PIDs per VID+Signatur | `100GOPRO` / `GX*.MP4` / `GH*.MP4` / `GP*.MP4` |
| `dji` | `0x2CA3` | Action/Osmo soweit bekannt; **Controller/Goggles ohne Signatur ablehnen** | `DJI_*.MP4/JPG`, typ. `100MEDIA` / DJI-DCIM |
| `insta360` | `0x2E1A` | Action-/360-Kameras (Arashi Vision) | `Camera01` / `.insv` / `.lrv` / Insta-Dateimuster |

Match-Regel: `(VID in Allowlist OR Friendly-Name-Hint) AND content_signature` — nie nur „irgendein MTP mit DCIM“.

#### Aufgaben

**23.0 — Vertrags- & Allowlist-Schicht (plattformneutral)**
- [x] `sd_card/mtp/allowlist.rs` — VID-Tabelle GoPro/DJI/Insta360 + Signatur-Matcher + Unit-Tests
- [ ] `MediaSourceKind`: `Volume` \| `MtpCamera`; stabile IDs `mtp:<slug>:<serial_or_hash>`
- [ ] Trait/Adapter-Skizze: `list_media`, `copy_to_backup`, `disconnect`

**23.1 — Windows (WPD/MTP) — MVP**
- [x] WPD-Enumeration + Hotplug/Polling; nur Allowlist + Signatur
- [x] **Fix:** Katalog/Download-Walk steigt in `FUNCTIONAL_OBJECT` / Alben / `UNSPECIFIED` ab (nicht nur `FOLDER`) — sonst GoPro erkannt, Selector leer trotz Explorer-Medien; Signatur ohne Geräte-Label „GoPro …“
- [x] Events `sd-card-inserted` / `sd-card-removed` mit `source_id` (rückwärtskompatibel)
- [x] List + Staging-Backup mit Progress; Import ab lokalem FS
- [x] Config `usb_camera_import_enabled` + Settings-Toggle
- [x] UI-Label z. B. „GoPro (USB)“ / „DJI (USB)“ / „Insta360 (USB)“
- [ ] Abnahme: SD unverändert; GoPro/DJI/Insta USB ok; Handy/Stick-ohne-Allowlist **nicht**

**23.2 — macOS**
- [x] USB-Detect via `system_profiler` + Allowlist (Hero 8/13, Label-Fix PID `0x0059`)
- [x] Image Capture Core Staging (`native/macos/AtsImageCapture.m` → Cache → SD-Pipeline)
- [x] Clear auf Kamera via Image Capture (gleiche Config wie SD); Volume-Heuristik unverändert
- [x] ICA-Session nach Staging halten (GoPro: Clear in derselben PTP-Session)
- [x] Liste = ICA-Katalog (kein Full-Download); Backup lädt Auswahl mit SD-Progress; Disconnect überschreibt Timeout nicht
- [x] ICA-Session sauber schließen + Browse-Retries (GoPro „Gefunden: (keine)“ nach Reconnect)
- [x] USB-Auswerfen: ICA freigeben + Gerät aus Liste bis Kabel-Replug
- [x] Kein PTPCamera-kill vor Browse (zerstört ICA-Erkennung; kürzerer Browse-Timeout)
- [x] Erkennung Webcam/USB-Connect-Modus (bDeviceClass 2) → klare MTP-Anweisung statt ICA-Timeout
- [x] ICA nur Local-USB (kein Bonjour/Shared) — Netzwerkdrucker störten PTP („Gefunden: (keine)“ trotz MTP)
- [x] CFBundleIdentifier + Photos-Library-Entitlement; Fehlermeldung bei PTP-ready ohne ICA
- [ ] Fallback-Dialog nur noch wenn ICA fehlschlägt

**23.2b — macOS Image Capture Staging-Import**
- [x] `ats_ica_stage_all` (ObjC) + `macos_ica.rs` Cache/TTL
- [x] `scan_mtp_media` / Backup-Pfad für `mtp:` Sources
- [x] UI: USB-Detect startet Confirm/Auto-Flow
- [x] Confirm-Dialog streamt ICA-Katalog (kein 60s Overlay); Grid virtualisiert; ICA-Thumbs ohne Full-Lock
- [x] ICA-UI-Perf: Katalog-Ticks nicht über `App.tsx`; JSON off-main; Thumbs erst nach Listing (Browser bleibt für gehaltene PTP-Session)
- [x] Backup-Nachlauf: Hash on-complete + Batch-SQLite; Clear fail-fast / chunked + Progress

**23.2d — Leere Kataloge (SD + MTP)**

Leere Kamera/SD ist ein **gültiger Zustand**, kein Fehler. Nicht mit ICA-/DCIM-Ausfällen vermischen.

| Zustand | Log | Confirm (`sd_backup_mode=confirm`) | Auto |
|---------|-----|--------------------------------------|------|
| 0 Medien nach erfolgreichem Scan | **WARN** | Dialog offen; Label in der Medienliste | Warn-Dialog, Workflow überspringen; Auswerfen wenn gesetzt |
| Nur Timelapse/Proxies (nichts importierbar) | **WARN** | Label „Keine importierbaren Medien (nur Timelapse/Proxies).“ | wie leer |
| Kamera nicht sichtbar / ICA-Session tot / DCIM fehlt | **ERROR** | Error-Dialog, Selector schließen | Error-Dialog |
| Download/Backup: Auswahl nicht auf der Kamera | **ERROR** | bleibt Fehler | bleibt Fehler |

- [x] ICA `beginList`: leeren Katalog als Erfolg schreiben (`[]`), nicht `failWithMessage`
- [x] `list_sd_files`: 0 Dateien → WARN (`SD-Liste leer`), nicht `SD-Liste fehlgeschlagen` / ERROR
- [x] Texte vereinheitlichen: MTP „Keine Medien auf der Kamera gefunden.“ · SD „Keine Mediendateien auf der SD-Karte gefunden.“
- [x] Confirm: Overlay in der Liste (gleicher Platz wie „SD-Dateien werden gelesen…“); Backup/Import/Bereinigen aus; **Auswerfen** und **Erneut lesen** bleiben
- [x] Auto: kein Error-Dialog bei leerem Katalog; Backup-Fail „keine Medien“ ebenfalls WARN
- [x] `beginDownloads` mit 0 Dateien bleibt Operationsfehler (nicht die Liste)

**23.2e — ICA-Browser überlebt Auswerfen / Replug**

`ICDeviceBrowser` einmal pro Prozess starten und **nicht** bei Eject/Unplug stoppen. Neuer Browser im selben Prozess → GoPro bleibt `Gefunden: (keine)` bis App-Neustart.

- [x] Prozessweiter `AtsIcaHub` als einziger Browser-Delegate
- [x] Auswerfen/Unplug: Session schließen, Kamera-Ref verwerfen; Browser läuft weiter
- [x] Replug: `didAddDevice` auf demselben Browser, dann Liste
- [x] Kein Browser-Restart nach 7 s (würde denselben ICA-Tod auslösen)
- [x] Confirm-Overlay: `min-h-[16rem]`, Label nicht in 1px-Grid abschneiden

**23.2f — Volume/MTP-Dedup (DJI/Insta360 Volume-first)**

Manche Action-Cams (v. a. DJI Osmo Action) erscheinen kurz als `mtp:dji:…`, mounten danach aber `/Volumes/…/DCIM`. Der ICA-Pfad findet oft nur `SD_Card` (kein `ICCameraDevice`) → Fehler, danach doppelter Eintrag. GoPro bleibt ICA-first (kein Mass-Storage-Volume).

| Thema | Entscheidung |
|-------|----------------|
| Volume-first | **DJI**, **Insta360** — gemountetes DCIM bevorzugen; MTP nur Fallback |
| ICA-first | **GoPro** — kein Volume → MTP/Image Capture wie bisher |
| Korrelation | DCIM-Inhalts-Signatur (`allowlist`) + Vendor; 1:1 (ein Volume, eine USB-Kamera desselben Vendors) |
| Mehrdeutig | Zwei DJI-Volumes + eine USB-Kamera → **kein** Dedup (SD-Leser + Cam gleichzeitig) |
| Grace | 5 s nach USB-Hotplug warten, ob Volume mountet (kein MTP-Flash) |
| Supersede | War `mtp:` schon pending und Volume erscheint → ICA freigeben, MTP entfernen, nur Volume |
| `list_mtp` | Wenn Volume die Kamera abdeckt → SD-Scan statt ICA (kein 28 s Timeout) |
| Windows | Gleiche Dedup-Logik WPD + Laufwerksbuchstabe mit DCIM-Signatur |
| Fehlertexte | ICA-Meldungen vendor-neutral (DJI/GoPro/Insta360), nicht nur GoPro |
| Logging | `usb_mtp_suppressed` / `usb_mtp_superseded` bei Dedup |
| Nicht-Ziele | Kein `diskutil`/Serial-Korrelation in 23.2f (optional später); kein ICA-`SD_Card`-Workaround ohne `ICCameraDevice` |

- [x] `sd_card/mtp/volume_link.rs` — Signatur-Match, Grace, Filter, Supersede-Helfer
- [x] `allowlist::prefers_volume_over_mtp(vendor)`
- [x] `monitor.rs` — `ready_action_cam_drives`, `find_dcim_drives`, `poll_once` Supersede
- [x] `list_mtp_files` → Volume-Redirect wenn abgedeckt
- [x] `macos_ica.rs` — Guard vor ICA-Aufruf
- [x] `AtsImageCapture.m` — vendor-spezifische Browse-Fehlermeldungen
- [x] Unit-Tests (1:1 Dedup, Grace, GoPro unverändert, 2 Volumes + 1 USB kein Dedup)
- [ ] Abnahme: Osmo Action 4 USB → ein Eintrag, kein ICA-Fehler; GoPro USB-only → ICA; SD-Leser + DJI USB → zwei Quellen

> **Hinweis:** 23.2f mildert Symptome (Dedup, Grace). **23.2g** ersetzt die Vendor-„MTP-by-default“-Logik durch eine **Modell-Whitelist (Opt-in)** — siehe unten.

**23.2g — MTP-Modell-Whitelist (Opt-in, Safe-by-default)**

**Status:** ✅ Erledigt (Hardware-Abnahme Osmo/GoPro offen)  
**Abhängigkeiten:** 23.2f (Volume/Dedup), 23.1/23.2 (ICA/WPD)  
**Motivation:** DJI Osmo Action 4 erfordert manuell „File Transfer / OTG“ auf der Kamera; erst danach mountet `/Volumes/…/DCIM`. USB/`ioreg` ist sofort sichtbar → 23.2f-Grace (5 s) reicht nicht → fälschlich `mtp:dji:…` und ICA-Fehler. **Default soll wieder Volume/SD sein** (Phase 7); MTP nur für Modelle, die **nachweislich ohne Mass-Storage-Volume** funktionieren (typisch GoPro).

#### Problem (23.2f reicht nicht)

| Gerät | Nutzer-Workflow | 23.2f-Verhalten | Gewünscht |
|-------|-----------------|-----------------|-----------|
| DJI Osmo Action 4 | USB → Kamera „File Transfer“ tippen → Volume | Grace 5 s → MTP | **Nie MTP**, nur Volume |
| GoPro HERO (kein Volume) | USB → ICA/WPD sofort | OK mit Grace/Dedup | **MTP** (Whitelist) |
| Unbekanntes Modell | Volume oder gar nichts | Vendor-Match → MTP-Risiko | **Volume-only** |

#### Entscheidungen (Architektur-Shift)

| Thema | Entscheidung |
|-------|----------------|
| Default | **Volume/SD only** — wie vor Phase 23; Volume-Monitor unverändert |
| MTP | **Opt-in pro Kameramodell** — nur explizit whitelisted + `usb_camera_import_enabled` |
| Zwei Schichten | **(A) USB-Erkennung** ≠ **(B) MTP freischalten** — Vendor-Match allein öffnet keinen MTP-Pfad |
| Volume gewinnt immer | Auch whitelisted GoPro: gemountetes DCIM → SD-Pfad, **kein** ICA/WPD |
| Kein Vendor-MTP | **Kein** „alle DJI → MTP“; DJI standardmäßig **nicht** auf Whitelist |
| Match | Primär **USB-Produktstring** (`HERO13 Black`, `OsmoAction4`); VID/PID nur ergänzend (GoPro PID-Recycling!) |
| Plattform | Pro Eintrag: `macos: ica` \| `windows: wpd` \| `linux: libmtp` — getrennte Abnahme |
| 23.2f vereinfachen | **`VOLUME_GRACE`**, **`prefers_volume_over_mtp(vendor)`** entfernen; Dedup/Supersede/Volume-Redirect **behalten** |
| Master-Switch | `usb_camera_import_enabled` bleibt; Settings-Text: nur freigegebene Modelle ohne SD-Laufwerk |
| Logging (optional) | `usb_action_cam_volume_only` wenn Action-Cam erkannt, aber nicht whitelisted |
| Patch-Workflow | Neues Modell nur mit Abnahme-Datum + CHANGELOG-Eintrag |
| Nicht-Ziele | Keine Vendor-weite MTP-Freischaltung; keine Grace-Timeout-Rennen; kein Handy-MTP |

#### Entscheidungsfluss

```text
USB am Bus (ioreg / WPD)
        │
        ▼
match_usb_identity (optional) ──► Log / UI-Hinweis „File Transfer wählen“ (DJI)
        │
        ▼
mtp_model_whitelisted(hint, platform)? ──NEIN──► kein mtp:… (warten auf Volume)
        │
       JA
        │
        ▼
passendes Volume mit DCIM-Signatur? ──JA──► nur Volume (23.2f Dedup)
        │
       NEIN
        │
        ▼
MTP-Pfad (ICA / WPD / libmtp)
```

#### MTP-Modell-Whitelist (Startbestand — nur nach Abnahme eintragen)

Modul: `src-tauri/src/sd_card/mtp/mtp_whitelist.rs` (oder Erweiterung `allowlist.rs`)

| ID | Match (Beispiel) | macOS | Windows | Linux | Anmerkung |
|----|------------------|-------|---------|-------|-----------|
| `gopro_hero8_black` | `HERO8` + VID GoPro | ica | wpd | — | Kein Mass-Storage |
| `gopro_hero9_13` | `HERO` + Ziffer + VID GoPro | ica | wpd | — | PID `0x0059` mehrdeutig → Name |
| *(keine DJI Action)* | — | — | — | — | Osmo → nur Volume nach „File Transfer“ |
| *(Insta360 U-Disk)* | — | — | — | — | Bereits Volume-Monitor |

Eintrags-Schema (Vorschlag):

```rust
struct MtpModelEntry {
    id: &'static str,
    vendor: ActionCamVendor,
    product_contains: &'static [&'static str],  // case-insensitive
    vid: Option<u16>,
    pid: Option<u16>,                           // nur wenn eindeutig
    platforms: MtpPlatforms,                    // Bitflags pro OS + Adapter
    verified: &'static str,                       // "YYYY-MM" Abnahme
}
```

API:

- `is_mtp_whitelisted(hint: &UsbDeviceHint) -> bool` — plattformbewusst
- `filter_visible_usb_cameras` nutzt **nur** Whitelist (ersetzt Grace + `prefers_volume_over_mtp`)

#### Aufgaben

**Must-have**
- [x] `mtp_whitelist.rs` — Matcher + Unit-Tests (Produktstring HERO5+, MAX; kein DJI)
- [x] `is_mtp_whitelisted(hint)` / `may_use_mtp_path` — Gate für sichtbare `mtp:`-Sources
- [x] `volume_link::filter_visible_usb_cameras` — Whitelist + `usb_import_mode` (ersetzt Grace)
- [x] Entfernen: `VOLUME_GRACE`, `prefers_volume_over_mtp`, Grace-Map in `volume_link`
- [x] Behalten: Volume-Redirect, Dedup 1:1, Supersede, ICA-Guards
- [x] Config `usb_import_mode`: `auto` | `volume_only` | `mtp_preferred` + Settings-Select + i18n
- [x] Settings/i18n: Kurztext freigegebene Modelle / Volume-only für DJI
- [x] GoPro HERO 5–13 + MAX/FUSION (macOS + Windows); **keine** DJI-Osmo-Einträge

**Sollte mitkommen**
- [x] Log `usb_action_cam_volume_only` für erkannte, nicht-whitelisted Cams
- [x] Unit-Tests: OsmoAction4 auto → kein MTP; GoPro whitelisted; volume_only; mtp_preferred
- [ ] CHANGELOG-Prozess pro neuem Whitelist-Eintrag (Doku in Plan)

**Nice-to-have (später → 23.2h)**
- [ ] Settings-Reiter / Liste **erkannte USB-Geräte** mit Override pro Serial (nicht Modell-Katalog)
- [ ] `verified`-Feld in Logs; `diskutil`/Serial-Dedup (23.2f Stufe B)

**23.2h — USB-Geräte-Overrides (optional, später)**

Pro **erkanntes** Gerät (Serial + Produktname), nicht statischer Modell-Katalog:

- Persistiert in Config: `{ product, serial, mode: auto|volume|mtp }`
- UI unter Einstellungen → SD oder Tab „Kameras“
- Überschreibt globalen `usb_import_mode` / Whitelist für dieses Gerät
- Nur Geräte anzeigen, die schon einmal am USB hingen

**23.3 — Linux**
- [ ] `libmtp` (AppImage klären in `docs/LINUX_BUILD.md`); gleiche Allowlist

**23.4 — Docs / UX**
- [ ] Settings-Kurztext; `ARCHITECTURE.md` MediaSource; Phase-Status in AGENTS

#### Agent-Prompt

```
Implementiere Phase 23.1 aus @docs/phases/open/23-usb-mtp.md
(Windows WPD/MTP Allowlist GoPro/DJI/Insta360 + Staging).
Regeln: @AGENTS.md
Volume-Heuristik NICHT aufweichen. Kein Handy-MTP.
Danach cargo test.
```

#### Referenzen

```
src-tauri/src/sd_card/monitor.rs
src-tauri/src/sd_card/mtp/allowlist.rs
src-tauri/src/sd_card/mtp/volume_link.rs
src-tauri/src/commands/sd_card.rs
src/hooks/useSdCardMonitor.ts
```

---


