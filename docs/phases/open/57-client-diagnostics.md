# Phase 57 — Client-Diagnostik (stille Fehlerberichte)

> **Agent-Attach:** Diese Datei + `@docs/CLIENT_DIAGNOSTICS_PLAN.md` (Master).  
> Regeln: `@AGENTS.md` · Index: `@docs/IMPLEMENTATION_PLAN.md`  
> Partner: Cloud D* + AMS B* **vorher** deployed.

**Status:** ✅ ATS R0–R5 (Code); manuelle Abnahme Master §8 nach Cloud D* + AMS B*  
**Abhängigkeiten:** Phase 53 (Client-JWT, `cloud_lookup_*`, `lookup_router`, `AtsBridgeIdentity`)  
**Ziel:** Automatisch redigierte Fehler + technische Daten (+ PC-Name, Breadcrumbs) an Cloud; AMS-Primärweg; Outbox offline.

> Eine Agent-Session = **ein Slice R0–R5**. Kein manuelles „Problem melden“, kein Toast.

---

## Leitentscheidungen (ATS)

| # | Thema | Entscheidung |
|---|--------|----------------|
| 1 | Default | `send_error_reports: true` |
| 2 | UI | Settings-Toggle + Beschreibung *„Nur Fehlermeldungen und technische Daten“* (inkl. PC-Name) |
| 3 | Sichtbarkeit | Nur lokales Log; kein Dialog |
| 4 | Hostname | `build_ats_bridge_identity().hostname` → Feld `ats_hostname` |
| 5 | Transport | AMS `diagnostics-v1` → else Cloud JWT → else Outbox |
| 6 | JWT | Gleiches persisted Token; Scope `diagnostics.report` aus Issue |

Wire & DB: `@docs/CLIENT_DIAGNOSTICS_PLAN.md`.

---

## Slices

### R0 — Config + Settings

- `AppConfig.send_error_reports: bool` (Default `true`); Migration/Deserialize fehlend → `true`
- Settings (Server/Erweitert o. ä. passend zu Phase 47): Toggle + i18n de/en/es-MX
- TS-Typen + Save-Preserve wie andere Flags

**DoD:** Toggle persistiert; Default an für neue + bestehende Instanzen.

### R1 — Breadcrumbs + Redaction + Fingerprint

- Modul `diagnostics/` (oder `src-tauri/src/diagnostics/`):
  - Ringpuffer `breadcrumbs` (max 15): `{ t, action, meta? }`
  - `action`: stabile Strings (`export.start`, `bridge.lookup`, `smb.upload`, …) — **keine** freien UI-Strings
  - Hook-Punkte: wenige zentrale Stellen (Export-State, Bridge-Lookup-Aufruf, SMB-Fatal, …)
- `redact_message` / `redact_details`: Pfade, UNC, Bearer, JWT-ähnliche Strings, booking/customer patterns
- `fingerprint`: Hash aus `code` + normalisierte `message` + `category` (stable)

**DoD:** Unit-Tests Redaction + Fingerprint; Breadcrumb cap.

### R2 — Outbox + Background-Flush

- SQLite: `diagnostics_outbox` (`event_id`, `payload_json`, `fingerprint`, `created_at`, `next_retry_at`, `attempts`, `status`)
- Max Queue (z. B. 200); bei Voll: drop oldest oder merge gleicher `fingerprint`
- Background-Task: nach Idle / periodisch / nach Export-Ende; exponential backoff; respektiert `send_error_reports`

**DoD:** Events überleben App-Neustart bis `sent`; kein Blockieren des UI-Threads.

### R3 — Cloud HTTP-Client

- `POST {cloud_base_url}/api/ats/v1/diagnostics/events` — analog `cloud_lookup.rs`
- Bearer aus `cloud_lookup_access_token`; prüfen Scope optional client-side (wenn kein `diagnostics.report` → skip Cloud path, nur AMS oder queue)
- Identity-Header wie Lookup; `401` → Token clear (bestehende Helper)
- Batch bis N Events pro Request

**DoD:** Unit-Tests URL, Header, Fehler-Mapping.

### R4 — AMS-Router + Capture

- Capability-Constant `diagnostics-v1` (Bridge health)
- `POST {ams}/v1/diagnostics/events` mit Bridge-Token + Identity
- Router: AMS connected + capability → AMS; else R3; else Outbox only
- Capture: z. B. `BridgeError` bei User-sichtbaren Flows, Export-Job-Fatal, kritische `Result::Err` an IPC-Grenzen — **nicht** jedes `log::warn`

**DoD:** Manuell: AMS an → Cloud zeigt `ingress=ams_bridge`; AMS aus → direct.

**Manuell (R4 Abnahme-Hinweis, vor R5):**

1. Cloud-Admin + AMS mit B2 (`diagnostics-v1`) deployed; ATS `send_error_reports` an.
2. AMS erreichbar: Export-Fehler oder Lookup-Fehler provozieren → Event in Cloud-Admin, **`ingress=ams_bridge`**.
3. AMS stoppen (oder falsche URL), gültiges JWT mit `diagnostics.report`: gleicher Fehler erneut → **`ingress=cloud_direct`**.
4. Beides offline: Outbox bleibt `pending`; nach Reconnect erneut senden.

### R5 — Tests & Abnahme

- Rust: Redaction, Outbox, Router-Priorität, Gate `send_error_reports`
- TS: Config default + Toggle
- Master-Plan §8 Abnahme
- `cargo test` + `npm run check`

**DoD:** Phase 57 abnehmbar; Tracker ✅.

**Erledigt (R5):**

- Rust Unit-Tests: `redaction`, `fingerprint`, `breadcrumbs`, `outbox` (Gate, cap, merge, backoff), `router` (AMS → Cloud → deferred), `cloud_report` / `ams_report`, `cloud_transport` (Scope-Gate, Router-Priorität), zentraler Gate `send_error_reports_enabled` in `diagnostics/mod.rs`
- TS: `sendErrorReportsEnabled` + `sendErrorReports.test.ts`; Settings-Toggle (Server · Erweitert) + `configStore` Normalize
- Abnahme-Matrix: `@docs/CLIENT_DIAGNOSTICS_PLAN.md` §8

---

## Checkboxen

- [x] R0 Config + Settings
- [x] R1 Breadcrumbs + Redaction + Fingerprint
- [x] R2 Outbox + Background-Flush
- [x] R3 Cloud HTTP-Client
- [x] R4 AMS-Router + Capture
- [x] R5 Tests + Abnahme (Unit; manuelle §8-Liste nach Cloud D* + AMS B*)
- [ ] Cloud D0–D4 deployed
- [ ] AMS B0–B3 deployed

---

## Dateien (Orientierung)

| Bereich | Pfad (voraussichtlich) |
|---------|-------------------------|
| Config | `src-tauri/src/storage/config.rs` |
| Cloud HTTP | `src-tauri/src/diagnostics/cloud_report.rs` |
| AMS HTTP | `src-tauri/src/diagnostics/ams_report.rs` |
| Router | `src-tauri/src/diagnostics/router.rs` |
| Outbox | `src-tauri/src/diagnostics/outbox.rs` |
| Breadcrumbs | `src-tauri/src/diagnostics/breadcrumbs.rs` |
| Settings | `src/components/settings/…` |

---

## Non-Goals (ATS)

- Frontend Error-Boundary an Cloud (optional später)
- Stack-Traces im Default-Payload
- User-Kommentare

---

## Prompt

```
Implementiere Phase 57 Slice R0 aus @docs/phases/open/57-client-diagnostics.md
Regeln: @AGENTS.md
Nur R0. Danach cargo test && npm run check.
```
