# Phase 53 — Cloud-Lookup-Fallback (Buchungssuche ohne AMS)

> **Agent-Attach:** Diese Datei + `@docs/CLOUD_LOOKUP_FALLBACK_PLAN.md` (Master).  
> Regeln: `@AGENTS.md` · Index: `@docs/IMPLEMENTATION_PLAN.md`  
> Partner: AMS + Cloud müssen **vorher** deployed sein (Slices C* / A*).

**Status:** ✅ ATS-Code T0–T4 (Unit-Tests + Abnahmeliste). Manuelle E2E-Abnahme nach Cloud C* + AMS A* Deploy.  
**Abhängigkeiten:** AMS Bridge Lookup (Phase 25), Bridge Identity (`ams_bridge_instance_id`), Cloud Slices C0–C4, AMS Slices A0–A3  
**Ziel:** Wenn AMS-Buchungssuche offline ist, aber ein gültiges ATS-Client-JWT und Cloud erreichbar sind → Lookup über Cloud. Sonst offline anzeigen. Primärweg bleibt AMS.

> Eine Agent-Session = **ein Slice T0–T4**. Kein Handoff, kein Preflight-über-Cloud, keine Customer-Keys in ATS.

---

## Leitentscheidungen (ATS)

| # | Thema | Entscheidung |
|---|--------|----------------|
| 1 | Scope | Nur **Lookup** (QR/ID) |
| 2 | Routing | AMS verbunden → AMS; sonst gültiges JWT + Cloud → Cloud; sonst offline |
| 3 | Token | 48h JWT; Refresh nur über AMS wenn Rest **&lt; 24h** |
| 4 | Cloud-URL | von AMS (`client-token` / Health); lokal persistieren |
| 5 | Revoke | Cloud `401` → Token verwerfen |
| 6 | Preflight Create | unverändert (kein Cloud-Pfad) |
| 7 | UI | drei Zustände: AMS / Cloud / Offline |

Details & Wire-Format: `@docs/CLOUD_LOOKUP_FALLBACK_PLAN.md`.

---

## Slices

### T0 — Token-Store + Refresh-Regel

- Persistenz: `access_token`, `expires_at`, `cloud_base_url`, gebunden an `ams_server_instance_id` / ausstellende Instanz
- Bei erfolgreichem AMS-Health: wenn kein Token oder `(expires_at - now) < 24h` → `POST {ams}/v1/client-token`
- Token nicht loggen; bei Speichern/Laden sanitize
- Unit-Tests: Refresh-Schwelle 24h; abgelaufen = nicht nutzbar

**DoD:** Mit laufendem AMS wird Token geholt/erneuert; Config/Secret hält Stand über Neustart.

### T1 — Cloud-Lookup-Client (Rust)

- HTTP `POST {cloud_base_url}/api/ats/v1/customer/lookup` mit Bearer JWT + Identity-Header
- Decode Response wie AMS `LookupResponse`
- Timeouts analog Bridge-Lookup; `401` → klare Fehlerart „token invalid“
- Unit-Tests: URL-Bau, Header, Fehler-Mapping (ohne echtes Netz wo möglich)

**DoD:** Client testbar; noch nicht als Default-Router verdrahtet.

### T2 — Lookup-Router AMS-first

- Zentrale Stelle (Bridge-Command / shared helper): AMS live → AMS; else Cloud; else Fehler unreachable
- Alle Consumer (ID-Lookup, QR numeric/dual, ggf. hash) nutzen denselben Router
- Create-Preflight **nicht** auf Cloud umbiegen

**DoD:** Manuell: AMS killen + gültiges Token → Formular-Lookup füllt Kunde.

### T3 — Gate, Status-UI, i18n

- `canRunAmsIdLookup` → Booking-Lookup verfügbar wenn `amsLive || cloudLookupAvailable`
- Status-Indicator / Tooltip: AMS · Cloud · Offline
- i18n de / en / es-MX

**DoD:** Offline nur wenn wirklich kein Weg; Cloud-Zustand sichtbar aber nicht alarmierend.

### T4 — Tests & Abnahme

- Rust/TS-Tests für Gate + Router-Priorität
- Manuelle Liste aus Master-Plan §10 (Szenarien 1–10, ATS-relevant)
- `cargo test` + `npm run check`

**DoD:** Phase 53 abnehmbar; Tracker ✅.

#### Automatisierte Tests (T4)

| Bereich | Ort |
|---------|-----|
| Router AMS-first / Fallback / 401-clear | `src-tauri/src/bridge/lookup_router.rs` |
| Gate `amsLive \|\| cloud` | `src-tauri/src/bridge/lookup_map.rs` |
| Token Refresh &lt;24h / usable | `src-tauri/src/bridge/client_token.rs` |
| Cloud URL/Header/Fehler-Mapping | `src-tauri/src/bridge/cloud_lookup.rs` |
| TS Gate + Path-Priorität | `src/lib/bookingLookupGate.test.ts` (`npm run test:booking-lookup-gate`) |

#### Manuelle Abnahme (Master §10, ATS)

Voraussetzung: Cloud C0–C4 + AMS A0–A3 deployed.

| # | Szenario | Erwartung | □ |
|---|----------|-----------|---|
| 1 | AMS online, kein Token | Token wird gezogen; Lookup über AMS | |
| 2 | AMS online, Token Rest &lt; 24h | Neues Token; Lookup weiter AMS | |
| 3 | AMS online, Token Rest ≥ 24h | Kein unnötiger Issue-Call | |
| 4 | AMS offline, Token gültig, Cloud ok | Lookup über Cloud; UI „über Cloud“ | |
| 5 | AMS offline, Token abgelaufen | Offline; kein Customer-Key-Leak | |
| 6 | AMS offline, kein Internet | Offline | |
| 7 | Cloud Lookup `not_found` | Wie AMS: Formular/Hinweis, kein Crash | |
| 8 | Instanz widerrufen | Cloud `401`; ATS Token weg; Offline bis AMS-Reconnect | |
| 9 | Fremdes JWT / Instance-Mismatch | `401` | |
| 10 | QR hash + Manual id | Beide Modi über Cloud wie über AMS | |
| — | Create-Preflight | unverändert AMS-only / soft unreachable | |

---

## Out of Scope

- Cloud-Handoff / Job-Status / Path-Hints
- Create-Preflight über Cloud
- Refresh-Token ohne AMS
- Org-weite Revocation-UI in ATS
- Änderungen an Customer-API-Keys

---

## Dateien (erwartet)

| Bereich | Pfad |
|---------|------|
| Bridge / Router | `src-tauri/src/bridge/mod.rs`, `lookup_router.rs`, `cloud_lookup.rs`, `client_token.rs` |
| Config / Secrets | `src-tauri/src/storage/config.rs` (+ secrets falls vorhanden) |
| Commands | `src-tauri/src/lib.rs`, Bridge-Commands |
| Gate | `src/lib/bookingLookupGate.ts` (+ re-export `amsLookup.ts`), `src-tauri/src/bridge/lookup_map.rs` |
| Cloud-Probe | `cloud_lookup::probe_stored_token` · IPC `cloud_lookup_probe` · Settings/Header „Verbindung prüfen“ |
| UI | `src/store/amsBridgeStore.ts`, `ServerStatusIndicator.tsx`, Header-Status |
| i18n | `src/locales/{de,en,es-MX}.json` |

---

## Schnell-Prompt

```
Implementiere Phase 53 Slice T4 aus @docs/phases/open/53-cloud-lookup-fallback.md
Regeln: @AGENTS.md
Master: @docs/CLOUD_LOOKUP_FALLBACK_PLAN.md
Nur T4. Danach cargo test && npm run check.
```

---

## Checkboxen

- [x] T0 Token-Store + Refresh
- [x] T1 Cloud-Client
- [x] T2 Router AMS-first
- [x] T3 Gate + UI + i18n
- [x] T4 Tests + Abnahme (Unit; manuelle §10-Liste nach Cloud+AMS-Deploy)
- [ ] Cloud C0–C4 deployed
- [ ] AMS A0–A3 deployed
