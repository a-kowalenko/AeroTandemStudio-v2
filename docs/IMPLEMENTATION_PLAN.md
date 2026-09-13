# Aero Tandem Studio v2 — Implementierungsplan (Index)

> **Zweck:** Schlanker Leitfaden für Agents. Pro Session **nur eine Phase**.
>
> **Nicht** den ganzen Plan + Archiv anhängen. Stattdessen:
> - Regeln: `@AGENTS.md`
> - Offene Spec: `@docs/phases/open/…`
> - Nur bei Bedarf: `@docs/phases/ARCHIVE.md` / `@docs/ARCHITECTURE.md`

---

## Dokumente

| Dokument | Wann anhängen |
|----------|----------------|
| `@AGENTS.md` | Immer |
| `@docs/phases/open/31.5-extra-files.md` | Phase 31.5 |
| `@docs/phases/open/31.9-reconnect-upload-offer.md` | Phase 31.9 |
| `@docs/phases/open/23-usb-mtp.md` | Phase 23.x |
| `@docs/phases/open/14-ml-photo.md` | Phase 14 (Backlog) |
| `@docs/VORGAENGE_DIALOG_PLAN.md` | Phase 38.x (erledigt; Nachschlagen) |
| `@docs/optimization_plan.md` | Nur ein OPT-Paket |
| `@docs/phases/ARCHIVE.md` | Regression / erledigte Spec |
| `@docs/phases/REFERENCE.md` | Mapping / Config-Skizze / alte Plan-Anhänge |
| `@docs/ARCHITECTURE.md` | Architektur |
| `@docs/MIGRATION.md` | Legacy-Mapping |
| `@docs/LINUX_BUILD.md` / `@docs/MACOS_BUILD.md` | Plattform-Build |

---

## 1. Überblick

Desktop-App zur automatisierten Erstellung von Tandem-Fallschirmsprung-Videos (Intro, Import, QR, Cut, Encode, SMB, Update).

| | Pfad |
|---|------|
| **v2 (editieren)** | `C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio-v2` |
| **Legacy (Archiv)** | nicht an Agent-Kontext anhängen |

**Stack:** Tauri 2 + Rust + React 19 + TypeScript + FFmpeg sidecar · Tailwind/shadcn · Zustand · SQLite · Win + macOS + Linux

---

## 2. Nächste Schritte

| Priorität | Phase | Spec | Status |
|-----------|-------|------|--------|
| 1 | **31.5** Extra-Dateien (Resync / optional löschen) | [`phases/open/31.5-extra-files.md`](phases/open/31.5-extra-files.md) | ⬜ |
| 2 | **23.2h / 23.3** USB-MTP (Overrides / Linux libmtp) | [`phases/open/23-usb-mtp.md`](phases/open/23-usb-mtp.md) | 🔄 |
| later | **14** ML Foto-Klassifikation | [`phases/open/14-ml-photo.md`](phases/open/14-ml-photo.md) | ⬜ |

*(AMS-Bridge Historie-Merge: AeroMediaService-v2 — AMS neu starten nach Deploy. Optional: Linux-VM-Abnahme, Windows-WPD mit echter Cam.)*

---

## 3. Agent-Regeln (Kurz)

- v2-Code + Phase-Spec = Source of Truth
- Legacy nicht anhängen
- Video nur über FFmpeg CLI in Rust (NVENC / VideoToolbox / libx264)
- FFmpeg-Commands: Rust Unit-Tests
- Nach Phase: `cargo test` + `npm run check` + `npm run tauri dev`
- **Eine Phase pro Session**

Details: `@AGENTS.md`

---

## 4. Fortschritts-Tracker

| Phase | Name | Status | Spec |
|-------|------|--------|------|
| 0–13 | Scaffold → macOS Build | ✅ | [ARCHIVE](phases/ARCHIVE.md) |
| 11.1 | Cache-Größe in Settings | ✅ | ARCHIVE |
| 14 | ML Foto-Klassifikation | ⬜ | [open/14](phases/open/14-ml-photo.md) |
| 15–22 | Linux … Titlebar-Align | ✅ | ARCHIVE |
| 23 | USB-Action-Cams (MTP) | 🔄 | [open/23](phases/open/23-usb-mtp.md) |
| 23.0–23.2g | Allowlist … Whitelist / WPD-Descend | ✅ | open/23 + ARCHIVE |
| 23.2h | Geräte-Overrides | ⬜ | open/23 |
| 23.3 | Linux libmtp | ⬜ | open/23 |
| 23.4 | UX & Docs | ⬜ | open/23 |
| 24–25 | AMS Nachreichen / Lookup | ✅ | ARCHIVE |
| 26 | i18n (de/en/es-MX) | ✅ | ARCHIVE / Code |
| 27–30 | Encode-Profil … Ordner-Konflikt | ✅ | ARCHIVE |
| 31 | Offline-Create & Upload nachholen | ✅ | ARCHIVE |
| 31.1–31.4 | Soft-Block … Partial Retry | ✅ | ARCHIVE |
| 31.5 | Extra-Dateien angleichen / löschen | ⬜ | [open/31.5](phases/open/31.5-extra-files.md) |
| 31.6–31.8 | Bulk zweistufig … Upload-Abbruch | ✅ | ARCHIVE |
| 31.9 | Reconnect Upload-Offer | ✅ | [open/31.9](phases/open/31.9-reconnect-upload-offer.md) |
| 32–37 | SMB Quiet-Poll … Background-Upload | ✅ | ARCHIVE |
| 38 | Vorgänge-Dialog UX | ✅ | [VORGAENGE_DIALOG_PLAN](VORGAENGE_DIALOG_PLAN.md) |
| 39–41 | Danger Zone … Eject-Ton | ✅ | ARCHIVE |
| 42 | Auto-Bereinigung Aufbewahrungsdauer | ✅ | [ARCHIVE](phases/ARCHIVE.md) |
| 43 | Compatible ≈ Avidemux (robust + schnell) | ✅ | [ARCHIVE](phases/ARCHIVE.md) |
| 43.1–43.5 | Progress … Settings-Copy / Abnahme | ✅ | ARCHIVE |
| 44 | Fotos aus Videoclip (Frame-Extraktion) | ✅ | [ARCHIVE](phases/ARCHIVE.md) |
| 44.1 | Fotos-Cutter Polish (Range-Handles, Nudge-Icons) | ✅ | ARCHIVE |
| 45 | QR Dual-Family (`hc_ou`) + AMS Hash-Lookup | ✅ | [ARCHIVE](phases/ARCHIVE.md) |
| 46 | Speculative Create Staging (Compatible, Intro aus) | ✅ | [ARCHIVE](phases/ARCHIVE.md) |

**Legende:** ⬜ Offen · 🔄 In Arbeit · ✅ Erledigt |

---

## 5. Schnell-Prompt

```
Implementiere Phase X aus @docs/phases/open/<datei>.md
Regeln: @AGENTS.md
Nur Phase X. Danach cargo test && npm run check && npm run tauri dev.
```

**Beispiele:**

```
Implementiere Phase 31.9 aus @docs/phases/open/31.9-reconnect-upload-offer.md
Regeln: @AGENTS.md
Nur 31.9.
```

```
Implementiere Phase 31.5 aus @docs/phases/open/31.5-extra-files.md
Regeln: @AGENTS.md
Nur 31.5.
```

```
Implementiere Phase 23.2h aus @docs/phases/open/23-usb-mtp.md
Regeln: @AGENTS.md
Nur 23.2h.
```

**Linux (Phase 15, erledigt):** `@docs/LINUX_BUILD.md`  
**Performance (OPT-X):** nur ein Paket aus `@docs/optimization_plan.md`

---

*Struktur: Hybrid A+B — Index hier, offene Specs in `phases/open/`, erledigte Specs in `phases/ARCHIVE.md`. Letzte Aktualisierung: 2026-09-11 (Phase 46 → ARCHIVE).*
