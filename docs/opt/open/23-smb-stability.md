# OPT-23 — SMB: Stabilität, Mapping-Treffer, Session-Hygiene

> **Agent-Attach:** Diese Datei (nicht `@docs/opt/ARCHIVE.md` / ganzen Plan).
> Regeln: `@AGENTS.md` · Index: `@docs/optimization_plan.md`

**Status:** 🔄 Slice A+B ✅; C–F offen  
**Abhängigkeiten:** OPT-17–20 (Mapping, Prefer-Local, Auto-Mount), OPT-22 A+B+C (Quiet-Budget, Pool, Host-Mutex)  
**Voraussetzung:** Working-Tree-Änderung „Health hinter Host-Mutex“ (`host_lock::gate_health_connect`, `QuietSkipReason::HostBusy`, Pool-Permit bis Disconnect) ist committed — Slice A baut darauf auf.

**Ziel:** Weniger smb2-SessionSetups und weniger gleichzeitige Sessions pro Client, ohne neue Features:
OS-Mappings häufiger treffen, Health leichter machen, Hänger/Thread-Stau nach Standby beseitigen.

**Impact:** hoch (Win11-AMS ~20-Session-Limit, Sleep/Wake, Fleet)  
**Aufwand:** M–L (sechs kleine Slices)  
**Risiko:** niedrig–mittel (Slice D/E ändern Pfad- bzw. Health-Semantik)

> **Session-Regel:** Eine Agent-Session = **ein Slice**. Nicht kombinieren. Kein OPT-21 / Phase-23 / 31.5.

---

#### Produktentscheidungen (fest)

| # | Thema | Entscheidung |
|---|--------|--------------|
| P1 | Prefer Local bleibt König | OS-Map / Mount / (Windows) UNC über Redirector vor jedem smb2-SessionSetup |
| P2 | Health ist billig | Quiet-Health darf **keinen** Host-Session-Slot dauerhaft belegen |
| P3 | Laut bleibt verbindlich | Boot-Check + „Verbindung testen“ prüfen Login + Share wirklich (SessionSetup + TreeConnect) |
| P4 | Keine UI-Hänger | Kein Tauri-Command blockiert einen Tokio-Worker mit Netz-FS-Calls; kein Laut-Check wartet unbegrenzt |
| P5 | Keine neuen Settings-Toggles | Logs + bestehende `soft_hold`-UX reichen (wie OPT-22 P7) |
| P6 | Upload-Durchsatz | OPT-15 Worker-Caps und Upload-Session-Ownership unverändert |

---

#### Ist-Befunde (Review 2026-09-30)

| # | Befund | Ort | Folge |
|---|--------|-----|-------|
| F1 | Pool-`IDLE_TTL` 45 s, Quiet-OK-Backoff 180 s, Reap **nur** in `acquire()` | `session_pool.rs`, `quiet_budget.rs` | Health-Pool trifft nie; Idle-Session bleibt ~180 s+ offen und wird dann trotzdem neu aufgebaut |
| F2 | Laut-Check wartet ohne Timeout auf Host-Mutex | `host_lock::gate_health_connect(_, false)` | „Verbindung testen“ hängt während langem Upload/Backup |
| F3 | Pool-Hit mit toter Session → sofort Fehler + Quiet-Backoff | `test_smb_connection` | Falsch-rot nach NAS-Standby / Samba `deadtime` |
| F4 | Jeder Timed-Probe spawnt OS-Thread; bei hängendem Redirector stauen sich Threads (Cache nur 2 s, Promote alle ~2,75 s) | `reconnect::path_reachable_timed` | Thread-Stau nach Standby |
| F5 | Sync-Netz-FS in `async`: `resolve_server_target` (WNet ×26, Probe 1,5 s, Auto-Mount bis ~8 s + `thread::sleep`) | `client.rs::test_connection`, `upload_path` | Tokio-Worker blockiert |
| F6 | Probe auf **Unterpfad** (`Z:\jobs\neu`); fehlt Ordner → `Unreachable` → smb2-Bridge + 90-s-Promote | `apply_os_smb_mapping` | Zweite Session obwohl `Z:` lebt; `exists()` = false auch bei Access-Denied |
| F7 | `note_map_needs_reconnect` löscht positiven Cache **aller** Pfade | `reconnect.rs` | Unnötige Re-Probes |
| F8 | Host-Vergleich nur per String (IP ↔ Name ↔ FQDN) | `match_unc_to_mapped_path`, `canonical_host_key` | Map wird nicht erkannt → smb2 parallel zur OS-Session |
| F9 | Windows: nur Laufwerksbuchstaben A–Z enumeriert | `list_smb_drive_mappings_windows` | `net use \\host\share` / Explorer-Verbindungen ohne Buchstabe unsichtbar |
| F10 | macOS `f_mntfromname` percent-encoded (`my%20share`) nicht dekodiert | `unix_mapping::unc_from_mount_source` | Shares mit Leerzeichen/Umlauten matchen nie |
| F11 | Windows Auto-Mount: `ERROR_SESSION_CREDENTIAL_CONFLICT` (1219) nicht behandelt | `auto_mount::mount_windows` | Fallback smb2 → Extra-Session neben bestehender OS-Session |
| F12 | Passwort in Prozess-Argumenten (`mount_smbfs //u:p@…`, `gio mount smb://u:p@…`); gio-stdin-Reihenfolge fragil | `auto_mount.rs` | Sichtbar per `ps`; Linux-Mount unzuverlässig |

---

#### Slices

| Slice | Titel | Befunde | Impact | Aufwand | Status |
|-------|-------|---------|--------|---------|--------|
| **A** | Session-Lebensdauer + Health-Gate | F1, F2, F3 | hoch | S | ✅ |
| **B** | Local-Probe robust (Single-Flight, off-runtime, Root-Probe) | F4, F5, F6, F7 | hoch | M | ✅ |
| **C** | Mapping-Treffer (Host-Alias, macOS-Decode) | F8, F10 | hoch | S–M | ⬜ |
| **D** | Windows: UNC direkt + deviceless Auto-Mount + 1219 | F9, F11 | hoch | M | ⬜ |
| **E** | Quiet-Health per TCP-Probe + Transfer-Piggyback | F1 (Rest), P2 | mittel | S–M | ⬜ |
| **F** | Credentials aus argv (macOS/Linux Auto-Mount) | F12 | mittel (Security) | M | ⬜ |

**Empfohlene Reihenfolge:** A → B → C → E → D → F  
(A/B sind reine Bugfixes ohne Semantikänderung; D ändert den bevorzugten Windows-Pfad und braucht Abnahme.)

---

#### Slice A — Session-Lebensdauer + Health-Gate

**Ziel:** Health belegt nach dem Check keinen Host-Slot; Laut-Check hängt nie; tote Pool-Session ≠ Server offline.

##### Entscheidungen

| # | Thema | Entscheidung |
|---|--------|--------------|
| A1 | Health-Session | `test_smb_connection` gibt Session nach Erfolg per `discard()` (Disconnect) zurück, **nicht** `release()` — Pool bleibt für GC-Bursts |
| A2 | Hintergrund-Reaper | Ein Prozess-Task (`tokio::time::interval`, z. B. 15 s) ruft `reap_idle()`; startet lazy beim ersten `acquire` |
| A3 | `IDLE_TTL` | Auf **20 s** senken (reicht für GC-Rounds; Test `idle_ttl_is_in_spec_window` anpassen) |
| A4 | Laut + Host belegt | `tokio::time::timeout(3 s, acquire)`; bei Ablauf `ok: true`, Meldung „Übertragung aktiv — Verbindung besteht“, **kein** SessionSetup |
| A5 | Stale Pool-Hit | Fehler direkt nach Pool-**Hit** → Session verwerfen, **einmal** frisch verbinden; erst dieser Fehler zählt für Quiet-Backoff |
| A6 | Connect-Timeout Health | `connect_smb` bekommt Timeout-Parameter; Health 5 s, Upload/GC weiter 10 s |

##### Scope

- [x] `session_pool.rs`: Reaper-Task, `IDLE_TTL`, `acquire` liefert `was_hit` (oder Enum) für A5
- [x] `host_lock.rs`: `gate_health_connect` → Variante `LoudBusy` nach Timeout
- [x] `client.rs`: `test_smb_connection` A1/A4/A5/A6
- [x] Unit-Tests: Reaper räumt ohne weiteren `acquire`; Laut-Timeout liefert `LoudBusy`; Stale-Hit-Retry (Fake-Fehler-Pfad wo machbar)
- [x] `cargo test`

**Out of scope:** TCP-Probe (→ E), Poll-Intervall im Frontend, Upload-Session-Ownership.

##### Akzeptanz

- [ ] smb2-only Idle 10 min: `Get-SmbSession` zeigt zwischen Checks **0** Sessions dieses Clients (außer ≤ 20 s nach GC)
- [ ] „Verbindung testen“ während 10-min-Upload antwortet ≤ 3 s, grün, ohne neues SessionSetup im Log
- [ ] NAS-Standby → nächster Laut-Check grün (Stale-Hit-Retry), kein Quiet-Backoff-Eintrag
- [x] `cargo test` grün

---

#### Slice B — Local-Probe robust

**Ziel:** Kein Thread-Stau, kein blockierter Tokio-Worker, fehlender Unterordner erzwingt keine smb2-Bridge.

##### Entscheidungen

| # | Thema | Entscheidung |
|---|--------|--------------|
| B1 | Single-Flight | `path_reachable_timed`: pro Cache-Key max. **ein** laufender Probe-Thread; weitere Aufrufer warten bis `timeout` auf dasselbe Ergebnis (oder `TimedOut`) — kein neuer Thread |
| B2 | Off-Runtime | `resolve_server_target` in `test_connection` und `upload_path` via `tauri::async_runtime::spawn_blocking` (Muster wie `media_file_url`) |
| B3 | Root-Probe | Reachability am **Mapping-Root** (`Z:\`, Mount-Root); Unterpfad danach per `metadata` klassifizieren |
| B4 | Fehlerklassen | `ProbeOutcome` += `Missing` (NotFound unter lebendem Root), `Denied` (PermissionDenied); `Missing` ⇒ **Local** (Upload legt an, Health meldet „Zielordner fehlt, wird angelegt“), `Denied` ⇒ Local + klare Meldung, **kein** smb2-Fallback |
| B5 | Cache-Invalidierung | `note_map_needs_reconnect` löscht nur Einträge unter dem betroffenen Local-Root |

##### Scope

- [x] `reconnect.rs`: In-flight-Map (B1), `ProbeOutcome` (B4), gezielte Invalidierung (B5)
- [x] `client.rs::apply_os_smb_mapping`: Root-Probe + Klassifizierung (B3/B4)
- [x] `client.rs`: `spawn_blocking` um Resolve (B2)
- [x] `auto_mount.rs`: `path_reachable` / `wait_until_reachable` nutzen Timed-Probe (kein nacktes `exists()`)
- [x] Unit-Tests: Single-Flight (zweiter Aufruf spawnt nicht, Zähler), Missing-unter-Root ⇒ Local, Invalidierung nur Prefix
- [x] `cargo test`

**Out of scope:** Host-Alias (→ C), Windows UNC direkt (→ D).

##### Akzeptanz

- [ ] Standby-Wake mit hängendem `Z:`: Anzahl `smb-local-probe`-Threads bleibt ≤ Anzahl distinct Pfade
- [ ] Config-Unterordner fehlt auf `Z:`: Log `SMB via mapped drive`, **kein** `smb2 bridge`
- [ ] UI bleibt während Auto-Mount-Versuch bedienbar (keine Frame-Hänger durch Command)
- [x] `cargo test` grün

---

#### Slice C — Mapping-Treffer (Host-Alias, macOS-Decode)

**Ziel:** Bestehende OS-Mappings werden erkannt, auch wenn Config und Map unterschiedliche Host-Schreibweisen nutzen.

##### Entscheidungen

| # | Thema | Entscheidung |
|---|--------|--------------|
| C1 | Stufe 1 | String-Match wie heute (schnell, kein DNS) |
| C2 | Stufe 2 | Nur wenn Stufe 1 keinen Treffer hat **und** Mappings mit gleichem Share-Namen existieren: beide Hosts zu IP-Mengen auflösen (`ToSocketAddrs`, Port 445), Schnittmenge ⇒ Treffer |
| C3 | DNS-Budget | Auflösung off-runtime, Timeout 1 s pro Host, Cache 5 min (positiv) / 60 s (negativ) |
| C4 | Short-Name ↔ FQDN | Zusätzlich billiger Vergleich erstes Label (`nas` ↔ `nas.local`) vor DNS |
| C5 | Host-Lock-Key | `canonical_host_key` nutzt denselben Alias-Resolver (IP-Menge sortiert ⇒ Key); Fallback String |
| C6 | macOS | `unc_from_mount_source` percent-decodet Host- und Pfadsegmente (`percent_decode_str`) |

##### Scope

- [ ] Neu `smb/host_alias.rs` (Resolver + Cache, testbar mit injizierbarem Lookup)
- [ ] `windows_mapping.rs::match_unc_to_mapped_path`: Stufe 2 via Resolver
- [ ] `host_lock.rs`: Key über Resolver
- [ ] `unix_mapping.rs`: Percent-Decode
- [ ] Unit-Tests: IP ↔ Name via Fake-Resolver, Short ↔ FQDN, Negativ-Cache, `my%20share`
- [ ] `cargo test`

**Out of scope:** Deviceless Windows-Verbindungen (→ D), Bonjour-`_smb._tcp`-Auflösung.

##### Akzeptanz

- [ ] Config `smb://<IP>/aktuell`, Map `Z: → \\NAS\aktuell`: Log `SMB via mapped drive`, kein smb2
- [ ] macOS Finder-Mount „my share“: wird als Local erkannt
- [ ] Kein DNS-Lookup, wenn Stufe 1 trifft (Log/Zähler)
- [ ] `cargo test` grün

---

#### Slice D — Windows: UNC direkt + deviceless Auto-Mount + 1219

**Ziel:** Auf Windows den OS-Redirector nutzen, **ohne** Laufwerksbuchstaben — eine Session pro Server/Credential-Set, geteilt mit Explorer.

> Hebt den Eintrag „Letter-less UNC ohne Drive-Letter“ in `docs/opt/OUT_OF_SCOPE.md` auf (dort bei Umsetzung entfernen).

##### Entscheidungen

| # | Thema | Entscheidung |
|---|--------|--------------|
| D1 | Enumeration | Zusätzlich `WNetOpenEnum(RESOURCE_CONNECTED, RESOURCETYPE_DISK)` — deviceless Verbindungen als `DriveMapping { local_name: "\\\\host\\share" }` |
| D2 | UNC-Local | `is_usable_local_root` akzeptiert UNC-Root; `ServerTarget::Local { path: \\host\share\sub }` (std::fs über Redirector) |
| D3 | UNC-Probe | Ohne gelistete Verbindung: timed Probe auf `\\host\share` (Redirector nutzt vorhandene Credentials); reachable ⇒ Local, sonst weiter |
| D4 | Auto-Mount | `WNetAddConnection2W` mit `lpLocalName = NULL` (deviceless); Registry-Eintrag mit UNC als `local_path`; Unmount via `WNetCancelConnection2W(UNC)` |
| D5 | 1219 | Bei `ERROR_SESSION_CREDENTIAL_CONFLICT`: Retry mit `NULL`-User/Passwort (vorhandene Session); Erfolg ⇒ Local; sonst WARN mit Klartext „andere Anmeldung zu diesem Server aktiv“ + smb2 |
| D6 | Reihenfolge | Drive-Map (heute) → deviceless-Verbindung (D1) → UNC-Probe (D3) → Auto-Mount deviceless (D4) → smb2 |
| D7 | Buchstaben | Bestehende App-owned Letter-Mounts bleiben unmountbar (Registry-Kompatibilität) |

##### Scope

- [ ] `windows_mapping.rs`: WNetOpenEnum, UNC-Roots zulassen
- [ ] `auto_mount.rs::mount_windows`: deviceless + 1219-Pfad; `find_free_drive_letter` nur noch Legacy
- [ ] `client.rs::apply_os_smb_mapping`: Reihenfolge D6
- [ ] Unit-Tests: UNC-Root-Join, Matching mit UNC-`local_name`, Registry-Roundtrip deviceless
- [ ] `cargo test`; manuell Windows: `net use \\host\share` ohne Buchstabe, Auto-Mount an/aus, 1219-Szenario

**Out of scope:** macOS NetFS, Linux; Credential-Manager-Integration.

##### Akzeptanz

- [ ] `net use \\nas\aktuell` (ohne Buchstabe) ⇒ Upload/Health Local, `Get-SmbSession` am Host: 1 Session
- [ ] Auto-Mount erzeugt **keinen** Laufwerksbuchstaben, Quit räumt Verbindung ab
- [ ] 1219 ⇒ Local über bestehende Session oder klare WARN; kein stilles smb2
- [ ] `cargo test` grün

---

#### Slice E — Quiet-Health per TCP-Probe + Transfer-Piggyback

**Ziel:** Quiet-Poll belegt auf dem smb2-Pfad **nie** einen Session-Slot.

##### Entscheidungen

| # | Thema | Entscheidung |
|---|--------|--------------|
| E1 | Quiet smb2-Pfad | Nur `TcpStream::connect(host:port)` mit 2 s Timeout; offen ⇒ `ok` (Meldung „Server erreichbar“), kein SessionSetup |
| E2 | Laut unverändert | Boot / manuell / Visibility nach > 10 min Hidden: voller Check (P3) |
| E3 | Auth-Fehler merken | Letzter Laut-Fehler „Login/Share“ bleibt sticky: Quiet-TCP-OK überschreibt ihn **nicht** mit grün (`soft_hold`) |
| E4 | Piggyback | Upload/Backup/GC-Ergebnis emittiert `smb-health` (ok/fail + Host); `serverStore` übernimmt Status und setzt Poll-Timer zurück |
| E5 | Backoff | `QUIET_OK_BACKOFF` bleibt für SessionSetup-Pfad (Laut-Kicks); TCP-Probe unterliegt keinem Backoff (billig) |
| E6 | Jitter | Frontend-Poll ±10 % Jitter (Fleet-Wake nach NAS-Neustart entzerren) |

##### Scope

- [ ] `client.rs::test_connection(quiet)`: TCP-Probe-Zweig (E1/E3)
- [ ] `commands/smb.rs` + Upload/Backup-Aufrufer: Event `smb-health` (E4)
- [ ] `useServerHealthPoll.ts` / `serverStore.ts`: Event-Listener, Timer-Reset, Jitter
- [ ] Unit-Tests Rust: TCP-Probe gegen lokalen Listener / geschlossenen Port; sticky Auth-Fehler
- [ ] `cargo test` + `npm run check`

**Out of scope:** Local-Pfad-Health (bleibt Timed-Probe), AMS-Health.

##### Akzeptanz

- [ ] smb2-only Idle 30 min: **0** SessionSetups durch Quiet (Log), Status bleibt grün
- [ ] Falsches Passwort nach Boot-Check bleibt rot trotz TCP-OK
- [ ] Nach Upload-Ende springt Status ohne zusätzlichen Check
- [ ] `cargo test` + `npm run check` grün

---

#### Slice F — Credentials aus argv (macOS/Linux Auto-Mount)

**Ziel:** Passwort taucht in keiner Prozessliste auf; Linux-Mount deterministisch.

##### Entscheidungen

| # | Thema | Entscheidung |
|---|--------|--------------|
| F1 | macOS | `NetFSMountURLSync` (NetFS.framework via FFI) mit User/Passwort als Parameter, Mountpoint unter `smb-mounts/` (OPT-20A bleibt); Fallback `mount_smbfs` **ohne** Passwort in URL (Keychain / `-N` nur Guest) |
| F2 | Linux | `gio mount` ohne Passwort in URL; Passwort nur über stdin; Prompt-Reihenfolge per Antwort-Datei robust (User → Domain → Passwort) oder `gio mount` mit Timeout + klarer WARN |
| F3 | Logs | Keine URL mit Auth-Teil in Logs (Test: Redaction) |

##### Scope

- [ ] `auto_mount.rs`: F1/F2/F3
- [ ] Unit-Tests: URL-Builder ohne Passwort, Redaction
- [ ] `cargo test`; manuell macOS + Linux-VM (`docs/LINUX_BUILD.md`)

**Out of scope:** Windows (keine argv-Problematik, WNet-API), Keychain-Verwaltung-UI.

##### Akzeptanz

- [ ] `ps aux` während Mount zeigt kein Passwort (macOS, Linux)
- [ ] Linux gvfs-Mount mit Passwort funktioniert reproduzierbar
- [ ] `cargo test` grün

---

#### Betroffene Dateien (erwartet)

| Slice | Dateien |
|-------|---------|
| A | `smb/session_pool.rs`, `smb/host_lock.rs`, `smb/client.rs` |
| B | `smb/reconnect.rs`, `smb/client.rs`, `smb/auto_mount.rs` |
| C | neu `smb/host_alias.rs`, `smb/windows_mapping.rs`, `smb/unix_mapping.rs`, `smb/host_lock.rs` |
| D | `smb/windows_mapping.rs`, `smb/auto_mount.rs`, `smb/client.rs`, `docs/opt/OUT_OF_SCOPE.md` |
| E | `smb/client.rs`, `commands/smb.rs` (+ Backup-Aufrufer), `src/hooks/useServerHealthPoll.ts`, `src/store/serverStore.ts` |
| F | `smb/auto_mount.rs` |

#### Risiken & Mitigation

| Risiko | Mitigation |
|--------|------------|
| A: Health ohne Pool ⇒ jeder Laut-Check = SessionSetup | Laut ist selten (Boot/manuell); Quiet läuft ab E ohne Session |
| B: `Missing` als Local maskiert falsche Config | Health-Meldung „Zielordner fehlt, wird angelegt“; Upload legt an |
| C: DNS langsam / falsch | Nur Stufe 2, Timeout 1 s, Cache, off-runtime; String-Match bleibt primär |
| D: UNC-Local ändert bewährten Windows-Pfad | Reihenfolge D6 hält Drive-Map zuerst; manuelle Abnahme Pflicht |
| E: TCP-OK obwohl Share weg | Laut-Check bei Boot/Visibility; Upload meldet echte Fehler; E3 sticky Auth |
| F: NetFS-FFI Aufwand | Fallback `mount_smbfs` ohne Passwort; Slice optional nach Bedarf |

#### Messnotiz (nach Implementierung ausfüllen)

| Szenario | Metrik | Vorher | Nachher | Notiz |
|----------|--------|--------|---------|-------|
| smb2-only Idle 30 min | SessionSetups / offene Sessions | 1 pro ~180 s, Session klebt | | A + E |
| „Verbindung testen“ während Upload | Antwortzeit | bis Upload-Ende | | A4 |
| Standby-Wake, `Z:` hängt | Probe-Threads | wachsend | | B1 |
| Config-Unterordner fehlt auf `Z:` | smb2-Bridge | ja | | B3 |
| Config IP, Map Hostname | Pfad | smb2 | | C |
| `net use` ohne Buchstabe | Pfad | smb2 | | D |

#### Agent-Prompts

```
Implementiere OPT-23 Slice A aus @docs/opt/open/23-smb-stability.md
Regeln: @AGENTS.md
Nur OPT-23A (Session-Lebensdauer + Health-Gate). Danach cargo test --manifest-path src-tauri/Cargo.toml.
```

```
Implementiere OPT-23 Slice B aus @docs/opt/open/23-smb-stability.md
Regeln: @AGENTS.md
Nur OPT-23B (Local-Probe robust). Danach cargo test --manifest-path src-tauri/Cargo.toml.
```

```
Implementiere OPT-23 Slice C aus @docs/opt/open/23-smb-stability.md
Regeln: @AGENTS.md
Nur OPT-23C (Mapping-Treffer Host-Alias + macOS-Decode). Danach cargo test --manifest-path src-tauri/Cargo.toml.
```

```
Implementiere OPT-23 Slice E aus @docs/opt/open/23-smb-stability.md
Regeln: @AGENTS.md
Nur OPT-23E (Quiet TCP-Probe + Piggyback). Danach cargo test --manifest-path src-tauri/Cargo.toml && npm run check.
```

```
Implementiere OPT-23 Slice D aus @docs/opt/open/23-smb-stability.md
Regeln: @AGENTS.md
Nur OPT-23D (Windows UNC direkt + deviceless + 1219). Danach cargo test --manifest-path src-tauri/Cargo.toml.
```

```
Implementiere OPT-23 Slice F aus @docs/opt/open/23-smb-stability.md
Regeln: @AGENTS.md
Nur OPT-23F (Credentials aus argv). Danach cargo test --manifest-path src-tauri/Cargo.toml.
```

---
