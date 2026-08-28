# Vorgänge-Dialog — Implementierungsplan (Phase 38)

> **Zweck:** UX- und Robustheits-Verbesserungen am Dialog **Vorgänge** (Tab „Vorgänge“: Liste + Detail).
> Pro Agent-Session **nur eine Unterphase** (38.1 … 38.4) implementieren.
>
> **Regeln:** `@AGENTS.md` · **Hauptplan:** `@docs/IMPLEMENTATION_PLAN.md`

---

## 1. Ausgangslage

### Bekannte Probleme (Operator-Feedback)

| Bereich | Symptom | Ursache im Code (Ist) |
|---------|---------|------------------------|
| **Tabellenlayout** | Spalten „Datum“ / „Erstellt“ zu eng; Werte abgeschnitten | `table-fixed`, je 12 % Breite; `formatLocaleDateTime` (Datum + Uhrzeit) in schmaler Spalte |
| **Status-Spalte** | Chips zu breit / abgeschnitten | Lange AMS-Labels + Icons in 27 % Spalte |
| **Chips uneinheitlich** | Unterschiedliche Breiten, mal Icon mal nicht | `ProductStatusChip`, `UploadStateChip`, `AmsHandoffStatusChip` — drei getrennte Implementierungen in/near `HistoryDialog.tsx` |
| **Labels unklar** | „Übertragen“, „Übernommen“, „Warteschlange“, „Senden“ | Zwei parallele Pipelines (SMB vs. AMS) mit ähnlicher Wortwahl (`ams.handoff.*`) |
| **Status hängt** | Vorgänge bleiben auf „Übertragen“/„Übernommen“, erst nach Neustart ok | AMS-Poll nur bei **offenem** Dialog, max. 15 Jobs / 20 s; nach SMB-Upload kein `getHandoffStatus`; Fallback `pending_local` |

### Relevante Dateien (Ist)

```
src/components/HistoryDialog.tsx       # VorgaengePanel, MedienPanel, lokale Chips
src/components/AmsHandoffStatus.tsx    # nur von HistoryDialog importiert
src/lib/amsHandoffStatus.ts            # AMS-State-Helfer + Label-Mapping
src/lib/uploadState.ts                 # SMB upload_state-Helfer
src/App.tsx                            # Upload-Slot, persistUploadState
src-tauri/src/commands/vorgang_history.rs   # get_handoff_status, set_vorgang_upload_state
src/locales/de.json | en.json | es-MX.json
```

---

## 2. Leitentscheidungen

### 2.1 Scope — nur Vorgänge-Dialog

| Im Scope | Out of Scope (explizit unverändert lassen) |
|----------|---------------------------------------------|
| Tab **Vorgänge** (Liste + Detail + Dateitabelle) | Header-Chips (Server, Backup, Upload-Bar) |
| AMS-Stepper im Detail-Panel | QR-Chips, Create-Pipeline, CustomerForm |
| i18n unter `history.status.*` (neu) | Globale `components/ui/*`-Chip-Komponente |
| Optional unsichtbar: App-weites AMS-Poll / Startup-Reconcile | Tab **Medien** (eigene Mini-Phase 38.5 optional) |
| | **Nachreichen**-Slide-in `AppendMediaDialog` / `CatStatusChip` |

> **Regel:** Keine visuellen Änderungen außerhalb des Vorgänge-Dialogs. Bestehende `AmsHandoffStatus.tsx` darf verschoben/ersetzt werden — sie hat **keine** anderen Consumer.

### 2.2 Chip-Architektur — Insel `components/history/`

Neue Module **nur** für den Dialog; **kein** Shared UI unter `components/ui/`:

```
src/components/history/
  HistoryStatusChip.tsx      # Basiskomponente (Layout-Shell: Höhe, Padding, Icon-Slot)
  VorgangProductChip.tsx     # Produkte (TM/VS, bezahlt)
  VorgangUploadChip.tsx      # SMB upload_state
  VorgangAmsChip.tsx         # AMS handoff (Liste, compact)
  VorgangAmsStepper.tsx      # Detail-Stepper (aus AmsHandoffStatus.tsx extrahiert)
  historyStatusLabels.ts     # Mapping State → history.status.* (de/en/es)
  historyChipTones.ts        # Tailwind-Töne (parallel zu handoffChipClass, nur History)
```

Import-Regel: **Nur** `HistoryDialog.tsx` (bzw. extrahiertes `VorgaengePanel.tsx`) importiert aus `components/history/`.

### 2.3 Zwei Ebenen — Operator-Sprache

| Ebene | Technisch | Listen-Chip (Vorschlag DE) | Tooltip-Kern |
|-------|-----------|----------------------------|--------------|
| **Server** | `upload_state` | Ausstehend → **Server-Upload offen**; uploading → **Wird kopiert…**; failed/cancelled wie heute (`history.upload.*` schärfen) | ATS kopiert Dateien auf den konfigurierten Server |
| **Buchung** | `ams_state` | pending → **Buchung: wartet**; accepted → **Buchung: bestätigt**; queued → **Buchung: in Warteschlange**; uploading → **Cloud-Upload…**; completed → *(Liste: kein Chip)* | Übergabe an AMS / Buchungssuche |

Detail-Stepper: Kurzlabels mit Präfix **„Buchung“** statt „Übertragen“/„Senden“; SMB-Phase nur anzeigen wenn `upload_state` noch offen.

Keys: **`history.status.*`** (neu) — **`ams.handoff.*` nicht löschen** (Kompatibilität / spätere Nutzung).

### 2.4 Listen-Logik Status-Spalte (Ist — Phase 38.3/38.4)

Priorität über `resolveListStatusDisplay` (`vorgangLifecycle.ts`):

1. **Ordner fehlt** (Upload/retry erwartet) → `VorgangFolderChip`
2. **SMB** wenn `isListUploadStatus(upload_state)` — gewinnt über AMS
3. **AMS offen** wenn `shouldShowAmsListChip` (nicht terminal)
4. **Fertig** wenn Server-Upload + AMS `completed` (`VorgangCompleteChip` / `jobComplete`)
5. **AMS terminal** (abgebrochen / abgelehnt / fehlgeschlagen) → `VorgangAmsChip` compact
6. **Lokal entfernt** nach Upload (`VorgangArchivedChip`) oder `—`

> Abweichung vom ursprünglichen Plan: **`completed` zeigt „Fertig“**, nicht leer — Operator-Feedback.

---

## 3. Unterphasen

### Phase 38.1 — Tabellenlayout (Tab Vorgänge)

**Status:** ✅ Erledigt  
**Abhängigkeiten:** —  
**Aufwand:** klein  

#### Ziel

Liste und Detail-Dateitabelle lesbar machen, ohne Medien-Tab anzufassen.

#### Maßnahmen

| # | Änderung |
|---|----------|
| 1 | `colgroup` neu: Gast ↓, Status ↑, **Erstellt** aus Liste entfernen oder nur kompakt (`DD.MM. HH:mm` via `formatLocaleDateTime` Wrapper in Panel) |
| 2 | Sprung-**Datum** (`e.datum`) behalten; volles Erstell-Datum ins **Detail** (Meta-Zeile) |
| 3 | Status-Spalte min. ~32 %; Produkte flex/wrap ok |
| 4 | Optional: Split `lg:grid-cols-[1fr_0.9fr]` → Liste etwas breiter |
| 5 | Detail-Dateitabelle: `colgroup` + Dateiname `min-w-0` flex statt fix `max-w-[220px]` |
| 6 | `title`-Attribute auf truncate-Zellen (bereits teilweise — vervollständigen) |

#### Dateien

```
src/components/HistoryDialog.tsx   # VorgaengePanel — oder nach 38.2 extrahiert
src/lib/locale.ts                  # optional: formatLocaleDateTimeCompact()
```

#### Out of Scope

- Tab Medien, Dialog-Gesamtbreite > 1150px (optional später)

#### Akzeptanz

| # | Kriterium |
|---|-----------|
| 1 | Sprungdatum und Status-Chip in 1280px-Breite ohne Abschneiden der Chip-Labels (Truncate nur bei extrem langen Gastnamen) |
| 2 | Erstellzeit im Detail sichtbar (voller Wert) |
| 3 | Dateinamen in Detail-Tabelle nutzen verfügbare Breite |

#### Agent-Prompt

```
Implementiere Phase 38.1 aus @docs/VORGAENGE_DIALOG_PLAN.md
Regeln: @AGENTS.md
Nur Tab Vorgänge (Liste + Detail-Dateitabelle). Kein Medien-Tab, keine Chip-Änderungen.
Danach npm run check && manuell: Vorgänge-Dialog öffnen, schmale/breite Fensterbreite.
```

---

### Phase 38.2 — Einheitliche History-Chips

**Status:** ✅ Erledigt  
**Abhängigkeiten:** 38.1 empfohlen (Spaltenbreite), nicht blockierend  
**Aufwand:** mittel  

#### Ziel

Einheitliches Chip-Erscheinungsbild **nur im Vorgänge-Dialog**; Rest der App unverändert.

#### Maßnahmen

| # | Änderung |
|---|----------|
| 1 | Ordner `src/components/history/` anlegen |
| 2 | `HistoryStatusChip`: feste `min-h-6`, einheitliches `px-2 py-0.5`, Icon-Slot `size-3` **immer reserviert** (leerer Platzhalter wenn kein Icon) |
| 3 | `VorgangProductChip` / `VorgangUploadChip` / `VorgangAmsChip` auf Basis-Shell |
| 4 | `VorgangAmsStepper` aus `AmsHandoffStatus.tsx` extrahieren; Stepper-Chips gleiche Shell (kleiner: `text-[10px]`) |
| 5 | `HistoryDialog.tsx`: lokale Chips entfernen; Imports aus `history/` |
| 6 | `AmsHandoffStatus.tsx`: deprecate — Re-Export aus `history/` oder Datei löschen wenn leer |
| 7 | **Keine** Änderung an `AppendMediaDialog` / Header / QR |

#### Visuelle Regeln

- **Produkt-Chips:** outline/muted (kein Icon außer bezahlt-Check)
- **Status-Chips:** ring-1 ring-inset; aktive States `ams-chip-active` beibehalten (nur im Dialog)
- **Terminal AMS `completed`:** in Liste **Fertig-Chip** wenn Upload+AMS durch (siehe §2.4)

#### Akzeptanz

| # | Kriterium |
|---|-----------|
| 1 | Alle Chips im Tab Vorgänge: gleiche Höhe, Icon-Spalte aligned |
| 2 | Header-Upload-Chip, QR-Chips, Create-Stepper **pixelgleich** wie vorher ( visueller Regressionstest ) |
| 3 | `grep` zeigt: `components/history/` nur von `HistoryDialog` importiert |

#### Agent-Prompt

```
Implementiere Phase 38.2 aus @docs/VORGAENGE_DIALOG_PLAN.md
Regeln: @AGENTS.md
Nur components/history/* + HistoryDialog (+ AmsHandoffStatus migrieren/entfernen).
Keine globalen UI-Komponenten. AppendMediaDialog unangetastet.
Danach npm run check && visuell: Vorgänge vs. Header/Create vergleichen.
```

---

### Phase 38.3 — Labels & i18n (Operator-Sprache)

**Status:** ✅ Erledigt  
**Abhängigkeiten:** 38.2 (Chips nutzen neue Keys)  
**Aufwand:** klein  

> **Ist-Labels:** Präfix **„Cloud:“** statt Plan-„Buchung:“ (Operator-Sprache Server vs. Cloud).

#### Ziel

Klare Unterscheidung Server-Upload vs. Buchungs-Übergabe in **de / en / es-MX**.

#### Neue Keys (Beispiel DE — EN/ES analog)

```json
"history": {
  "status": {
    "smbPending": "Server-Upload offen",
    "smbUploading": "Wird kopiert…",
    "amsPending": "Buchung: wartet",
    "amsAccepted": "Buchung: bestätigt",
    "amsQueued": "Buchung: in Warteschlange",
    "amsUploading": "Cloud-Upload…",
    "amsCompleted": "Abgeschlossen",
    "amsRejected": "Buchung: abgelehnt",
    "amsCancelled": "Buchung: abgebrochen",
    "hint": {
      "smbPending": "Lokal fertig — Kopie auf den Server steht noch aus",
      "amsPending": "Wartet auf Übernahme in der Buchungssuche",
      "amsStale": "Status veraltet — tippe zum Aktualisieren"
    },
    "step": {
      "smb": "Server",
      "amsPending": "Übergabe",
      "amsAccepted": "Bestätigt",
      "amsQueued": "Warteschlange",
      "amsUploading": "Cloud",
      "amsCompleted": "Fertig"
    }
  }
}
```

#### Maßnahmen

| # | Änderung |
|---|----------|
| 1 | `historyStatusLabels.ts`: `uploadStateLabel()`, `amsStateLabel()`, `amsStepLabel()` |
| 2 | Chips + Stepper nutzen nur `history.status.*` |
| 3 | `ams.handoff.*` unverändert lassen (kein Breaking für externe Docs) |
| 4 | Filter-Chips „Offen“ → Tooltip: „Noch nicht abgeschlossen (Server oder Buchung)“ |
| 5 | `history.upload.pending` ggf. an `smbPending` angleichen (Liste konsistent) |

#### Akzeptanz

| # | Kriterium |
|---|-----------|
| 1 | Operator erkennt ohne Wissen von AMS/SMB: welcher Schritt Server, welcher Buchung ist |
| 2 | Sprachwechsel de/en/es: alle neuen Strings vorhanden |
| 3 | Keine geänderten Strings außerhalb `history.*` (außer optional `history.upload.*` Verfeinerung) |

#### Agent-Prompt

```
Implementiere Phase 38.3 aus @docs/VORGAENGE_DIALOG_PLAN.md
Regeln: @AGENTS.md
Nur history.status.* in de/en/es + historyStatusLabels + Chip/Stepper-Anbindung.
ams.handoff.* nicht entfernen. Keine Header/Create-Strings.
```

---

### Phase 38.4 — Status-Robustheit (AMS + SMB)

**Status:** ✅ Erledigt  
**Abhängigkeiten:** Phase 31/37 (Upload-Slot), Bridge/Outbox  
**Aufwand:** mittel  

> **AMS-Bridge (AeroMediaService-v2):** `GET /v1/jobs/{id}` merged AMS-Historie bei stale Outbox (`completed` → Abgebrochen). ATS re-verifiziert `completed`-Jobs; **AMS muss neu gestartet** sein, damit Abbruch nach Erfolg sichtbar wird.

#### Ziel

Keine „hängenden“ Status mehr nach Bulk-Create/Upload; Korrektur ohne Dialog-Neustart.

#### Ist-Probleme → Fixes

| Problem | Fix |
|---------|-----|
| AMS-Poll nur bei offenem Dialog | **Leichtgewichtiger Hintergrund-Poll** (z. B. 45 s, wie SMB Quiet-Poll), solange unsettled Jobs existieren und `upload_to_server` + Bridge/Share erreichbar konfiguriert |
| Max. 15 Jobs / Intervall | Round-Robin über alle offenen `correlation_id`s; Batch-Größe konfigurierbar (const 15 ok mit Cursor) |
| Nach SMB `done` kein AMS-Refresh | In `uploadSlotRunnerRef` nach `persistUploadState("done")`: `getHandoffStatus` für `vorgangId` |
| `upload_state === uploading` nach Crash | **Startup-Reconcile** in Rust oder Frontend: `uploading` → `pending` wenn kein aktiver Upload-Slot-Job |
| Stale Cache | Hinweis wenn **`ams_verified_at`** älter als 3 min (nicht `ams_updated_at`); Detail-Button „Status aktualisieren“; nach Bridge-Fetch verschwindet Hinweis |

#### Dateien

```
src/components/HistoryDialog.tsx       # Dialog-Poll (30s completed) / stale hint
src/hooks/useAmsHandoffPoll.ts         # Background ~45s + boot sync
src/hooks/useHandoffSync.ts            # sync_open_handoffs + collectHandoffSyncTargets
src/lib/vorgangLifecycle.ts            # folder cleanup, shouldSyncAmsHandoff, list display
src/lib/amsHandoffPatch.ts             # ams_verified_at, isAmsStatusStale
src/store/historyStore.ts              # patchVorgang für Poll-Ergebnisse
src/App.tsx                            # nach Upload done → getHandoffStatus; reconcileStaleUploads
src-tauri/src/commands/vorgang_history.rs  # sync_open_handoffs, ams_verified_at persist
src-tauri/src/storage/vorgang_history.rs   # ams_verified_at column
```

#### Out of Scope

- AMS-Bridge-Protokoll ändern
- Auto-Retry Upload
- Ein unified `phase`-Enum in SQLite (langfristig)

#### Tests

| Art | Inhalt |
|-----|--------|
| Rust (optional) | `uploading` → `pending` reconcile bei App-Start |
| Manuell | 20+ Vorgänge erstellen/hochladen, Dialog schließen, 2 min warten → Status in Liste aktualisiert |
| Manuell | App kill während Upload → Neustart → `pending` + Nachholen möglich |

#### Akzeptanz

| # | Kriterium |
|---|-----------|
| 1 | Nach erfolgreichem Background-Upload wechselt AMS-Chip innerhalb ~1 Poll-Zyklus von „wartet“ weiter |
| 2 | Mit geschlossenem Dialog aktualisiert sich `ams_state` in SQLite (Badge/Filter korrekt beim Reopen) |
| 3 | Kein dauerhaftes `uploading` nach Absturz |
| 4 | Keine Regression: Upload-Slot, Bulk, Cancel (31.8) unverändert funktional |

#### Agent-Prompt

```
Implementiere Phase 38.4 aus @docs/VORGAENGE_DIALOG_PLAN.md
Regeln: @AGENTS.md
AMS Background-Poll + Refresh nach Upload done + uploading-Reconcile.
UI nur optional: „Status aktualisieren“ / stale hint im Vorgänge-Detail.
Danach cargo test && npm run check && manuell Bulk-Upload-Szenario.
```

---

### Phase 38.5 — Medien-Tab Layout (optional)

**Status:** ✅ Erledigt · **optional / separate Session**  
**Abhängigkeiten:** 38.1 (Format-Helfer)  

#### Ziel

Spalten Importiert / Gesichert lesbar (kompaktes Datum via `formatLocaleDateTimeCompact`, `title` mit vollem Wert inkl. Sekunden).

#### Scope

Nur `MedienPanel` in `HistoryDialog.tsx` — **keine** Chip-Arbeit.

---

## 4. Empfohlene Reihenfolge

```
38.1 Layout  →  38.2 Chips  →  38.3 Labels  →  38.4 Robustheit  →  (38.5 Medien)
```

38.3 und 38.2 können in einer Session zusammengelegt werden, wenn Scope diszipliniert bleibt — **empfohlen ist trotzdem getrennt** (Review / Regression).

---

## 5. Refactoring optional (nach 38.4)

| Task | Nutzen |
|------|--------|
| `VorgaengePanel.tsx` aus `HistoryDialog.tsx` extrahieren | Kleinere Datei (~2600 Zeilen → handhabbar) |
| `MedienPanel.tsx` eigene Datei | Parität mit VorgaengePanel |
| `historyStore` als Single Source für Vorgang-Liste | Poll + Dialog teilen sich State |

Kein Muss für 38.1–38.4.

---

## 6. Testplan (Gesamt)

### Manuell (Pflicht)

1. Vorgänge-Dialog: leer, 1 Job, 20+ Jobs, Filter Alle/Offen/Fertig/Fehler
2. SMB pending / uploading / failed / cancelled — Chip + Nachholen
3. AMS pending → completed (Bridge online); offline → Cache-Label
4. Bulk-Upload (31.6) + Dialog zu während Upload → Reopen Status
5. Sprachen de / en / es-MX
6. **Regression:** Header-Chips, Create-Flow, Nachreichen öffnen (CatStatusChip unverändert)

### Automatisiert

- `npm run check`
- `cargo test` (bes. wenn 38.4 Rust-Reconcile)
- Keine neuen E2E-Pflichten v1

---

## 7. Fortschritt

| Phase | Titel | Status |
|-------|-------|--------|
| 38.1 | Tabellenlayout (Tab Vorgänge) | ✅ |
| 38.2 | Einheitliche History-Chips (`components/history/`) | ✅ |
| 38.3 | Labels & i18n (`history.status.*`) | ✅ |
| 38.4 | Status-Robustheit (Poll + Reconcile + `ams_verified_at`) | ✅ |
| 38.5 | Medien-Tab Layout (optional) | ✅ |

**Legende:** ⬜ Offen · 🔄 In Arbeit · ✅ Erledigt

*Letzte Aktualisierung Doku: 2026-08-28 — Phase 38 abgeschlossen; AMS-Bridge-Historie-Merge in AeroMediaService-v2.*

---

## 8. Schnell-Prompts

**38.1 — Layout**
```
Implementiere Phase 38.1 aus @docs/VORGAENGE_DIALOG_PLAN.md
Regeln: @AGENTS.md
Nur Tab Vorgänge Layout. Danach npm run check.
```

**38.2 — Chips**
```
Implementiere Phase 38.2 aus @docs/VORGAENGE_DIALOG_PLAN.md
Regeln: @AGENTS.md
Nur components/history/* — Rest der App visuell unverändert.
```

**38.3 — Labels**
```
Implementiere Phase 38.3 aus @docs/VORGAENGE_DIALOG_PLAN.md
Regeln: @AGENTS.md
Nur history.status.* (de/en/es) + Anbindung in history/*.
```

**38.4 — Robustheit**
```
Implementiere Phase 38.4 aus @docs/VORGAENGE_DIALOG_PLAN.md
Regeln: @AGENTS.md
Danach cargo test && npm run check.
```

---

*Erstellt: 2026-08-28 · Projekt: Aero Tandem Studio v2 · Phase 38 Vorgänge-Dialog UX*
