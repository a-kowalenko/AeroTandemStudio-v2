# Client-Diagnostik — Querschnittplan (ATS · AMS · Cloud)

> **Zweck:** Automatische, stille Fehlerberichte von ATS an Cloud (AMS-Primärweg oder direkt mit Client-JWT).  
> **Agent-Attach:** diese Datei + die Repo-Slice-Spec des jeweiligen Projekts.  
> **Nicht** Lookup-Phase-53-Scope erweitern ohne diesen Plan.

| Repo | Pfad | Slice-Spec |
|------|------|------------|
| **Cloud** | `cloud-kowalenko-io` | [`docs/ATS_CLIENT_DIAGNOSTICS.md`](file:///Users/andy/WebstormProjects/cloud-kowalenko-io/docs/ATS_CLIENT_DIAGNOSTICS.md) |
| **AMS** | `AeroMediaService-v2` | [`docs/ATS_CLIENT_DIAGNOSTICS.md`](file:///Users/andy/RustroverProjects/AeroMediaService-v2/docs/ATS_CLIENT_DIAGNOSTICS.md) · Bridge: `docs/HANDOFF.md` |
| **ATS** | `AeroTandemStudio-v2` | [`phases/open/57-client-diagnostics.md`](phases/open/57-client-diagnostics.md) |

**Status:** ⬜ Planung  
**Deploy-Reihenfolge:** **Cloud → AMS → ATS** (ATS erst nach Cloud+AMS-Deploy sinnvoll abnehmen)

---

## 1. Ziel

ATS sendet **automatisch** (Default **an**, ohne Toast) redigierte Fehlermeldungen und technische Kontextdaten an Cloud — für Support und Stabilitätsauswertung.

| Mit AMS | Ohne AMS, JWT gültig, Cloud erreichbar | Sonst |
|---------|----------------------------------------|--------|
| `POST {ams}/v1/diagnostics/events` → Cloud (Server-Key) | `POST {cloud}/api/ats/v1/diagnostics/events` (Bearer JWT) | Lokale **Outbox**, Retry im Hintergrund |

**Kein** manuelles „Problem melden“. User sieht nichts außer lokalem Log.

---

## 2. Leitentscheidungen (fest)

| # | Thema | Entscheidung |
|---|--------|----------------|
| 1 | JWT | **Ein** ATS-Client-JWT wie Phase 53; `scope` enthält **`customer.lookup`** + **`diagnostics.report`** |
| 2 | Lookup | Unverändert — nur `customer.lookup` auf Lookup-Route prüfen |
| 3 | Token-Issue | Cloud stellt JWT aus; AMS bootstrapped (bestehender `POST /v1/client-token`) |
| 4 | TTL / Refresh | 48h; proactive Refresh über AMS **&lt; 24h** (wie Lookup) |
| 5 | Routing | AMS zuerst wenn verbunden + Capability **`diagnostics-v1`**; sonst Cloud-JWT; sonst Outbox |
| 6 | Config ATS | `send_error_reports` Default **true**; Beschreibung: *„Nur Fehlermeldungen und technische Daten“* |
| 7 | PC-Name | `ats_hostname` = `sd_pc_name` oder OS-Fallback (`build_ats_bridge_identity`) |
| 8 | Breadcrumbs | Ringpuffer (z. B. 15), nur stabile `action`-Enums, kein PII |
| 9 | Revocation | Bestehendes Instanz-Revoke → JWT tot → auch Reports `401` |
| 10 | Retention Cloud | Roh-Events z. B. **90 Tage** (konfigurierbar) |

---

## 3. Wire — Event (Batch)

`POST /api/ats/v1/diagnostics/events`  
Auth: `Authorization: Bearer <jwt>` + `X-Ats-Instance-Id` (Match Claim) — wie Lookup.

```json
{
  "events": [
    {
      "event_id": "uuid",
      "occurred_at": "2026-10-18T11:00:00.000Z",
      "severity": "error",
      "category": "export",
      "code": "FFMPEG_EXIT_NONZERO",
      "fingerprint": "sha256:…",
      "occurrence_count": 3,
      "message": "FFmpeg beendet mit Code 1",
      "app_version": "2.x.y",
      "ats_app": "AeroTandemStudio",
      "platform": "macos",
      "arch": "aarch64",
      "ats_hostname": "Dropzone-1",
      "details": {
        "job_phase": "encode",
        "correlation_id": "internal-job-uuid",
        "ffmpeg_exit_code": 1,
        "encoder": "h264_videotoolbox"
      },
      "breadcrumbs": [
        { "t": 1739812300, "action": "vorgang.open", "meta": {} },
        { "t": 1739812340, "action": "export.start", "meta": { "phase": "encode" } }
      ]
    }
  ]
}
```

Response `200`:

```json
{ "ok": true, "accepted": 1, "duplicates": 0 }
```

Fehler: `401` token invalid · `413` body too large · `429` rate limit · `400` validation.

AMS Bridge: gleicher JSON-Body an `POST /v1/diagnostics/events`; AMS setzt `ingress: ams_bridge` serverseitig.

---

## 4. JWT Scope (Erweiterung)

Issue-Response `scope`:

```json
["customer.lookup", "diagnostics.report"]
```

| Route | Erforderlicher Scope |
|-------|----------------------|
| `POST …/customer/lookup` | `customer.lookup` |
| `POST …/diagnostics/events` | `diagnostics.report` |

Bestehende Tokens **ohne** `diagnostics.report`: Lookup ok, Reports nur nach Refresh/Issue.

---

## 5. Sicherheit & Datenschutz

- **Redaction Pflicht** vor Outbox/Upload: keine absoluten Pfade, NAS-Hosts, Secrets, Buchungs-/Kunden-IDs, QR-Inhalt.
- `ats_hostname` kann personenbezogen sein — in Settings-Text erwähnen.
- Token nicht loggen; `401` → Token verwerfen (wie Lookup).
- Rate-Limit pro Instanz; max Events/Batch und max Body-Größe.
- Kein Customer-API-Key in ATS.

---

## 6. Non-Goals

- Manuelles Feedback-Formular / Screenshots
- Sentry/Drittanbieter (optional später)
- Vollständige Log-Datei-Upload
- Org-weiter Kill-Switch (nur Instanz-Revoke)
- Fehlerreports wenn `send_error_reports === false`

---

## 7. Slice-Übersicht & Reihenfolge

| Order | Slice | Repo | Inhalt |
|------:|-------|------|--------|
| 1 | **D0** | Cloud | Scope `diagnostics.report`; Issue liefert beide Scopes |
| 2 | **D1** | Cloud | Migration `ats_diagnostics_events` |
| 3 | **D2** | Cloud | `POST …/diagnostics/events` + Rate-Limit + Idempotenz `event_id` |
| 4 | **D3** | Cloud | Admin-Liste (Instanz, Hostname, Kategorie, Fingerprint) |
| 5 | **D4** | Cloud | Tests, Deploy-Checkliste |
| 6 | **B0** | AMS | Cloud-Forward + Permission `ats_diagnostics_ingest` (API-Key) |
| 7 | **B1** | AMS | `POST /v1/diagnostics/events` (Bridge-Auth) |
| 8 | **B2** | AMS | Health: Capability `diagnostics-v1` |
| 9 | **B3** | AMS | Tests + HANDOFF §9.x |
| 10 | **R0** | ATS | Config + Settings (Default an) |
| 11 | **R1** | ATS | Breadcrumbs + Redaction + Fingerprint |
| 12 | **R2** | ATS | Outbox SQLite + Background-Flush |
| 13 | **R3** | ATS | Cloud HTTP-Client (diagnostics) |
| 14 | **R4** | ATS | Router AMS-first + Capture-Hooks |
| 15 | **R5** | ATS | Tests + Abnahme |

---

## 8. Abnahme (kurz)

| # | Kriterium | Automatisiert (ATS R5) | Manuell (nach Cloud D* + AMS B*) |
|---|-----------|------------------------|----------------------------------|
| 1 | Fehler (Export/Bridge) → Cloud-Admin; `ats_hostname` + `breadcrumbs` | Wire-Event-Tests (`event.rs`); Redaction | Export-/Lookup-Fehler provozieren; Admin prüfen |
| 2 | AMS an → `ingress=ams_bridge`; AMS aus + JWT → `cloud_direct` | `router.rs`, `cloud_transport.rs` (AMS-first) | Siehe Phase-57-Spec R4 Abnahme-Hinweis |
| 3 | Offline → Outbox `pending`; Reconnect → gesendet | `outbox.rs` (persist, backoff, cap) | Netz trennen / AMS+Cloud aus; Reconnect |
| 4 | `send_error_reports` aus → nichts gesendet | `mod.rs` gate, `outbox` enqueue; TS `sendErrorReports.test.ts` | Toggle aus; Fehler erneut → kein neues Event |
| 5 | Revoke Instanz → `401`, Token lokal gelöscht | `cloud_report.rs` (401 → clear) | Cloud Revoke; Flush erneut |
| 6 | Lookup unverändert (Phase 53) | Bestehende Lookup-/Router-Tests | Kurzer Lookup-Smoke mit AMS/Cloud |

**DoD ATS Code:** `cargo test` (diagnostics + config) · `npm run check` · optional `npm run test:send-error-reports`.

---

## 9. Agent-Prompts

```
Implementiere Slice D2 aus docs/ATS_CLIENT_DIAGNOSTICS.md (Cloud)
Nur D2. npx tsx scripts/test-ats-diagnostics-events.ts (wenn vorhanden).
```

```
Implementiere Slice B1 aus docs/ATS_CLIENT_DIAGNOSTICS.md (AMS)
Regeln: @AGENTS.md · Nur B1. Danach cargo test.
```

```
Implementiere Phase 57 Slice R4 aus @docs/phases/open/57-client-diagnostics.md
Regeln: @AGENTS.md · Nur R4. Danach cargo test && npm run check.
```
