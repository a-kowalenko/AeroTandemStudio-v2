# OPT-28 — Video-Thumbnails + QR-Arbeitskopie-Löschen (Stabilität)

> **Agent-Attach:** Diese Datei (nicht `@docs/opt/ARCHIVE.md` / ganzen Plan).  
> Regeln: `@AGENTS.md` · Index: `@docs/optimization_plan.md`

**Status:** ✅ Teil A (Code) · ✅ Teil B (Code)  
**Abhängigkeiten:** OPT-10 (Preview-Thumbnail-Queue), Phase 52 (Foto-Orientierung / Thumb-Cache-Rev)

**Ziel:** Keine fehlenden Video-Poster bei **Kurzclips** (GoPro HEVC); keine **Log-Flut** durch parallele FFmpeg-Thumbs; QR-Cleanup löscht Arbeitskopien **zuverlässig** (Windows file lock) ohne Speculative/Fingerprint-Chaos.

**Impact:** mittel–hoch (Feldbetrieb SD-Dialog + QR-Auto-Remove)  
**Aufwand:** A: S–M · B: S–M  
**Risiko:** niedrig (additive Fallbacks, kein Export-Pfad)

> **Session-Regel:** **Teil A** und **Teil B** getrennt — je eine Session.

**Hintergrund (Logs 2026-10-17, Harry-PC):**

- `Thumbnail fehlgeschlagen … FFmpeg finished but thumbnail file is missing` — GX012212/213 (~0,36 s HEVC).
- `Löschen fehlgeschlagen … os error 32` nach QR-Treffer → fälschlich „nicht im Arbeitsordner“ → 11 importiert / 10 im Pool → `speculative_miss_gate`.

---

## Teil A — Video-Thumbnails (Kurzclips + Dedup)

### Ist-Zustand

| Thema | Code / Verhalten |
|--------|------------------|
| Seek | `extract_video_frame_with_ffmpeg`: fest `-ss 0.5` vor Input, Fallback `0.1` — **ohne** Dauer-Check |
| Fehlerbild | FFmpeg exit 0, JPEG fehlt → generische Meldung „file is missing“ |
| Dedup | `previewThumbnailQueue` (FE) dedupliziert per `path+bust+quality`; **SD-Liste** (`sdThumbnailLoader`) ruft `get_media_thumbnail` **parallel** → viele Läufe auf **demselben Pfad** |
| Logging | Jeder Fehlversuch → `[WARN] Thumbnail fehlgeschlagen` |

### Soll-Verhalten

1. Kurzclips (&lt; ~1 s): zuerst Frame bei **t = 0** (kein Seek über Clip-Ende).
2. Erfolg ohne Output-Datei → **nächste Strategie**, nicht sofort finaler Fehler.
3. Pro `(path, quality)` maximal **ein** FFmpeg-Extract gleichzeitig (Rust-In-Flight).
4. FE: nach N Fehlversuchen **negative cache** → Placeholder, kein Endlos-Retry / Log-Spam.
5. Erstes WARN pro `(path, quality)` pro Session; weitere unterdrückt oder DEBUG.

### Slices (Teil A)

| Slice | Titel | Inhalt |
|-------|-------|--------|
| **A1** | Dauer-aware Seek | `seek_seconds_for_duration` + erweiterte Fallback-Kette in `thumbnail.rs`; optional leichte Dauer via `ffmpeg_probe_stderr` + `parse_duration` (nur Cache-Miss) |
| **A2** | In-Flight Dedup (Rust) | `generate_thumbnail_cached_with_ffmpeg`: wait/coalesce pro `(canonical_path, quality)` |
| **A3** | FE negative cache | `sdThumbnailLoader`: max Retries für lokale Dateien, `failedPaths` Set bis Identity-Wechsel |
| **A4** | Log drosseln | `get_media_thumbnail`: session/process map „already warned“ |

### Dateien (Teil A)

| Datei | Änderung |
|-------|----------|
| `src-tauri/src/media/thumbnail.rs` | Seek-Helfer, Fallbacks, Tests |
| `src-tauri/src/commands/sd_card.rs` | Warn-Drossel |
| `src/lib/sdThumbnailLoader.ts` | Retries + negative cache |

### Tests / Abnahme (Teil A)

- [x] `cargo test` — Unit-Tests `seek_seconds_for_duration` (0.36, 0, unknown, ≥ 1.0)
- [x] `npm run check`
- [ ] Manuell: SD mit GoPro-Kurzclip(s); Poster oder Placeholder, **≤ 1 WARN** pro Datei
- [ ] Manuell: SD-Dialog 500+ Dateien — kein WARN-Sturm auf 2 problematische MP4

### DoD Teil A

- [x] A1–A4 implementiert
- [x] Tests grün, Check grün
- [ ] Manuell Kurzclip + SD-Liste abgenommen

**Agent-Prompt:**

```
Implementiere OPT-28 Teil A aus @docs/opt/open/28-thumb-delete-stability.md
Regeln: @AGENTS.md
Nur Teil A. Danach cargo test && npm run check.
```

---

## Teil B — QR-Arbeitskopie löschen (Windows lock + Speculative)

### Ist-Zustand

| Thema | Verhalten |
|--------|-----------|
| Delete | `delete_owned_file` → `false` bei Lock **und** bei „nicht im Ordner“ |
| Logging | `delete_working_copy_blocking`: bei `false` immer „Löschen übersprungen (nicht im Arbeitsordner)“ — **irreführend** bei error 32 |
| Timing | `maybeRemoveQrVideo` → sofort `removeVideo` → `deleteWorkingCopy` während Thumbnail/Probe/Player noch offen |
| Folge | Datei physisch da, UI-Liste kürzer → Speculative-Fingerprint / Clip-Anzahl mismatch |

### Soll-Verhalten

1. Delete-Ergebnis **typisiert**: `Deleted` | `NotOwned` | `Failed(reason)`.
2. Windows **sharing violation (32)**: Retry mit Backoff; optional deferred queue.
3. Vor QR-Remove: `previewThumbnailQueue.awaitIdleForPath(path)` (Timeout, dann Retry).
4. Optional strikt: Clip erst aus UI entfernen, wenn Delete `Deleted` (oder nach Timeout + Retry).

### Slices (Teil B)

| Slice | Titel | Inhalt |
|-------|-------|--------|
| **B0** | Logging / API | `DeleteWorkingCopyResult`, korrekte WARN/INFO in `media.rs` |
| **B1** | Retry (Rust) | `delete_owned_file`: 3–5× Backoff bei lock |
| **B2** | QR idle gate | `thumbnailQueue.awaitIdleForPath`; `qrCleanup.maybeRemoveQrVideo` |
| **B3** | Speculative konsistent | Bei persistentem Delete-Fail: Speculative invalidieren oder Clip in Liste behalten (minimal) |

### Dateien (Teil B)

| Datei | Änderung |
|-------|----------|
| `src-tauri/src/storage/working_session.rs` | Retry, Result-Typ |
| `src-tauri/src/commands/media.rs` | Invoke + Logging |
| `src/lib/thumbnailQueue.ts` | `awaitIdleForPath` |
| `src/lib/qrCleanup.ts` | await vor remove |
| `src/lib/tauri.ts` | Return-Typ Delete (falls nötig) |

### Tests / Abnahme (Teil B)

- [x] `cargo test` + `npm run check`
- [ ] Manuell: 10+ DJI-Clips, QR auf Clip 1, `qr_remove_video_after_scan` an → kein error 32, korrekte Video-Anzahl für Speculative (Sabrina-Szenario)

### DoD Teil B

- [x] B0–B3 implementiert
- [x] Tests/Check grün
- [ ] Manuell QR-Remove + Speculative abgenommen

**Agent-Prompt:**

```
Implementiere OPT-28 Teil B aus @docs/opt/open/28-thumb-delete-stability.md
Regeln: @AGENTS.md
Nur Teil B. Danach cargo test && npm run check.
```

---

## Abgrenzung (nicht OPT-28)

| Thema | Wo |
|--------|-----|
| NVENC-Treiber / `available=true` vs Runtime-Fail | separates Ticket (Startup-Probe + Fallback Preview) |
| MTP/ICA-Thumbs | eigene Pfade in `sd_card.rs` |
| Phase 56 SD-Backup-Link | Feature-Phase, nicht Thumb/Delete |

---

## Tracker (intern)

| Teil | Status |
|------|--------|
| A | ✅ Code |
| B | ✅ Code |
