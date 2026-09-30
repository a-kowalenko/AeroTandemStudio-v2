# Aero Tandem Studio v2 — Performance-Optimierungsplan (Index)

> **Zweck:** Schlanker Leitfaden für Performance-Backlog, **getrennt** vom Feature-Plan (`IMPLEMENTATION_PLAN.md` / `phases/`).
> Pro Session **nur ein OPT-Paket** (bzw. ein Slice bei OPT-21).
>
> **Nicht** den ganzen Plan + Archiv anhängen. Stattdessen:
> - Regeln: `@AGENTS.md`
> - Offene Spec: `@docs/opt/open/…`
> - Nur bei Bedarf: `@docs/opt/ARCHIVE.md` · `@docs/PERF_BASELINE.md`

---

## Dokumente

| Dokument | Wann anhängen |
|----------|----------------|
| `@AGENTS.md` | Immer |
| `@docs/opt/open/21-capcut-export.md` | OPT-21 (CapCut-Export; ein Slice pro Session) |
| `@docs/opt/open/23-smb-stability.md` | OPT-23 (SMB-Stabilität / Mapping; ein Slice pro Session) |
| `@docs/optimization_plan.md` | Index / Tracker (optional) |
| `@docs/opt/ARCHIVE.md` | Regression / erledigte OPT-Spec (gezielt, nicht ganz) |
| `@docs/PERF_BASELINE.md` | OPT-0 Messungen / Vorher-Nachher |
| `@docs/opt/OUT_OF_SCOPE.md` | Abgelehnte Performance-Themen |
| `@docs/IMPLEMENTATION_PLAN.md` | Feature-Phasen (kein OPT-Scope mischen) |

---

## 1. Nächste Schritte

| Priorität | OPT | Spec | Status |
|-----------|-----|------|--------|
| 1 | **21B–E** CapCut-Export (RC, Ein-Durchlauf, HW, 1080p-Cap) | [`opt/open/21-capcut-export.md`](opt/open/21-capcut-export.md) | 🔄 0+A ✅ |
| — | **23** SMB-Stabilität (A–F Code ✅; manuell macOS/Linux offen) | [`opt/open/23-smb-stability.md`](opt/open/23-smb-stability.md) | ✅ Code |
| done | **0–20, 22** Import, Thumbs, SMB, … | [`opt/ARCHIVE.md`](opt/ARCHIVE.md) | ✅ (OPT-13 entfernt) |

**Empfohlene Reihenfolge (historisch):** OPT-0 … OPT-20 ✅ · **OPT-22** ✅ · **OPT-21** offen (Slice 0+A ✅).

---

## 2. Übersicht & Reihenfolge

| ID | Titel | Impact | Aufwand | Risiko | Abhängigkeiten | Spec |
|----|-------|--------|---------|--------|----------------|------|
| OPT-0 | Performance-Baseline | — | S | — | — | ARCHIVE |
| OPT-1 | Foto-Preview: Thumbnails statt Full-Res | hoch | S | niedrig | — | ARCHIVE |
| OPT-10 | Thumbnail-Warming nach Import staffeln | mittel | S | niedrig | — | ARCHIVE |
| OPT-8 | Startup: Cache-Sweep im Splash | mittel | S | niedrig | — | ARCHIVE |
| OPT-2 | Import: paralleles ffprobe + Copy/Probe-Pipeline | hoch | M | mittel | — | ARCHIVE |
| OPT-3 | Copy-Buffer & optional Hardlink/CoW-Import | hoch | M | mittel | — | ARCHIVE |
| OPT-7 | Filmstrip/Keyframe-Prefetch | mittel | S | niedrig | — | ARCHIVE |
| OPT-4 | Thumbnails über HTTP statt Base64-IPC | mittel | M | mittel | — | ARCHIVE |
| OPT-9 | Encode-Pfad: Stream-Copy & Preview-Reuse UX | hoch | S | niedrig | — | ARCHIVE |
| OPT-6 | Log-Konsole virtualisieren | niedrig | S | niedrig | — | ARCHIVE |
| OPT-5 | App.tsx Split + lazy Dialoge | mittel | L | mittel | — | ARCHIVE |
| OPT-11 | Foto-Import: QR vor Thumbnail-Warming | hoch | S | niedrig | OPT-10 | ARCHIVE |
| OPT-12 | Foto-Import: paralleles EXIF-Sort + Copy | hoch | M | mittel | OPT-3 | ARCHIVE |
| OPT-13 | Player/Cutter: libmpv statt HTML5 | — | — | — | **entfernt** | ARCHIVE |
| OPT-14 | QR: Cascade-Decode + Sharpness-Gate | hoch | M | mittel | Phase 6 | ARCHIVE |
| OPT-15 | SMB-Upload: Parallel + Marker-Barrier | hoch | M | mittel | Phase 10 | ARCHIVE |
| OPT-16 | Compatible-Probe-Cache + Create ohne „Clips prüfen“ | mittel | M | niedrig | Phase 40, OPT-2 | ARCHIVE |
| OPT-17 | SMB: Windows-Map → Local-Pfad | hoch | S | niedrig | Phase 10, 32 | ARCHIVE |
| OPT-18 | SMB: macOS/Linux OS-Mount → Local-Pfad | mittel | M | mittel | OPT-17 | ARCHIVE |
| OPT-19 | SMB: Auto-Mount (OS-Map, App-owned) | hoch | L | mittel | OPT-17–18 | ARCHIVE |
| OPT-20 | SMB: macOS User-Pfad + Windows Prefer-Local | hoch | M | mittel | OPT-17–19 | ARCHIVE |
| OPT-21 | CapCut-Export: schnell + robust | hoch | L | mittel | Phase 49/50 | [open/21](opt/open/21-capcut-export.md) |
| OPT-22 | SMB: Session-Budget (Win11 ~20er-Limit) | hoch | M | mittel | OPT-17–20 | ARCHIVE |
| OPT-23 | SMB: Stabilität, Mapping-Treffer, Session-Hygiene | hoch | M–L | niedrig–mittel | OPT-17–22 | [open/23](opt/open/23-smb-stability.md) |

---

## 3. Agent-Regeln (Kurz)

- Kein Feature-Scope aus `phases/open/` / Phase-ARCHIVE
- **Ein OPT (oder ein Slice) pro Session**
- Video nur über FFmpeg CLI in Rust; FFmpeg-Commands: Rust Unit-Tests
- Nach Rust: `cargo test --manifest-path src-tauri/Cargo.toml`
- Nach Frontend: `npm run check` + `npm run tauri dev`

Details: `@AGENTS.md` · Abgelehnte Themen: `@docs/opt/OUT_OF_SCOPE.md`

---

## 4. Fortschritts-Tracker

| ID | Status | Spec |
|----|--------|------|
| OPT-0 | ✅ | [ARCHIVE](opt/ARCHIVE.md) |
| OPT-1 | ✅ | ARCHIVE |
| OPT-2 | ✅ | ARCHIVE |
| OPT-3 | ✅ | ARCHIVE |
| OPT-4 | ✅ | ARCHIVE |
| OPT-5 | ✅ | ARCHIVE |
| OPT-6 | ✅ | ARCHIVE |
| OPT-7 | ✅ | ARCHIVE |
| OPT-8 | ✅ | ARCHIVE |
| OPT-9 | ✅ | ARCHIVE |
| OPT-10 | ✅ | ARCHIVE |
| OPT-11 | ✅ | ARCHIVE |
| OPT-12 | ✅ | ARCHIVE |
| OPT-13 | ✅ → **entfernt** (HTML5 only) | ARCHIVE |
| OPT-14 | ✅ | ARCHIVE |
| OPT-15 | ✅ | ARCHIVE |
| OPT-16 | ✅ | ARCHIVE |
| OPT-17 | ✅ | ARCHIVE |
| OPT-18 | ✅ | ARCHIVE |
| OPT-19 | ✅ | ARCHIVE |
| OPT-20 | ✅ Slice A+B | ARCHIVE |
| OPT-21 | 🔄 Slice 0+A ✅; **21B–E offen** | [open/21-capcut-export.md](opt/open/21-capcut-export.md) |
| OPT-22 | ✅ Slice A+B+C | ARCHIVE |
| OPT-23 | ✅ Slice A–F (Code); manuell macOS/Linux offen | [open/23-smb-stability.md](opt/open/23-smb-stability.md) |

**Nachher-Messung (2026-08-20, v0.2.17, Windows 11, libx264):** Vollständige Tabelle → **`docs/PERF_BASELINE.md`** (Abschnitt „Nach OPT-0 … OPT-10“).

| Szenario | OPT-0 Backend | Nach OPT-0…10 | Kurz |
|----------|---------------|---------------|------|
| S1 Import 10×6 MB | 4,45 s | **0,25 s** | −94 % |
| S2 Preview (1×30 s Proxy) | 10,13 s | 10,07 s | Encode unverändert |
| S3 Create mit Preview-Reuse | 0,02 s | 0,01 s | Reuse instant |
| S3 Create ohne Reuse | 9,76 s | 10,10 s | Encode unverändert |

---

## 5. Schnell-Prompt

```
Implementiere OPT-21 Slice B aus @docs/opt/open/21-capcut-export.md
Regeln: @AGENTS.md
Nur OPT-21B. Danach cargo test.
```

**Weitere Slices:** B–E in derselben Spec-Datei; **ein Slice pro Session**.

```
Implementiere OPT-23 Slice A aus @docs/opt/open/23-smb-stability.md
Regeln: @AGENTS.md
Nur OPT-23A. Danach cargo test --manifest-path src-tauri/Cargo.toml.
```

**Erledigte OPTs (Regression):** Abschnitt `### OPT-N` in `@docs/opt/ARCHIVE.md` — nicht ganzes Archiv anhängen.

---

*Struktur: Hybrid wie Phasen — Index hier, offene Specs in `opt/open/`, erledigte Specs in `opt/ARCHIVE.md`. Letzte Aktualisierung: 2026-09-29 (Plan-Split).*
