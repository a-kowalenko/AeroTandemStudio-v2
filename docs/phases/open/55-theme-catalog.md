# Phase 55 — Theme-Katalog + Settings-only

> **Agent-Attach:** Diese Datei (nicht Archiv/ganzen Plan).
> Regeln: `@AGENTS.md` · Index: `@docs/IMPLEMENTATION_PLAN.md`

**Status:** ✅ Umgesetzt  
**Abhängigkeiten:** Phase 54 (`themeStore`, `[data-theme]`, Settings Appearance, Boot-Splash)  
**Ziel:** Spezialthemes erweitern (Royal ×2, Rosa ×2, Military ×2, FSZ). Theme-Zyklus im Header entfernen — Auswahl nur in Settings/Wizard.

> Eine Agent-Session = nur Phase 55.

---

## Leitentscheidungen

| # | Thema | Entscheidung |
|---|--------|----------------|
| 1 | Katalog | `royal-navy`, `royal-flag`, `rose-noir`, `rose-blush`, `military-olive`, `military-khaki`, `fsz` (+ bestehende light/dark/team-spirit/spirit-2) |
| 2 | Rosa | beide: `rose-noir` (dark) + `rose-blush` (light) |
| 3 | Royal | beide: Navy-Luxury + Flag Blue |
| 4 | Military | Olive (`#7a8f3e`) + Khaki (`#c4a35a`); Legacy-IDs `military-od`/`military-camo` → migriert |
| 5 | FSZ | Logo-Rot nur Destructive + Progress; Primary = helles Neutral (`#f0ecec`) |
| 6 | Rosa | Primary ≠ Danger: Noir Cream / Blush Plum; Rose nur Accent + Progress |
| 7 | Progress-Floats | Alle Themes: dichte Platten + lesbare Labels (`text-foreground/…`) |
| 6 | Auswahl | kein Header-Cycle; Settings + Wizard Appearance-Grid |
| 7 | Favicon | bleibt ATS |

---

## Tokens (Kern)

Siehe `src/index.css` Blöcke `[data-theme="…"]`. FSZ-Primary = Logo-Rot `#a10f1d`.

---

## Technik

| Schicht | Änderung |
|---------|----------|
| `themeStore` | neue IDs; `toggle` entfernt |
| `ThemeToggle` | Datei entfernt; Cluster ohne Cycle |
| `index.css` | Token + Ambient (FSZ, Camo) + Glass-Gruppen |
| `index.html` | Boot KNOWN/BASE_DARK + Splash-Vars + FSZ-Logo |
| `themeLogo.ts` | FSZ (+ Team Spirit) |
| Settings / Wizard | Icons für alle Themes |
| i18n | Labels de/en/es-MX |

---

## Out of Scope

- AppConfig / AMS
- Favicon je Theme
- Font-/Layout-Redesign
- Export-Branding

---

## Agent-Prompt

```
Implementiere Phase 55 aus @docs/phases/open/55-theme-catalog.md
Regeln: @AGENTS.md
Nur 55.
Danach npm run check && npm run tauri dev.
```
