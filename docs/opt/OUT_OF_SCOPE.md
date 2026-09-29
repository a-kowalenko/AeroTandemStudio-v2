# Performance — bewusst nicht im OPT-Plan

> Kurzliste abgelehnter / verschobener Themen. Index: `@docs/optimization_plan.md`

## Themen

| Thema | Grund |
|-------|--------|
| Phase 23.1 Windows WPD/MTP | Feature-Phase, siehe `phases/open/23-usb-mtp.md` / ARCHIVE |
| Phase 14 ML Foto-Klassifikation | Eigenes Backlog |
| QR zweiter Decoder (quirc) / Fisheye-Undistort | Follow-up nach OPT-14, nur bei Rest-Misses |
| NVENC-Worker >4 | Hardware-Limit Consumer-GPUs |
| SMB Foto-Ordner-Dedup (Handcam+Outside) | Produkt/AMS — Follow-up nach OPT-15 |
| Compatible Session-UI-Chip vor Create | UX-Follow-up nach OPT-16 (Cache vorausgesetzt) |
| „Fast Preview“ 720p/CRF-Modus | Preview selten genutzt; separates Backlog wenn Bedarf |
| Foto-Review-Strip virtualisieren | Overview bereits virtualisiert; nur bei Review-Modus relevant |
| Thumbs aus QR-Decode ableiten | Follow-up nach OPT-11, geringer ROI bei EXIF-Thumbs |
| macOS NetFS (`NetFSMountURLSync`) statt User-Pfad | Follow-up nur wenn OPT-20A nicht reicht |
| Windows WNet ERROR_86 / Cred-Session-Härtung | Follow-up nach OPT-20B; getrennt von Sleep-Bridge / OPT-22 |
| Letter-less UNC ohne Drive-Letter | Follow-up; OPT-17 enumeriert nur A–Z |
| LanmanServer-SKU / Registry „max connections“ auf Win11 Client | SKU-Limit — Ops: NAS/Server; App: OPT-22 |
| Fleet-weiter SMB-Scheduler über AMS | Multi-PC — eigenes AMS-Thema, nicht OPT-22C |

---

## Referenzen

- **Performance-Baseline (OPT-0):** `@docs/PERF_BASELINE.md`
- Architektur: `@docs/ARCHITECTURE.md`
- Feature-Phasen: `@docs/phases/open/…` (offen) bzw. `@docs/IMPLEMENTATION_PLAN.md` (Index)
- Agent-Regeln: `@AGENTS.md`
- Bereits optimierte Bereiche: `qr/parallel.rs`, `sdThumbnailLoader.ts`, `SdFileSelector.tsx` (Virtualisierung), `preview_reuse.rs`, `video/parallel.rs`
