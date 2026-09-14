# Phase 48 — Vorgang Medien-Viewer (lokal)

> **Agent-Attach:** Diese Datei (nicht Archiv/ganzen Plan).  
> Regeln: `@AGENTS.md` · Index: `@docs/IMPLEMENTATION_PLAN.md`

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 38 (Vorgänge-Dialog), bestehender Loopback-Media-Server + `VideoPlayer`  
**Ziel:** Im Tab **Vorgänge** lokale Liefermedien eines Vorgangs ansehen/abspielen, sofern noch vorhanden.

> Eine Agent-Session = nur Phase 48. Kein SMB/AMS-Streaming, kein Cutter/Edit, keine Quellenclips als Playlist.

---

## Leitentscheidungen

| # | Entscheidung |
|---|--------------|
| 1 | **Nur lokal** — kein Server-/AMS-Playback |
| 2 | **Liefermedien** — `output_video`, `wm_video`, Produkt-Unterordner (Fotos/Videos), Appends |
| 3 | **Keine Quellen** — `source_video` / `source_photo` / `marker` nicht in der Playlist |
| 4 | **Viewer ≠ Editor** — `VideoPlayer` Playback-Chrome ohne Trim |
| 5 | **Nested Dialog** — wie QR-Scan (`z-[60]`), nicht Inline im Detail |
| 6 | Disk-Scan ergänzt DB — Create speichert Lieferfotos oft nicht als `vorgang_dateien` |

---

## UX

1. Detail-Header: CTA **Medien ansehen** (neben QR), disabled wenn Ordner fehlt/archiviert oder keine spielbaren Dateien
2. Dateitabelle: spielbare Zeilen klickbar; Quellen/fehlend nicht
3. Dialog: Titel `Medien · {Gast}`, Rolle + Dateiname, Prev/Next, Esc stoppt Playback

---

## Technik

| Schicht | Änderung |
|---------|----------|
| Rust | `list_vorgang_viewable_media(vorgang_id)` — DB-Delivery-Rollen + Scan Job-/Append-Ordner, Dedup, Sort |
| TS | `listVorgangViewableMedia`, Playlist-Helfer, `VorgangMediaViewer` |
| UI | `HistoryDialog` / `VorgaengePanel` CTA + Tabellen-Klick + i18n |

---

## Out of Scope

- SMB/AMS-Streaming, Explorer-Reveal, Thumbnails, Quellenclips, Edit/Rotate/Trim
- Tab **Medien** (Import-Historie)

---

## Akzeptanzkriterien

1. Finalvideo lokal → CTA → Playback
2. Fotos + Video: Prev/Next ohne Dialog-Close
3. Quellen nicht in Playlist / nicht klickbar
4. Ordner fehlt → CTA disabled, kein Player-Fehler
5. QR- und Medien-Dialog nicht gleichzeitig
6. Schließen stoppt Audio
7. `cargo test` + `npm run check` grün

---

## Agent-Prompt

```
Implementiere Phase 48 aus @docs/phases/open/48-vorgang-media-viewer.md
Regeln: @AGENTS.md
Nur 48.
```
