# Aero Tandem Studio v2 — Performance-Optimierungsplan

> **Zweck:** Backlog für gezielte Performance-Verbesserungen, **getrennt** vom Feature-Phasenplan (`IMPLEMENTATION_PLAN.md`).
> In jedem Agent-Kontext mit `@docs/optimization_plan.md` referenzieren und **nur ein OPT-Paket** implementieren.

---

## Inhaltsverzeichnis

1. [Regeln](#1-regeln)
2. [Übersicht & Reihenfolge](#2-übersicht--reihenfolge)
3. [Fortschritts-Tracker](#3-fortschritts-tracker)
4. [OPT-Pakete](#4-opt-pakete)
5. [Bewusst nicht in diesem Plan](#5-bewusst-nicht-in-diesem-plan)

---

## 1. Regeln

- **NIEMALS** Dateien im Legacy-Projekt ändern (nur lesen)
- **Kein Feature-Scope:** Keine neuen Phasen aus `IMPLEMENTATION_PLAN.md` anfassen (z. B. Phase 23.1 WPD, Phase 14 ML)
- **Ein OPT pro Session** — Scope nicht erweitern
- Video-Verarbeitung **NUR** über FFmpeg CLI in Rust
- Nach Rust-Änderungen: `cargo test --manifest-path src-tauri/Cargo.toml`
- Nach Frontend-Änderungen: `npm run check` und manuell `npm run tauri dev`
- Verhalten beibehalten; Optimierung darf UX nicht verschlechtern (Ausnahme: dokumentierte „Fast Preview“-Modi)

### Agent-Schnell-Prompt (Vorlage)

```
Implementiere OPT-X aus @docs/optimization_plan.md
Regeln: @AGENTS.md
Nur OPT-X. Danach cargo test && npm run tauri dev.
```

---

## 2. Übersicht & Reihenfolge

| ID | Titel | Impact | Aufwand | Risiko | Abhängigkeiten |
|----|-------|--------|---------|--------|----------------|
| OPT-0 | Performance-Baseline | — | S | — | — |
| OPT-1 | Foto-Preview: Thumbnails statt Full-Res | hoch | S | niedrig | — |
| OPT-10 | Thumbnail-Warming nach Import staffeln | mittel | S | niedrig | — |
| OPT-8 | Startup: Cache-Sweep defer | mittel | S | niedrig | — |
| OPT-2 | Import: paralleles ffprobe + Copy/Probe-Pipeline | hoch | M | mittel | — |
| OPT-3 | Copy-Buffer & optional Hardlink/CoW-Import | hoch | M | mittel | — |
| OPT-7 | Filmstrip/Keyframe-Prefetch | mittel | S | niedrig | — |
| OPT-4 | Thumbnails über HTTP statt Base64-IPC | mittel | M | mittel | — |
| OPT-9 | Encode-Pfad: Stream-Copy & Preview-Reuse UX | hoch | S | niedrig | — |
| OPT-6 | Log-Konsole virtualisieren | niedrig | S | niedrig | — |
| OPT-5 | App.tsx Split + lazy Dialoge | mittel | L | mittel | — |

**Empfohlene Reihenfolge:** OPT-0 → OPT-1 → OPT-10 → OPT-8 → OPT-2 → OPT-3 → OPT-7 → OPT-4 → OPT-9 → OPT-6 → OPT-5

---

## 3. Fortschritts-Tracker

| ID | Status |
|----|--------|
| OPT-0 | ✅ |
| OPT-1 | ✅ |
| OPT-2 | ✅ |
| OPT-3 | ✅ |
| OPT-4 | ✅ |
| OPT-5 | ⬜ |
| OPT-6 | ✅ |
| OPT-7 | ✅ |
| OPT-8 | ✅ |
| OPT-9 | ✅ |
| OPT-10 | ✅ |

---

## 4. OPT-Pakete

---

### OPT-0: Performance-Baseline

**Ziel:** Messbare Ausgangswerte dokumentieren, bevor Optimierungen gemessen werden.

**Impact:** — (Voraussetzung für valide Vorher/Nachher-Vergleiche)  
**Aufwand:** S  
**Risiko:** —  
**Abhängigkeiten:** keine

#### Kontext

- Bottleneck-Analyse (2026-02): FFmpeg Encode/Import dominieren; Frontend `App.tsx` ist Re-Render-Risiko.
- Ohne Baseline ist unklar, ob spätere OPTs wirken.

#### Scope

**In scope:**

- [x] Abschnitt „Baseline“ in dieser Datei (oder `docs/PERF_BASELINE.md`) mit Tabellenwerten → **`docs/PERF_BASELINE.md`**
- [x] Drei feste Szenarien definieren und einmal messen (Stopwatch + optional Rust-Log-Timestamps) → **S1 Import, S2 Preview, S3 Create** (+ S4/S5 ergänzend)
- [x] Plattform notieren (Windows/macOS/Linux), HW-Encoding ja/nein, Clip-Anzahl/-Größe → **Windows 11, libx264, 10×6 MB**

**Out of scope:**

- Code-Änderungen
- Automatisierte Benchmark-CI

#### Mess-Szenarien (Vorlage)

| Szenario | Beschreibung | Metrik |
|----------|--------------|--------|
| S1 Import | 10 Videos (typ. Größe notieren) per Drag&Drop | Sekunden bis Liste vollständig |
| S2 Preview | Preview generieren (Intro an/aus notieren) | Sekunden bis Player spielt |
| S3 Create | Create mit Preview-Reuse vs. ohne | Sekunden bis Erfolg |
| S4 Fotos | 30 Fotos importieren + durchblättern | RAM-Spike / Wechsel-Latenz subjektiv |
| S5 SD-Dialog | SD-Dateiauswahl öffnen (viele Dateien) | Zeit bis Grid scrollbar |

#### Akzeptanzkriterien

- [x] Baseline-Tabelle ausgefüllt (Datum, Plattform, Version) — siehe **`docs/PERF_BASELINE.md`**
- [x] Kein Produktionscode geändert

#### Baseline (Kurzfassung)

Vollständige Tabellen, Fixtures und Wiederholungsanleitung: **`docs/PERF_BASELINE.md`** (2026-08-19, v0.2.17, Windows 11, libx264).

| Szenario | Backend (s) | UI-Schätzung (s) |
|----------|---------------|------------------|
| S1 Import 10×6 MB | 4,45 | ~5,3 |
| S2 Preview (3 Clips, Intro aus) | 10,13 | ~10,5–11 |
| S3 Create mit Preview-Reuse | 0,02 | ~0,5–2 |
| S3 Create ohne Reuse (3 Clips) | 9,76 | ~10–15 |

#### Agent-Prompt

```
Implementiere OPT-0 aus @docs/optimization_plan.md
Regeln: @AGENTS.md
Nur Dokumentation: Baseline messen und in docs/optimization_plan.md (Abschnitt OPT-0) oder docs/PERF_BASELINE.md eintragen.
Kein Produktionscode ändern.
```

---

### OPT-1: Foto-Preview — Thumbnails statt Full-Res

**Ziel:** Foto-Hauptansicht und Strip laden skalierte Thumbnails; Full-Res nur beim Export/Create oder explizit on-demand.

**Impact:** hoch (RAM, Dekodierung, Scroll/Wechsel)  
**Aufwand:** S  
**Risiko:** niedrig  
**Abhängigkeiten:** keine

#### Kontext

- Bottleneck: `PhotoPreview.tsx` nutzt `convertFileSrc` für Hauptbild und alle Strip-Thumbs → Vollauflösung im WebView.
- Backend: `get_media_thumbnail` mit Qualitäten `lq` / `hq` / `preview` existiert (`src-tauri/src/media/thumbnail.rs`).

#### Betroffene Dateien

- `src/components/PhotoPreview.tsx`
- `src/lib/sdCard.ts` (falls `getMediaThumbnail` wiederverwendet)
- Optional: `src/components/PhotoEditor.tsx` (nur prüfen — Editor braucht evtl. Full-Res)

#### Scope

**In scope:**

- [x] Haupt-Preview: `hq` oder `preview`-Thumbnail via `getMediaThumbnail`
- [x] Strip: `lq`-Thumbnails
- [x] Cache-Bust bei `mediaRevision` / Crop/Rotate beibehalten
- [x] Fallback auf `convertFileSrc`, wenn Thumbnail fehlschlägt

**Out of scope:**

- Virtualisierung des Strips (eigenes Backlog, optional in OPT-1 nachziehen wenn >50 Fotos)
- Foto-Editor Full-Res-Logik umbauen (nur dokumentieren wenn unverändert)

#### Akzeptanzkriterien

- [ ] 30 Fotos importieren: deutlich weniger RAM im Task-Manager vs. Baseline
- [ ] Crop/Rotate-Undo zeigt korrektes Bild nach Revision-Bump
- [ ] `npm run check` grün
- [ ] Manuell: Foto wechseln, Strip scrollen, QR auf Foto

#### Agent-Prompt

```
Implementiere OPT-1 aus @docs/optimization_plan.md
Regeln: @AGENTS.md
Nur OPT-1. Danach cargo test && npm run tauri dev.
```

---

### OPT-2: Import — paralleles ffprobe + Copy/Probe-Pipeline

**Ziel:** Video-Import beschleunigen durch parallele Metadaten-Extraktion und optional überlappendes Kopieren/Proben.

**Impact:** hoch  
**Aufwand:** M  
**Risiko:** mittel (Race/Cancel, Progress-Events)  
**Abhängigkeiten:** keine

#### Kontext

- Bottleneck: `import_videos` in `src-tauri/src/commands/video.rs` kopiert sequentiell, danach sequentiell `probe::probe_video`.
- Cancel/Rollback über `rollback_working_import_paths` muss erhalten bleiben.

#### Betroffene Dateien

- `src-tauri/src/commands/video.rs` (`import_videos`)
- `src-tauri/src/video/probe.rs`
- Optional: `src-tauri/src/video/parallel.rs` (Worker-Pool wiederverwenden)
- `src/store/videoStore.ts` (nur wenn Progress-UX angepasst werden muss)

#### Scope

**In scope:**

- [x] ffprobe für N Dateien parallel (2–4 Worker, CPU-only, kein NVENC)
- [x] Progress-Events weiter throtteln (~150 ms)
- [x] Cancel bricht alle Worker ab und rollt Working-Copies zurück
- [x] Rust Unit-Test: parallele Probe-Reihenfolge = Input-Reihenfolge

**Out of scope:**

- Hardlinks (→ OPT-3)
- Thumbnail-Warming (→ OPT-10)
- Foto-Import (separater Pfad)

#### Akzeptanzkriterien

- [ ] S1 Import (10 Clips) messbar schneller als OPT-0-Baseline
- [ ] Import abbrechen (Workflow-Cancel) hinterlässt keinen kaputten Working-Ordner
- [ ] `cargo test` grün

#### Agent-Prompt

```
Implementiere OPT-2 aus @docs/optimization_plan.md
Regeln: @AGENTS.md
Nur OPT-2. Danach cargo test && npm run tauri dev.
```

---

### OPT-3: Copy-Buffer & optional Hardlink/CoW-Import

**Ziel:** Dateikopien beim Import/Working-Session schneller und speicher-effizienter machen.

**Impact:** hoch (GB-Videos)  
**Aufwand:** M  
**Risiko:** mittel (Plattform, Cuts auf Hardlinks)  
**Abhängigkeiten:** keine (OPT-2 unabhängig)

#### Kontext

- `DEFAULT_COPY_BUFFER = 256 KiB` in `src-tauri/src/sd_card/copy_progress.rs`
- Jeder Import = Full Copy nach `aero_studio_preview_*` (`working_session.rs`) — kein Hardlink/CoW

#### Betroffene Dateien

- `src-tauri/src/sd_card/copy_progress.rs`
- `src-tauri/src/storage/working_session.rs`
- Tests in `working_session` / `copy_progress`

#### Scope

**In scope:**

- [x] Copy-Buffer auf SSD-tauglichen Wert erhöhen (z. B. 1–4 MiB), konstant zentral
- [x] **Optional Teil A:** Wenn Quelle und Working-Dir auf gleichem Volume: Hardlink statt Copy (Windows + Unix)
- [x] **Optional Teil B:** Beim ersten Cut/Trim Hardlink → echte Copy „materialisieren“
- [x] Logging wenn Hardlink nicht möglich → Fallback Copy

**Out of scope:**

- SD-Backup-Pfad komplett umbauen (nur gleichen Buffer nutzen)
- NTFS reflink (nur wenn trivial, sonst Hardlink + Copy-Fallback dokumentieren)

#### Akzeptanzkriterien

- [ ] Import großer Datei (>1 GB) messbar schneller oder gleich schnell, nie langsamer
- [ ] Trim/Split auf hardlinked Datei ändert **nicht** Original außerhalb Working-Dir
- [ ] `cargo test` grün; Windows + mindestens eine Unix-Plattform im Test/logisch abgedeckt

#### Agent-Prompt

```
Implementiere OPT-3 aus @docs/optimization_plan.md
Regeln: @AGENTS.md
Nur OPT-3. Danach cargo test && npm run tauri dev.
```

---

### OPT-4: Thumbnails über HTTP statt Base64-IPC

**Ziel:** Thumbnail-URLs über den bestehenden Loopback-Media-Server liefern statt große Base64-Strings per Tauri IPC.

**Impact:** mittel (IPC, JS-Heap, Scroll-Performance)  
**Aufwand:** M  
**Risiko:** mittel (Caching, MIME, Sicherheit lokal OK)  
**Abhängigkeiten:** keine (synergisiert mit OPT-1)

#### Kontext

- `get_media_thumbnail` → `ThumbnailResult { data_url }` (`commands/sd_card.rs`)
- Video nutzt bereits `media/http_server.rs` + `media_file_url`
- SD-Loader: `src/lib/sdThumbnailLoader.ts`

#### Betroffene Dateien

- `src-tauri/src/commands/sd_card.rs`
- `src-tauri/src/media/thumbnail.rs`
- `src-tauri/src/media/http_server.rs` (Thumbnail-Pfade erlauben)
- `src/lib/sdCard.ts`, `src/lib/sdThumbnailLoader.ts`
- `src/components/VideoPlayer.tsx`, `src/store/videoStore.ts` (Poster)

#### Scope

**In scope:**

- [x] Neues Response-Feld z. B. `url` (HTTP) neben oder statt `data_url` — Migration schrittweise
- [x] Frontend bevorzugt HTTP-URL; Fallback `data_url` für Übergang
- [x] Disk-Cache unter `{app_config}/thumbnails/` unverändert nutzen

**Out of scope:**

- Neuer CDN/externer Server
- Video-Streaming-Architektur ändern

#### Akzeptanzkriterien

- [ ] SD-Dateiauswahl: Thumbnails laden flüssig, kein IPC-Megabyte-Stau
- [ ] VideoPlayer-Poster funktioniert
- [ ] `cargo test` + manuell SD-Dialog + Import-Thumbs

#### Agent-Prompt

```
Implementiere OPT-4 aus @docs/optimization_plan.md
Regeln: @AGENTS.md
Nur OPT-4. Danach cargo test && npm run tauri dev.
```

---

### OPT-5: App.tsx Split + lazy Dialoge

**Ziel:** Re-Render-Fläche verkleinern; schwere Dialoge erst bei Bedarf laden.

**Impact:** mittel (UI-Flüssigkeit bei SD/QR/Progress)  
**Aufwand:** L  
**Risiko:** mittel (Regressions in Dialog-Flows)  
**Abhängigkeiten:** keine

#### Kontext

- `src/App.tsx` ~2500+ Zeilen, dutzende Zustand-Subscriptions, eager Imports aller Dialoge
- Kein `React.lazy` / `Suspense` im Projekt
- Schwere Komponenten: `HistoryDialog`, `SettingsDialog`, `SdFileSelector`, `VideoCutter`, `PhotoEditor`

#### Betroffene Dateien

- `src/App.tsx` → Split in `src/components/app/` oder `src/layouts/`
- `src/main.tsx` (Suspense-Boundary)
- Lazy: History, Settings, SetupWizard, SdFileSelector, ggf. Cutter/Editor

#### Scope

**In scope:**

- [ ] `AppShell` / `WorkflowLayout` extrahieren
- [ ] Mindestens 3 Dialoge via `React.lazy` + `Suspense` (Loading-Fallback minimal)
- [ ] Store-Subscriptions in Container-Komponenten verschieben (nicht alles in Root)
- [ ] Kein Verhaltens-Change bei Create/SD/QR-Flows

**Out of scope:**

- Vollständiges Routing (React Router)
- `React.memo` everywhere — nur wo messbar nötig
- i18n-Keys ändern

#### Akzeptanzkriterien

- [ ] React DevTools Profiler: weniger Commit-Dauer bei SD-Progress-Events vs. vorher (notieren)
- [ ] Alle Dialoge öffnen/schließen fehlerfrei
- [ ] `npm run check` grün

#### Agent-Prompt

```
Implementiere OPT-5 aus @docs/optimization_plan.md
Regeln: @AGENTS.md
Nur OPT-5. Danach npm run check && npm run tauri dev.
Kein Feature-Scope aus IMPLEMENTATION_PLAN.md.
```

---

### OPT-6: Log-Konsole virtualisieren

**Ziel:** Log-UI bleibt flüssig bei bis zu 3000 Einträgen.

**Impact:** niedrig (nur wenn Konsole offen)  
**Aufwand:** S  
**Risiko:** niedrig  
**Abhängigkeiten:** keine

#### Kontext

- `logStore.ts`: `MAX_ENTRIES = 3000`
- `LogConsole.tsx`: rendert `filtered.map` ohne Virtualisierung

#### Betroffene Dateien

- `src/components/LogConsole.tsx`
- Optional: leichte Virtualisierungs-Hilfskomponente (kein schweres Dependency ohne Absprache)

#### Scope

**In scope:**

- [x] Windowed rendering (nur sichtbare Zeilen + Overscan)
- [x] Auto-Scroll-Verhalten beibehalten
- [x] Copy/Clear/Filter unverändert funktional

**Out of scope:**

- Log-Backend / Ring-Buffer in Rust
- Throttle von `log-line` Events (optional später)

#### Akzeptanzkriterien

- [ ] Konsole offen + 3000 Zeilen: Scrollen ohne spürbares Ruckeln
- [ ] `npm run check` grün

#### Agent-Prompt

```
Implementiere OPT-6 aus @docs/optimization_plan.md
Regeln: @AGENTS.md
Nur OPT-6. Danach npm run check && npm run tauri dev.
```

---

### OPT-7: Filmstrip/Keyframe-Prefetch

**Ziel:** VideoCutter öffnet schneller durch vorgezogene Filmstrip-/Keyframe-Generierung.

**Impact:** mittel (wahrgenommene Latenz Cutter)  
**Aufwand:** S  
**Risiko:** niedrig  
**Abhängigkeiten:** keine

#### Kontext

- Beim Cutter-Open: `getVideoFilmstrip` + `listVideoKeyframes` (`VideoCutter.tsx`)
- Backend: `filmstrip.rs` — 14 Frames, 4 parallele FFmpeg-Seeks, Disk-Cache

#### Betroffene Dateien

- `src/components/VideoCutter.tsx`
- `src/components/VideoPreview.tsx` (Clip-Auswahl → Prefetch)
- Optional: `src/hooks/useFilmstripPrefetch.ts`

#### Scope

**In scope:**

- [x] Prefetch bei aktiver Clip-Auswahl (idle/debounced), nicht erst bei Dialog-Open
- [x] Cache-Key respektiert `mediaRevision` nach Trim
- [x] Kein Prefetch während Import/Encode (Workflow busy)

**Out of scope:**

- Filmstrip-Frame-Anzahl Algorithmus ändern
- Player-Modus Combined-Preview

#### Akzeptanzkriterien

- [ ] Cutter-Open nach Prefetch: Filmstrip sichtbar deutlich schneller (ggü. Baseline notieren)
- [ ] Kein FFmpeg-Sturm bei 20 Clips in Liste (nur aktiver ± optional nächster)

#### Agent-Prompt

```
Implementiere OPT-7 aus @docs/optimization_plan.md
Regeln: @AGENTS.md
Nur OPT-7. Danach npm run tauri dev.
```

---

### OPT-8: Startup — Cache-Sweep defer

**Ziel:** Splash/Time-to-Interactive verkürzen; Cache-Bereinigung nicht im kritischen Pfad blockieren.

**Impact:** mittel (v. a. viele orphan `aero_studio_preview_*`)  
**Aufwand:** S  
**Risiko:** niedrig  
**Abhängigkeiten:** keine

#### Kontext

- `run_startup_checks` → `cleanup_orphans_only` synchron im Splash (`commands/app.rs`, `App.tsx` boot)
- 350 ms künstliche Pause nach Ready

#### Betroffene Dateien

- `src-tauri/src/commands/app.rs`
- `src/App.tsx` (Splash-Flow)
- `src-tauri/src/storage/cache.rs`

#### Scope

**In scope:**

- [x] Cache-Sweep asynchron nach UI-ready starten (spawn_blocking / Hintergrund-Thread)
- [x] Splash zeigt Ready sobald FFmpeg + Config OK (Sweep optional „im Hintergrund“ loggen)
- [x] Fehler beim Sweep nur loggen, Startup nicht blockieren

**Out of scope:**

- Sweep-Algorithmus grundlegend ändern
- HW-Detect entfernen

#### Akzeptanzkriterien

- [ ] Time-to-Interactive messbar kürzer vs. OPT-0-Baseline
- [ ] Orphans werden weiterhin bereinigt (Log-Eintrag)
- [ ] `cargo test` grün

#### Agent-Prompt

```
Implementiere OPT-8 aus @docs/optimization_plan.md
Regeln: @AGENTS.md
Nur OPT-8. Danach cargo test && npm run tauri dev.
```

---

### OPT-9: Encode-Pfad — Stream-Copy & Preview-Reuse UX

**Ziel:** Nutzer erreichen schnellere Encodes durch klare Defaults und sichtbaren Preview-Reuse — ohne Pipeline-Logik zu brechen.

**Impact:** hoch (Create-Zeit)  
**Aufwand:** S  
**Risiko:** niedrig  
**Abhängigkeiten:** keine (nutzt bestehendes `preview_reuse.rs`)

#### Kontext

- Preview-Reuse bei Create existiert (`export_job.rs`, `previewCacheStore.ts`)
- `intro_mux_mode: stream_copy` vs `reencode` stark performance-relevant
- UI zeigt `reencode_reason` teilweise schon in Preview

#### Betroffene Dateien

- `src/components/VideoPreview.tsx`
- `src/components/settings/` (Encoding/Intro-Tabs)
- `src/App.tsx` (Create-Flow: Reuse-Fingerprint mitgeben)
- Docs/Kommentare in `preview_reuse.rs` (nur wenn nötig)

#### Scope

**In scope:**

- [x] Create sendet `reuse_preview_path` + Fingerprint wenn `previewCacheStore.matches()`
- [x] UI-Hinweis: „Vorschau wird übernommen“ vs. „Neu encodieren weil …“
- [x] Settings: kurze Erklärung Stream-Copy vs Re-Encode (i18n de/en/es-MX)
- [x] Kein Default-Zwang auf stream_copy wenn inkompatibel (weiter Fallback)

**Out of scope:**

- Preview-Encode-Auflösung senken („Fast Preview“ — separates Backlog)
- FFmpeg-Command-Änderungen

#### Akzeptanzkriterien

- [ ] S3 Create mit unveränderter Preview: Create fast sofort (Reuse-Log)
- [ ] Nach Clip-Trim: Reuse blockiert, volle Encode startet
- [ ] i18n-Keys für alle drei Sprachen

#### Agent-Prompt

```
Implementiere OPT-9 aus @docs/optimization_plan.md
Regeln: @AGENTS.md
Nur OPT-9. Danach cargo test && npm run tauri dev.
```

---

### OPT-10: Thumbnail-Warming nach Import staffeln

**Ziel:** Nach Video-Import nicht sofort N parallele FFmpeg-Poster-Extraktionen starten.

**Impact:** mittel (Import-Phase, CPU, Disk)  
**Aufwand:** S  
**Risiko:** niedrig  
**Abhängigkeiten:** synergisiert mit OPT-2

#### Kontext

- `videoStore.addVideos`: für jedes frische Video `getMediaThumbnail(v.path, "preview")` (`videoStore.ts`)
- Kollidiert mit Import/Probe/QR/Encode

#### Betroffene Dateien

- `src/store/videoStore.ts`
- Optional: `src/lib/thumbnailQueue.ts` (kleiner Scheduler)
- `src/components/VideoPlayer.tsx` (on-demand Poster wenn nicht warm)

#### Scope

**In scope:**

- [x] Queue mit max. 1–2 concurrent Preview-Thumbs
- [x] Priorität: aktiver Clip / erster Clip zuerst
- [x] Verzögerung z. B. 500 ms nach Import-Ende
- [x] Player lädt Poster on-demand wenn Queue noch nicht da

**Out of scope:**

- OPT-4 HTTP-Thumbnails (kann später kombiniert werden)
- SD-Thumbnail-Loader (`sdThumbnailLoader.ts`) — separater Pfad

#### Akzeptanzkriterien

- [ ] Import 10 Videos: CPU-Spitze geringer als Baseline
- [ ] Erster Clip zeigt Poster innerhalb akzeptabler Zeit (<3 s nach Import)
- [ ] `npm run check` grün

#### Agent-Prompt

```
Implementiere OPT-10 aus @docs/optimization_plan.md
Regeln: @AGENTS.md
Nur OPT-10. Danach npm run tauri dev.
```

---

## 5. Bewusst nicht in diesem Plan

| Thema | Grund |
|-------|--------|
| Phase 23.1 Windows WPD/MTP | Feature-Phase, siehe `IMPLEMENTATION_PLAN.md` |
| Phase 14 ML Foto-Klassifikation | Eigenes Backlog |
| libmpv statt HTML5 | Architektur-Entscheidung, nicht Quick-Perf |
| QR-Algorithmus / rxing-Tuning | Bereits ends-first optimiert; separater Deep-Dive |
| NVENC-Worker >4 | Hardware-Limit Consumer-GPUs |
| SMB-Upload Parallelismus | Risiko Server/Netz — eigene Analyse nötig |
| „Fast Preview“ 720p/CRF-Modus | Optionales OPT-11 nach OPT-0-Messung |

---

## Referenzen

- **Performance-Baseline (OPT-0):** `@docs/PERF_BASELINE.md`
- Architektur: `@docs/ARCHITECTURE.md`
- Feature-Phasen: `@docs/IMPLEMENTATION_PLAN.md`
- Agent-Regeln: `@AGENTS.md`
- Bereits optimierte Bereiche: `qr/parallel.rs`, `sdThumbnailLoader.ts`, `SdFileSelector.tsx` (Virtualisierung), `preview_reuse.rs`, `video/parallel.rs`
