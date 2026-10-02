# OPT-24 — Kaltstart ohne weiße Fläche + UI bleibt bei großen Importen responsiv

> **Agent-Attach:** Diese Datei (nicht `@docs/opt/ARCHIVE.md` / ganzen Plan).
> Regeln: `@AGENTS.md` · Index: `@docs/optimization_plan.md`

**Status:** ✅ Slice A–F (Code, 2026-10-02); manuelle Abnahme (Kaltstart, Laptop-Last, Export-Dauer) offen  
**Abhängigkeiten:** OPT-5 (App-Split, lazy Dialoge), OPT-6 (Log-Konsole), OPT-8 (Cache-Sweep im Splash), OPT-10/11 (Thumb-Warming, QR-Vorrang)

**Ziel:**

1. **Kaltstart:** Ab dem Moment, in dem das Fenster erscheint, ist der Splash sichtbar (keine weiße Fläche), auch beim ersten Start nach Boot/Install/Update.
2. **Große Importe (10+ Clips, 100+ Fotos) auf schwachen Laptops:** Windows zeigt nie „Keine Rückmeldung“; Hauptansicht und Confirm-Dialoge reagieren auf Klicks innerhalb ~200 ms, auch wenn QR-Scan, Speculative-Create und Thumbnails parallel laufen.

**Impact:** hoch (Feldbetrieb auf Laptops, erster Eindruck beim Start)  
**Aufwand:** L (sechs Slices; **ausnahmsweise in einer Session**, siehe unten)  
**Risiko:** niedrig–mittel (Slice B ändert Command-Signaturen, Slice C Prozesspriorität/Threads)

> **Session-Regel (Ausnahme, vom User freigegeben):** Alle Slices A–F werden **in einer Session** umgesetzt.
> Reihenfolge einhalten, nach jedem Slice `cargo test` bzw. `npm run check` grün halten.
> Kein OPT-21 / OPT-23 / Phase-Scope mischen.

---

#### Produktentscheidungen (fest)

| # | Thema | Entscheidung |
|---|--------|--------------|
| P1 | Kein Main-Thread-I/O | Kein `#[tauri::command]` ohne `async` darf Dateisystem, Netz (SMB), Prozesse (FFmpeg, PowerShell) oder SQLite-Schreibzugriffe mit potenziell großer Datenmenge ausführen. Synchron erlaubt: reine Getter auf Mutex/Atomics/Ring-Buffer. |
| P2 | Hintergrund ist Hintergrund | Alle FFmpeg-/ffprobe-Kindprozesse laufen mit **niedrigerer Priorität** als die App (Windows `BELOW_NORMAL_PRIORITY_CLASS`, Unix `nice +5`). Final-Export (`create_job`) ebenfalls — Durchsatz geht kaum verloren, UI gewinnt. |
| P3 | CPU-Budget statt fixer Zahlen | Worker-Zahlen leiten sich aus `available_parallelism()` ab; kein Hintergrund-Pool darf allein alle Kerne belegen. |
| P4 | Events gedrosselt | Fortschritts-Events ≤ 10 Hz pro Quelle; Phasenwechsel (`start`, `hit`, `done`, `error`, `cancelled`) immer sofort. |
| P5 | Splash ohne JS | Ein statischer Boot-Splash in `index.html` (Inline-CSS, Theme aus `localStorage`) überbrückt bis zum React-Splash — optisch identisch, nahtloser Übergang. |
| P6 | Keine neuen Settings-Toggles | Verhalten ist automatisch; nur Logs. |
| P7 | Keine Verhaltensänderung | Ergebnisse (Validierung, Probe, Export, QR-Treffer) bleiben identisch; nur Ausführungsort/-zeitpunkt ändert sich. |

---

#### Ist-Befunde (Review 2026-10-02)

| # | Befund | Ort | Folge |
|---|--------|-----|-------|
| F1 | Fenster sofort sichtbar, keine `backgroundColor`; `index.html` nur `<div id="root">` | `tauri.conf.json`, `index.html` | Weiße Fläche bis WebView2 + Bundle + React fertig |
| F2 | Splash ist React-Komponente; davor: 1,2 MB Haupt-Bundle parsen, `await initI18n()` | `main.tsx`, `SplashScreen.tsx` | Kaltstart (Defender-Scan, kalter Datei-Cache, WebView2-Profil) wirkt wie Hänger |
| F3 | Alle drei Locales statisch im Bundle (de 115 KB, en 106 KB, es-MX 115 KB) | `src/i18n/index.ts` | ~220 KB unnötig geparst |
| F4 | Sync-Commands mit I/O laufen in Tauri 2 **auf dem Main-Thread** (Liste siehe Slice B) | `commands/*.rs` | „Keine Rückmeldung“ bei langsamer Platte / SMB / Defender |
| F5 | `validate_create_job` macht `fs::metadata` pro Video, läuft bei jeder Formular-/Listenänderung (200 ms Debounce) | `useCreateValidation.ts`, `export_job.rs` | Wiederholte Main-Thread-Blocker während Import/Speculative |
| F6 | `probe_create_output_folder` liest Speicherort (oft SMB) synchron vor Confirm-Dialogen | `App.tsx` (Create-Flow), `folder_conflict.rs` | Freeze in der Confirm-Phase |
| F7 | `run_startup_checks` sync (FFmpeg-Suche, HW-Detect, Orphan-Sweep, `ConfigStore::open_default()` erneut) | `commands/app.rs` | Splash-Spinner friert ein |
| F8 | FFmpeg-Kinder laufen mit normaler Priorität (nur `CREATE_NO_WINDOW`) | `util/process.rs`, `video/ffmpeg.rs::apply_noninteractive`, `thumbnail.rs`, `filmstrip.rs`, `frame_extract.rs` | WebView2-Renderer + Main-Thread verhungern |
| F9 | QR-Scan fix 4 Worker (unabhängig von Kernen); parallel dazu Speculative-Encode, Thumbs, Filmstrip | `commands/qr.rs`, `qr/parallel.rs` | 4-Kern-Laptop zu 100 % ausgelastet |
| F10 | libx264-Parallel-Encode: `cpu/2` Worker, jeder FFmpeg ohne `-threads` → nutzt alle Kerne | `video/parallel.rs::calculate_optimal_workers`, Encode-Args | Massive Überbuchung (z. B. 2 × 8 Threads auf 4 Kernen) |
| F11 | `qr-scan-progress` ungedrosselt pro Frame aus bis zu 4 Workern | `commands/qr.rs::make_progress_cb` | IPC-Flut über Main-Thread |
| F12 | `encode-progress` → `setTaskProgress`/`setPercent`/`setStatus` direkt in `App` (~66 `useState`) | `App.tsx` (`listen("encode-progress")`) | Jedes Event rendert die gesamte App neu |
| F13 | Jede Logzeile = eigenes `log-line`-Event; `appendEntry` macht `some()` + Array-Kopie (bis 3000) pro Zeile | `lib.rs::set_log_emitter`, `logStore.ts` | Viele kleine Re-Renders/IPC bei Import-Bursts |

---

#### Slices

| Slice | Titel | Befunde | Impact | Aufwand |
|-------|-------|---------|--------|---------|
| **A** | Boot-Splash + Fensterfarbe + schlanker Start-Bundle | F1, F2, F3 | hoch | S–M |
| **B** | Kein I/O auf dem Main-Thread (Sync → async + `spawn_blocking`) | F4, F5, F6, F7 | hoch | M |
| **C** | Prozesspriorität + CPU-Budget | F8, F9, F10 | hoch | M |
| **D** | Event-Drosselung (QR, Encode) | F11 | mittel | S |
| **E** | Fortschritts-State aus `App` in Store | F12 | mittel | M |
| **F** | Log-Events bündeln | F13 | niedrig–mittel | S |

**Reihenfolge:** A → B → C → D → E → F (B vor E, damit Create-Flow-Änderungen nicht kollidieren).

---

#### Slice A — Boot-Splash + Fensterfarbe + schlanker Start-Bundle

**Ziel:** Kein weißer Frame; Splash-Optik ab dem ersten Paint.

##### Entscheidungen

| # | Thema | Entscheidung |
|---|--------|--------------|
| A1 | Fensterfarbe | `tauri.conf.json` + `tauri.macos.conf.json`: `"backgroundColor"` auf den Dark-Hintergrund `#0c1210` setzen (verhindert Weiß-Blitz vor erstem Paint). Wenn das Light-Theme sichtbar flackert: Fenster mit `"visible": false` starten und in `main.tsx` nach dem ersten Frame des Boot-Splash `getCurrentWindow().show()` aufrufen (Fallback-Timer 1,5 s in Rust `setup`, damit das Fenster nie unsichtbar bleibt). Variante im Code dokumentieren. |
| A2 | Statischer Boot-Splash | `index.html`: `<div id="boot-splash">` außerhalb von `#root` mit Inline-`<style>` — Hintergrund wie `SplashScreen` (radial gradient, `--ats-bg`/`--ats-bg-glow-1` für light **und** dark hart kodiert), Logo `/logo.png`, CSS-Spinner, Text „Aero Tandem Studio“. Ein Inline-`<script>` (kein Modul, < 15 Zeilen) liest `localStorage["ats-theme"]` / `prefers-color-scheme` und setzt `class="dark"` auf `<html>`, bevor gepaintet wird. |
| A3 | Übergang | `main.tsx` entfernt `#boot-splash` erst, wenn der React-`SplashScreen` gemountet ist (z. B. `useEffect` in `SplashScreen` oder `requestAnimationFrame` nach `render`). Kein sichtbarer Sprung (gleiche Position von Logo/Spinner). |
| A4 | Locales lazy | `de.json` bleibt statisch (Fallback + Default). `en`/`es-MX` per `import()` nachladen, bevor `i18n.changeLanguage` bzw. in `initI18n` aufgerufen wird (`i18n.addResourceBundle`). `tr()` bleibt synchron nutzbar. `setUiLanguage` lädt bei Bedarf nach. |
| A5 | Bundle-Check | Einmal `npx vite-bundle-visualizer` (oder `rollup-plugin-visualizer` temporär, **nicht** committen) laufen lassen; offensichtliche Großbrocken, die erst nach dem Splash gebraucht werden (z. B. selten genutzte Views), per `lazy()` aus dem Haupt-Chunk lösen — nur wenn risikolos. Ergebnis (Größe vorher/nachher) in `docs/PERF_BASELINE.md` notieren. |
| A6 | Rust-Setup | `run_startup_checks` nutzt den Config-Cache aus `ConfigState` statt `ConfigStore::open_default()` erneut zu öffnen. |

##### Scope

- [x] `tauri.conf.json`, `tauri.macos.conf.json`: `backgroundColor` (ggf. `visible: false` + Show-Logik)
- [x] `index.html`: Boot-Splash + Theme-Inline-Script
- [x] `main.tsx` / `SplashScreen.tsx`: Boot-Splash entfernen, sobald React-Splash steht
- [x] `src/i18n/index.ts`: `en`/`es-MX` lazy, `de` statisch
- [x] `commands/app.rs`: Config aus State (A6)
- [x] Haupt-Chunk-Größe vorher/nachher in `PERF_BASELINE.md`

**Out of scope:** Defender-Ausschlüsse, Installer-Änderungen, Code-Signing.

##### Akzeptanz

- [ ] Kaltstart Windows (nach Reboot): kein weißer Frame; Boot-Splash → React-Splash ohne sichtbaren Sprung, light + dark
- [ ] Sprache `en` / `es-MX` beim Start korrekt (kein deutscher Flash im React-Splash, außer bei echter Ladeverzögerung < 1 Frame akzeptabel)
- [ ] Sprachwechsel in Settings funktioniert für alle drei Sprachen
- [x] Haupt-Chunk um ≥ 200 KB kleiner (1.263,24 → 1.057,42 kB, −205,8 kB)
- [ ] macOS: Traffic-Lights/Overlay unverändert; Linux: AppImage startet unverändert

---

#### Slice B — Kein I/O auf dem Main-Thread

**Ziel:** P1 durchsetzen. Ein blockierender Datei-/Netzzugriff blockiert höchstens einen Blocking-Pool-Thread, nie die Event-Loop.

##### Entscheidungen

| # | Thema | Entscheidung |
|---|--------|--------------|
| B1 | Muster | `pub async fn …(…) -> Result<T, String>` + `tauri::async_runtime::spawn_blocking(move \|\| { … }).await.map_err(\|e\| e.to_string())?` (wie `get_media_thumbnail`). `State<'_, ConfigState>`: benötigte Werte **vor** `spawn_blocking` aus dem Cache klonen; keine Mutex-Guards in die Closure. |
| B2 | Rückgabetyp | Async-Commands mit `State<'_>` müssen `Result` liefern (Tauri-Anforderung). Wo bisher `T` direkt zurückkam, Frontend-Wrapper in `src/lib/tauri.ts` / `sdCard.ts` / `vorgangFolderProbe.ts` unverändert lassen (Fehler → bisheriges Fallback-Verhalten). |
| B3 | Liste umstellen | siehe Tabelle unten |
| B4 | Synchron bleiben | Reine Getter: `get_config`, `get_app_info`, `get_recent_logs`, `get_log_min_level`, `clear_log_buffer`, `has_*_undo`, `list_*_marks`, `clear_*_undo`, `discard_*_undo_for_path`, `cancel_*`, `reset_*_cancel`, `resolve_*` (Channel-Send), `speculative_create_status`, `get_sd_status`, `get_media_server_base`, `get_working_dir`, `preview_frame_extract_times`, `get_updater_status`, `get_updater_install_hint`, `peek/consume_post_update_restart`, `stop_sd_monitor`. |
| B5 | Validierung entprellen | `useCreateValidation`: höchstens **ein** `validateCreateJob` gleichzeitig; neue Anfrage während laufender → nur letzte nachziehen (Latest-wins). Debounce 200 ms bleibt. |
| B6 | Guard-Test | Rust-Unit-Test, der die Quelltexte `src/commands/*.rs` + `src/updater/mod.rs` liest und für jede `#[tauri::command]`-`pub fn` (ohne `async`) prüft, dass der Name in einer Allowlist (B4) steht. Neue Sync-Commands schlagen damit im Test fehl. |

**Umzustellende Commands (B3):**

| Datei | Commands |
|-------|----------|
| `commands/app.rs` | `run_startup_checks`, `cleanup_cache`, `measure_cache`, `probe_clear_local_job_folders`, `clear_local_job_folders`, `probe_clear_local_backup_folders`, `clear_local_backup_folders`, `run_auto_cleanup`, `set_log_min_level` (schreibt Config), `focus_main_window_after_update` nur falls I/O — sonst B4 |
| `commands/video.rs` | `get_hw_info`, `validate_create_job`, `probe_create_output_folder` |
| `commands/vorgang_history.rs` | `delete_vorgaenge`, `probe_vorgang_folders`, `reconcile_stale_uploads`, `set_vorgang_upload_state`, `preflight_vorgang_upload`, `resync_vorgang_delivery_list`, `delete_vorgang_extra_files` |
| `commands/sd_card.rs` | `start_sd_monitor`, `scan_sd_drives`, `clear_sd_files`, `decline_sd_backup`, `eject_sd_card`, `delete_processed_files`, `purge_processed_files` |
| `commands/media.rs` | `delete_working_copy` |
| `commands/config.rs` | `save_config`, `reload_config`, `reset_config`, `get_config_paths` |
| `commands/qr.rs` | `discard_qr_preview_file` |

> Vor dem Umstellen jeden Command kurz lesen: Wenn er nachweislich nur Speicher liest, in B4 verschieben statt umbauen. Bestehende `async fn`, die intern **ohne** `spawn_blocking` blockierende FS-/Netz-Calls machen (z. B. `import_videos`, `import_photos`, `expand_media_paths`, `get_file_sizes`), mitprüfen und bei Bedarf ebenfalls in `spawn_blocking` packen (blockiert sonst Tokio-Worker).

##### Scope

- [x] Alle Commands aus B3 umgestellt; Frontend-Aufrufer unverändert lauffähig
- [x] `useCreateValidation.ts`: Latest-wins (B5)
- [x] Guard-Test (B6)
- [x] `cargo test` + `npm run check`

**Out of scope:** Semantik der Validierung/Probes, SMB-Logik (OPT-23).

##### Akzeptanz

- [ ] Speicherort auf langsamem/getrenntem SMB-Share: Klick „Erstellen“ → Fenster bleibt verschiebbar, Spinner/Buttons reagieren; Ergebnis wie vorher
- [ ] Splash-Spinner dreht während `run_startup_checks` durchgehend
- [ ] Historie öffnen mit vielen Vorgängen auf SMB: kein „Keine Rückmeldung“
- [ ] Guard-Test schlägt fehl, wenn testweise ein neuer `pub fn`-Command ohne Allowlist-Eintrag hinzugefügt wird

---

#### Slice C — Prozesspriorität + CPU-Budget

**Ziel:** Hintergrundarbeit nimmt sich Rechenzeit nur, wenn UI/WebView sie nicht brauchen; keine Überbuchung der Kerne.

##### Entscheidungen

| # | Thema | Entscheidung |
|---|--------|--------------|
| C1 | Priorität zentral | `util/process.rs`: neue Funktion `apply_background_priority(cmd: &mut Command)`. Windows: `creation_flags(CREATE_NO_WINDOW \| BELOW_NORMAL_PRIORITY_CLASS)` (`0x0800_0000 \| 0x0000_4000`) — **Achtung:** `creation_flags` überschreibt; Flags kombinieren, nicht zweimal setzen. Unix: `pre_exec` mit `libc::nice(5)` (Fehler ignorieren). Neue Hilfsfunktion `apply_ffmpeg_spawn_defaults` = no-window + background priority. |
| C2 | Anwendung | Alle FFmpeg/ffprobe-Spawns: `video/ffmpeg.rs::apply_noninteractive`, `media/thumbnail.rs`, `media/filmstrip.rs`, `media/frame_extract.rs`, `video/hw_accel.rs` (Probe-Encodes), `video/probe*.rs`. PowerShell/eject/auto_mount/udisks **nicht** (kurz, interaktiv relevant). |
| C3 | CPU-Budget-Helper | Neues Modul `util/cpu_budget.rs`: `cpu_count()` (cached `available_parallelism`), `background_workers(max: usize) -> usize` = `(cpu / 2).clamp(1, max)`, `ffmpeg_threads_per_worker(workers) -> usize` = `(cpu / workers).max(1)`. Unit-Tests für 2/4/8/16 Kerne. |
| C4 | QR-Worker | `commands/qr.rs`: `workers = if parallel { cpu_budget::background_workers(4) } else { 1 }` (4-Kern-Laptop → 2). Wenn gleichzeitig Speculative-Create aktiv ist (`speculative_create_status` busy): QR-Worker zusätzlich auf max. 1 begrenzen — QR-Treffer bleibt Priorität (OPT-11), aber nur ein Decoder. |
| C5 | libx264-Threads | Bei Software-Encode mit `workers > 1` (`video/parallel.rs`): FFmpeg-Args erhalten `-threads N` mit `N = ffmpeg_threads_per_worker(workers)`. HW-Encode (NVENC/VideoToolbox) unverändert. **Rust-Unit-Tests** für die Arg-Generierung (Pflicht laut AGENTS.md). |
| C6 | Frontend-Queues | Unverändert lassen (`photoThumbnailQueue` 4/2, `thumbnailQueue` 2, `filmstripPrefetch` 1) — Priorität (C1) reicht. Optional: `photoThumbnailQueue` drosselt auf 2, solange `encode-progress`-Jobs laufen; nur wenn trivial. |

##### Scope

- [x] `util/process.rs`: `apply_background_priority`, `apply_ffmpeg_spawn_defaults` + Tests (callable, Flag-Kombination als Konstante testbar)
- [x] `util/cpu_budget.rs` + Tests
- [x] Alle FFmpeg-Spawn-Stellen (C2) umgestellt
- [x] QR-Worker (C4), libx264-`-threads` (C5) + FFmpeg-Arg-Tests
- [x] `cargo test`

**Out of scope:** Encoder-Wahl, Qualitäts-/RC-Parameter (OPT-21), Upload-Worker (OPT-15).

##### Akzeptanz

- [ ] Task-Manager (Details): `ffmpeg.exe` Priorität „Niedriger als normal“
- [ ] 4-Kern-Laptop, Import 10 Clips + 100 Fotos mit Auto-QR + Speculative: UI reagiert, kein „Keine Rückmeldung“
- [ ] Export-Dauer auf Referenz-PC (libx264, S3 aus `PERF_BASELINE.md`) nicht mehr als +10 % langsamer; Messung notieren
- [ ] NVENC-Pfad unverändert (Args-Diff = nur Prozesspriorität)

---

#### Slice D — Event-Drosselung

**Ziel:** P4 — IPC-Last über den Main-Thread begrenzen.

##### Entscheidungen

| # | Thema | Entscheidung |
|---|--------|--------------|
| D1 | Throttle-Helper | `util/emit_throttle.rs`: `Throttle { min_interval, last: Mutex<HashMap<Key, Instant>> }` mit `should_emit(key, force) -> bool`. Unit-Tests mit injizierbarer Zeit (oder kleinem Intervall + `sleep`). |
| D2 | QR | `make_progress_cb`: Key = `path`; Phasen `extract`/`fast`/`thorough`/`frame` max. 8 Hz pro Pfad; alle anderen Phasen (`start`, `hit`, `done`, `miss`, `error`, `cancelled`) `force`. Letzter Frame-Stand einer Datei geht vor `done` immer raus. |
| D3 | Encode | Gemeinsame Emit-Funktion für alle `emit("encode-progress", …)`-Stellen (`commands/video.rs`, `commands/vorgang_history.rs`): Key = `task_id` (0 = overall); max. 10 Hz; `force` bei Statuswechsel (`status` ≠ letzter Status), `percent >= 100`, Fehler, Abbruch. |

##### Scope

- [x] `util/emit_throttle.rs` + Tests
- [x] QR- und Encode-Emit umgestellt
- [x] `cargo test`

##### Akzeptanz

- [ ] QR-Scan über 100 Fotos: Grid-Fortschritt flüssig, Treffer sofort sichtbar
- [ ] Encode-Fortschrittsbalken erreicht zuverlässig 100 % / „Fertig“ (kein hängender Endstand)

---

#### Slice E — Fortschritts-State aus `App` in Store

**Ziel:** Ein Progress-Event rendert nur die Fortschrittsanzeige, nicht die ganze App.

##### Entscheidungen

| # | Thema | Entscheidung |
|---|--------|--------------|
| E1 | Store | Neuer Zustand-Store `src/store/progressStore.ts`: `percent`, `status`, `taskProgress`, `createJobPlan` (sofern nur für Anzeige), plus Actions (`reset`, `applyEncodeProgress(payload)`). Die Logik aus dem `listen("encode-progress")`-Handler in `App.tsx` wandert **1:1** in `applyEncodeProgress` (inkl. `sessionCancelRequestedRef`-Check → als Store-Flag oder Parameter). |
| E2 | Listener | `useEncodeProgressListener()`-Hook (einmal in `App` gemountet) ruft nur `useProgressStore.getState().applyEncodeProgress`. `App` selbst abonniert **keine** hochfrequenten Felder. |
| E3 | Konsumenten | Komponenten, die Fortschritt anzeigen, lesen per Selector aus dem Store. `App` liest nur, was für Logik nötig ist (z. B. `busy`) — wenn möglich über `getState()` in Callbacks statt Subscription. |
| E4 | Verhalten | Reset-Punkte (`resetProgress`, Append-Start, Cancel) unverändert, nur Ziel ist der Store. |

##### Scope

- [x] `progressStore.ts`, `useEncodeProgressListener`
- [x] `App.tsx`: Progress-`useState`s + Listener entfernt, Konsumenten umgestellt
- [x] `npm run check`

**Out of scope:** Weitere App-Splits jenseits des Fortschritts-State.

##### Akzeptanz

- [ ] React DevTools Profiler während Export: `App` rendert nicht pro Progress-Event
- [ ] Fortschritt, Per-Clip-Balken, Abbruch, Append und Fehlerpfade verhalten sich wie vorher

---

#### Slice F — Log-Events bündeln

**Ziel:** Logs belasten IPC und React nicht bei Bursts.

##### Entscheidungen

| # | Thema | Entscheidung |
|---|--------|--------------|
| F1 | Batch-Emit | `lib.rs` / `storage/logging.rs`: Log-Emitter sammelt Einträge in einem Puffer; ein Hintergrund-Thread sendet alle 250 ms **ein** Event `log-lines` (`Vec<LogEntry>`) — nur wenn Puffer nicht leer. `ERROR` darf sofort flushen. Ring-Buffer + Datei-Log unverändert. |
| F2 | Frontend | `useLogListener`: `listen<LogEntry[]>("log-lines")` → `appendEntries(batch)`. `logStore.appendEntries`: Dedupe über `lastId` (IDs sind monoton) statt `entries.some(...)`; eine Array-Kopie pro Batch. Unread-Error-Zählung pro Batch. Altes `log-line`-Event entfernen. |

##### Scope

- [x] Rust Batch-Emitter + Test (Batch wird gebildet, Reihenfolge stabil)
- [x] `useLogListener.ts`, `logStore.ts`
- [x] `cargo test` + `npm run check`

##### Akzeptanz

- [ ] Log-Konsole zeigt alle Einträge in richtiger Reihenfolge; Error-Badge zählt korrekt
- [ ] Import-Burst: höchstens ~4 `log-lines`-Events/s

---

#### Umsetzungsnotizen (Abweichungen)

- **A1:** Variante 1 — Fenster sichtbar + `backgroundColor`; kein `visible: false` (Kommentar in `index.html`).
- **A5:** Lazy: `SuccessDialog`, `CreateSuccessDialog`, `ReencodeConfirmDialog`, `UpdateDialog`, `BulkUploadSummaryDialog` (`components/app/lazyDialogs.tsx`). `LogConsole` bleibt im Haupt-Chunk (`SettingsCluster` importiert `LogConsoleToggleButton` statisch).
- **B:** `start_sd_monitor` bleibt sync (Window-Subclass muss auf dem UI-Thread installiert werden); `decline_sd_backup` / `clear_sd_files` sind reine Speicher-Ops → Allowlist. `get_sd_status` macht Laufwerks-I/O (`find_dcim_drives`) → async statt B4.
- **C6:** optionale Thumb-Queue-Drosselung nicht umgesetzt.

---

#### Gesamt-Abnahme (nach A–F)

- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` grün
- [ ] `npm run check` grün
- [ ] `npm run tauri dev`: Start, Import, QR, Speculative, Create, Historie, Settings funktionieren
- [ ] Langsamer Windows-Laptop: Kaltstart ohne weiße Fläche; Import 10+ Clips + 100+ Fotos ohne „Keine Rückmeldung“ (Haupt- und Confirm-View)
- [ ] Messwerte (Haupt-Chunk-Größe, Export-Dauer S3, Kaltstart bis Splash) in `docs/PERF_BASELINE.md`
- [ ] Tracker in `docs/optimization_plan.md` + `AGENTS.md` aktualisiert

---

#### Schnell-Prompt

```
Implementiere OPT-24 (alle Slices A–F) aus @docs/opt/open/24-startup-ui-responsiveness.md
Regeln: @AGENTS.md
Ausnahme: alle Slices in dieser Session, Reihenfolge A → F.
Danach cargo test --manifest-path src-tauri/Cargo.toml && npm run check && npm run tauri dev.
```
