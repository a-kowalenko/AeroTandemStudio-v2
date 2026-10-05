# OPT-25 — SD-Import: History-Progress + Hash-Reuse

> **Agent-Attach:** Diese Datei (nicht `@docs/opt/ARCHIVE.md` / ganzen Plan).  
> Regeln: `@AGENTS.md` · Index: `@docs/optimization_plan.md`

**Status:** ✅ Slice A–C (Code)  
**Abhängigkeiten:** OPT-3 (Hardlink-Import), OPT-12 (Foto-Import-Progress)

**Ziel:** Nach Backup→Import keine 15–20 s indeterminate „Importiere SD-Dateien…“ mehr. History-Mark hat Progress; nach Backup kein zweiter Partial-Hash.

**Impact:** hoch (Feldbetrieb, große Timelapse-Karten)  
**Aufwand:** M  
**Risiko:** niedrig

> **Session-Regel (Ausnahme):** Alle Slices A–C in einer Session.

---

#### Produktentscheidungen

| # | Thema | Entscheidung |
|---|--------|--------------|
| P1 | Kein Re-Hash nach Backup | `BackupResult.copied_identities` → `import_sd_files` setzt `imported_at` ohne Datei-I/O |
| P2 | Import-only | Parallel-Hash + `sd-workflow-progress` („Verlauf aktualisieren…“) |
| P3 | Labels | Rust-Workflow-Label hat Vorrang vor Loading-Message |
| P4 | Semantik | `imported_at` bleibt am Content-Hash (wie bisher), Mark weiterhin vor Session-Copy |

---

#### Slices

| Slice | Titel | Inhalt |
|-------|-------|--------|
| **A** | UX + Parallel-Hash | Progress-Events, i18n, Label-Vorrang, paralleles Hashen ohne Identities |
| **B** | Hash-Reuse | `CopiedFileIdentity`, `mark_imported_identities`, Backup→Import ohne Re-Read |
| **C** | Feinschliff | Seed-Progress vor IPC, Loading-Message „Verlauf…“ → „Importiere…“, Fallback ohne stale Message |

---

#### DoD

- [x] Backup→Import: Gap `SD-Import start` → `fertig` ohne Multi-Sekunden-Hash
- [x] Import-only: Progress „Verlauf aktualisieren…“ statt indeterminate Leerzeit
- [x] Foto/Video-Copy-Progress unverändert
- [x] `cargo test` + `npm run check`
