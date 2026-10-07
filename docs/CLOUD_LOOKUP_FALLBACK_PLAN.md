# Cloud-Lookup-Fallback — Querschnittplan (ATS · AMS · Cloud)

> **Zweck:** Master-Plan für Buchungssuche ohne laufende AMS-Verbindung.  
> **Agent-Attach:** diese Datei + die Repo-Slice-Spec des jeweiligen Projekts.  
> **Nicht** Archiv/Monolithen anhängen.

| Repo | Pfad | Slice-Spec |
|------|------|------------|
| **Cloud** | `C:\Users\Kowalenko\WebstormProjects\cloud-kowalenko-io` | [`docs/ATS_CLOUD_LOOKUP_FALLBACK.md`](file:///C:/Users/Kowalenko/WebstormProjects/cloud-kowalenko-io/docs/ATS_CLOUD_LOOKUP_FALLBACK.md) |
| **AMS** | `C:\Users\Kowalenko\PycharmProjects\AeroMediaService-v2` | [`docs/ATS_CLOUD_LOOKUP_FALLBACK.md`](file:///C:/Users/Kowalenko/PycharmProjects/AeroMediaService-v2/docs/ATS_CLOUD_LOOKUP_FALLBACK.md) · Bridge: `docs/HANDOFF.md` |
| **ATS** | `C:\Users\Kowalenko\PycharmProjects\AeroTandemStudio-v2` | [`phases/open/53-cloud-lookup-fallback.md`](phases/open/53-cloud-lookup-fallback.md) |

**Status:** ⬜ Planung  
**Deploy-Reihenfolge:** **Cloud → AMS → ATS** (ATS erst nach Cloud+AMS-Deploy sinnvoll abnehmen)

---

## 1. Ziel

ATS soll die **Buchungssuche (Customer-Lookup)** nutzen können, auch wenn die AMS-Bridge gerade nicht erreichbar ist — **ohne** Customer-API-Keys in ATS zu legen.

| Mit AMS | Ohne AMS, Token gültig, Cloud erreichbar | Sonst |
|---------|------------------------------------------|--------|
| Lookup über AMS Bridge (Primärweg) | Lookup direkt gegen Cloud mit ATS-Client-JWT | Buchungssuche **offline** |

---

## 2. Leitentscheidungen (fest)

| # | Thema | Entscheidung |
|---|--------|----------------|
| 1 | Scope | **Nur Lookup** (QR/ID-Suche). Kein Handoff, Job-Status, Path-Hints, Create-Preflight über Cloud |
| 2 | Keys | Customer-API-Credentials bleiben bei **AMS** bzw. **Cloud-Server**; ATS bekommt nur scoped JWT |
| 3 | Token-Issuer | **Cloud** stellt JWT aus; **AMS** bootstrapped nach erfolgreicher Bridge-Auth |
| 4 | TTL | Access-JWT **48h**; kein Refresh-Token im MVP |
| 5 | Proactive Refresh | AMS verbunden **und** Restgültigkeit **&lt; 24h** → neues Token über AMS ziehen |
| 6 | Cloud-URL | kommt von **AMS-Instanz** (Health / Token-Response); ATS persistiert |
| 7 | Revocation | nur diese **`ats_instance_id`** (Token-Serie); nicht die ganze Org |
| 8 | Routing | AMS zuerst → sonst Cloud-JWT → sonst offline |
| 9 | Response-Shape | Cloud-Lookup-Response **kompatibel** zu AMS `POST /v1/customer/lookup` |
| 10 | Preflight Create | bleibt AMS-only / soft bei unreachable (unverändert) |

---

## 3. Ist-Stand (kurz)

### ATS
- Bridge: `ams_bridge_url` + `ams_bridge_token`, Identity-Header `X-Ats-Instance-Id` / Hostname / Version
- Lookup: `POST {ams}/v1/customer/lookup` (`src-tauri/src/bridge/mod.rs`)
- Gate: `can_run_ams_id_lookup` / `canRunAmsIdLookup` → braucht **connected** + Capability `lookup`

### AMS
- Bridge Lookup → Customer-API mit Secrets `aero_customer_base_url` + `aero_customer_api_token`
- Cloud-Upload separat: `custom_api_bearer_token` gegen Cloud API-Keys (`upload`/`read`/…)
- Health: `capabilities[]`, optional `ats_paths` (`paths-v1`) — Spec `docs/HANDOFF.md` §9

### Cloud (`cloud-kowalenko-io`)
- API-Keys: `lib/apiKeyService.ts`, Permissions `upload|read|shorten|delete`
- Customer-Daten: u. a. `lib/aeroMediaService.ts` → `aero-media-customer`
- Noch **kein** ATS-Client-JWT / Lookup-Proxy für Desktop-Clients

---

## 4. Architektur

```text
┌─────────┐  Bridge Auth (Token/Passwort)   ┌─────────┐  AMS API-Key (+ neue Permission)
│   ATS   │ ──────────────────────────────► │   AMS   │ ──────────────────────────────────┐
│         │ ◄── access_token, exp,          │         │                                   │
│         │     cloud_base_url              │         │                                   ▼
│         │                                 └─────────┘                          ┌────────────────┐
│         │  (AMS offline)                                                    │     Cloud      │
│         │  Bearer JWT + Lookup Body ─────────────────────────────────────► │  issue token   │
│         │ ◄── LookupResponse (AMS-kompatibel)                               │  proxy lookup  │
└─────────┘                                                                   │  revoke inst.  │
                                                                              └───────┬────────┘
                                                                                      │ server-side
                                                                                      ▼
                                                                              aero-media-customer
                                                                              (Credentials nur Server)
```

### Routing (ATS)

```text
if ams.connected && capability "lookup":
    POST ams /v1/customer/lookup
elif token.valid && cloud_base_url && cloud reachable:
    POST cloud /api/ats/v1/customer/lookup   # finaler Pfad in Cloud-Slice festlegen
else:
    UI: Buchungssuche offline
```

### Token-Refresh (ATS, nur bei AMS online)

```text
on AMS health ok:
  if no token OR (expires_at - now) < 24h:
    POST ams /v1/client-token   # oder Token im Health-Response — siehe AMS-Slice
    persist { access_token, expires_at, cloud_base_url, ams_server_instance_id }
```

---

## 5. API-Vertrag (Wire)

### 5.1 Cloud: Token ausstellen (nur AMS)

`POST /api/ats/v1/client-token`  
Auth: bestehender Cloud-API-Key von AMS (`Authorization: Bearer <keyId.secret>`), Permission neu: **`ats_client_token`** (Name final in Cloud-Slice).

Request:

```json
{
  "ats_instance_id": "uuid",
  "ams_server_instance_id": "uuid",
  "ats_hostname": "optional",
  "ats_version": "optional",
  "ats_app": "AeroTandemStudio"
}
```

Response `200`:

```json
{
  "access_token": "<jwt>",
  "token_type": "Bearer",
  "expires_at": "2026-10-09T12:00:00.000Z",
  "expires_in": 172800,
  "cloud_base_url": "https://…",
  "scope": ["customer.lookup"]
}
```

Fehler: `401` Key ungültig · `403` Permission fehlt · `400` Validation.

### 5.2 Cloud: Lookup (ATS mit JWT)

`POST /api/ats/v1/customer/lookup`  
Auth: `Authorization: Bearer <jwt>`  
Zusätzlich empfohlen: `X-Ats-Instance-Id` muss mit JWT-Claim übereinstimmen (sonst `401`).

Request (wie AMS Bridge):

```json
{
  "customer_id": "…",
  "booking_id": "…",
  "type": "Handcam|Outside",
  "mode": "hash|id"
}
```

Response (AMS-kompatibel):

```json
{
  "ok": true,
  "customer": { /* gleiche Felder wie Bridge-Kunde */ }
}
```

bzw. `ok: false` + `error: { code, message }` (`not_found`, upstream, …).

### 5.3 Cloud: Instanz widerrufen (Admin / intern)

`POST /api/ats/v1/client-token/revoke` (oder Admin-UI-Aktion)  
Body: `{ "ats_instance_id": "uuid" }`  
Wirkung: alle Tokens dieser Instanz ungültig; Lookup → `401`; ATS verwirft lokal.

### 5.4 JWT Claims (Minimal)

| Claim | Bedeutung |
|-------|-----------|
| `sub` / `ats_instance_id` | ATS-Installations-UUID |
| `ams_server_instance_id` | ausstellende AMS-Instanz |
| `scope` | `["customer.lookup"]` |
| `jti` | Token-ID (Revocation / Audit) |
| `iat`, `exp` | Ausgabe / Ablauf (Ziel TTL 48h) |
| `iss`, `aud` | Cloud-Issuer / `ats-lookup` |

Signatur: HMAC oder asymmetric (Cloud-Secret / JWKS) — **nur Cloud** verifiziert.

### 5.5 AMS Bridge (Erweiterung)

| Methode | Pfad | Zweck |
|---------|------|--------|
| `POST` | `/v1/client-token` | Nach Bridge-Auth: Cloud issue proxyen; Response an ATS |
| `GET` | `/v1/health` | optional `cloud_lookup: { base_url }` + Capability `cloud-lookup-v1` wenn Issue möglich |

Health bleibt schlank: volle Token-Ausgabe **nicht** bei jedem Quiet-Poll erzwingen — ATS ruft `/v1/client-token` gezielt bei fehlendem/kurz gültigem Token.

---

## 6. UI-Zustände (ATS)

| Zustand | Wann | Operator-Text (Skizze) |
|---------|------|-------------------------|
| AMS verbunden | Bridge health ok | „Buchungssuche verbunden“ (wie heute) |
| Cloud-Lookup | AMS weg, Token gültig, Cloud ok | „Buchungssuche über Cloud“ (Status/Tooltip) |
| Offline | weder AMS noch nutzbares Token/Cloud | „Buchungssuche nicht erreichbar“ |

Lookup-Gate: `amsLive || cloudLookupAvailable` (statt nur `connected`).

---

## 7. Sicherheit

- Scope nur `customer.lookup`
- Bindung an `ats_instance_id`; optional Match Header ↔ Claim
- TTL 48h; proactive Refresh nur über AMS
- Token nicht in Logs; Speicherung getrennt vom Klartext-`ams_bridge_token` (bevorzugt OS-Credential-Store / secrets-Tabelle; MVP: verschlüsselter lokaler Store analog anderer Secrets)
- Bei Cloud-`401`: Token verwerfen, UI offline/degraded
- Revoke nur Instanz; Audit-Log in Cloud (issue / lookup / revoke)
- Rate-Limit auf Cloud Lookup-Endpoint
- Keine Customer-API-Keys, keine Upload-Permissions im ATS-JWT

---

## 8. Non-Goals

- Customer-API-Keys in ATS
- Wochenlanges Cloud-Lookup ohne AMS-Touch (ohne Token-Erneuerung)
- Cloud-Handoff / Job-Status / SMB-Paths / Upload
- Create-Preflight über Cloud
- Org-weiter Kill-Switch bei einer kompromittierten Instanz
- Lokaler Buchungs-Cache (echtes Offline ohne Internet)
- Refresh-Token-Flow (später optional)

---

## 9. Slice-Übersicht & Reihenfolge

| Order | Slice | Repo | Inhalt |
|------:|-------|------|--------|
| 1 | **C0** | Cloud | DB: `ats_client_instances` / Revocation; JWT-Secret Config |
| 2 | **C1** | Cloud | `POST …/client-token` (AMS API-Key + Permission) |
| 3 | **C2** | Cloud | `POST …/customer/lookup` (JWT → aero-media-customer Proxy, AMS-Shape) |
| 4 | **C3** | Cloud | Revoke by `ats_instance_id` (+ Admin-Aktion) |
| 5 | **C4** | Cloud | Tests, Rate-Limit, Deploy-Checkliste |
| 6 | **A0** | AMS | Cloud-Base-URL für Lookup-Token (Config/Secret; oft = Custom-API-Base) |
| 7 | **A1** | AMS | `POST /v1/client-token` → Cloud C1 |
| 8 | **A2** | AMS | Health: `cloud_lookup` Hint + Capability `cloud-lookup-v1` |
| 9 | **A3** | AMS | Unit/Integration-Tests + `HANDOFF.md` §9.x |
| 10 | **T0** | ATS | Token-Store + Refresh-Regel (&lt;24h bei AMS ok) |
| 11 | **T1** | ATS | Cloud-Lookup-HTTP-Client (Rust) |
| 12 | **T2** | ATS | Lookup-Router AMS-first |
| 13 | **T3** | ATS | Gate, Status-UI, i18n (de/en/es-MX) |
| 14 | **T4** | ATS | Unit-Tests + manuelle Abnahme — ✅ ATS Unit (2026-10-07); E2E §10 nach C*/A* Deploy |

**Eine Agent-Session = ein Slice** (bzw. eine ATS-Phase-Teilaufgabe). Nicht Cloud+AMS+ATS in einer Session mischen.

---

## 10. Abnahmeszenarien (gesamt)

| # | Szenario | Erwartung |
|---|----------|-----------|
| 1 | AMS online, kein Token | Token wird gezogen; Lookup über AMS |
| 2 | AMS online, Token Rest &lt; 24h | Neues Token; Lookup weiter AMS |
| 3 | AMS online, Token Rest ≥ 24h | Kein unnötiger Issue-Call |
| 4 | AMS offline, Token gültig, Cloud ok | Lookup über Cloud; UI „über Cloud“ |
| 5 | AMS offline, Token abgelaufen | Offline; kein Customer-Key-Leak |
| 6 | AMS offline, kein Internet | Offline |
| 7 | Cloud Lookup `not_found` | Wie AMS: Formular/Hinweis, kein Crash |
| 8 | Instanz widerrufen | Cloud `401`; ATS Token weg; Offline bis AMS-Reconnect |
| 9 | Fremdes JWT / Instance-Mismatch | `401` |
| 10 | QR hash + Manual id | Beide Modi über Cloud wie über AMS |

---

## 11. Datei-Hints (Orientierung)

### Cloud
- `lib/apiKeyService.ts`, `lib/apiKeyConstants.ts` — Permission `ats_client_token`
- `lib/aeroMediaService.ts` — Customer-Fetch wiederverwenden / erweitern
- Neu: `lib/atsClientToken.ts` (sign/verify/revoke)
- Neu: `app/api/ats/v1/client-token/route.ts`, `…/customer/lookup/route.ts`
- Migration: Tabelle Revocation / Instance registry

### AMS
- `src-tauri/src/bridge/server.rs` — neue Route
- `src-tauri/src/bridge/types.rs` — Response/Health-Felder
- `src-tauri/src/cloud/custom_api/` — HTTP zum Cloud Issue
- `src-tauri/src/storage/secrets.rs` — ggf. Cloud-Base
- `docs/HANDOFF.md` §9 erweitern

### ATS
- `src-tauri/src/bridge/` — Router, Cloud-Client, Token-Store
- `src/lib/amsLookup.ts`, `canRunAmsIdLookup` → Booking-Lookup-Gate
- `src/store/amsBridgeStore.ts` / neuer `cloudLookupStore` — Status
- `src/components/ServerStatusIndicator.tsx`, i18n
- `src-tauri/src/storage/config.rs` — `cloud_lookup_*` Felder falls nötig

---

## 12. Schnell-Prompts

**Cloud**

```
Implementiere Slice C1 aus docs/ATS_CLOUD_LOOKUP_FALLBACK.md
Nur C1. Master: ATS docs/CLOUD_LOOKUP_FALLBACK_PLAN.md
```

**AMS**

```
Implementiere Slice A1 aus docs/ATS_CLOUD_LOOKUP_FALLBACK.md
Regeln/Bridge: docs/HANDOFF.md
Nur A1. Master-Vertrag: ATS docs/CLOUD_LOOKUP_FALLBACK_PLAN.md
```

**ATS**

```
Implementiere Phase 53 Slice T0 aus @docs/phases/open/53-cloud-lookup-fallback.md
Regeln: @AGENTS.md
Nur T0. Master: @docs/CLOUD_LOOKUP_FALLBACK_PLAN.md
```

---

*Letzte Aktualisierung: 2026-10-07 — Querschnittplan Cloud-Lookup-Fallback.*
