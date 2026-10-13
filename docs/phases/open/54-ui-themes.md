# Phase 54 — UI-Themes (Team Spirit)

> **Agent-Attach:** Diese Datei (nicht Archiv/ganzen Plan).
> Regeln: `@AGENTS.md` · Index: `@docs/IMPLEMENTATION_PLAN.md`

**Status:** ✅ Umgesetzt (Theme-IDs, Team-Spirit-Tokens, Logo, Settings/Wizard/Toggle, Boot-Splash, i18n)  
**Abhängigkeiten:** Theme-Tokens in `index.css`, `themeStore`, Settings Appearance (Phase 47), Boot-Splash (OPT-24)  
**Ziel:** Theme-System von Hell/Dunkel auf **Theme-IDs** erweitern. Light und Dark bleiben. Erstes Spezialdesign: **Team Spirit** (Schwarz / Gold / knappes Rot) inkl. Logo.

> Eine Agent-Session = nur Phase 54. Keine weiteren Spezialthemes, kein AppConfig, kein Favicon-Wechsel.

---

## Leitentscheidungen

| # | Thema | Entscheidung |
|---|--------|----------------|
| 1 | Modell | `ThemeId = "light" \| "dark" \| "team-spirit" \| "spirit-2"` (Katalog erweiterbar) |
| 2 | Basis | Jedes Theme hat `base: "light" \| "dark"` → steuert Klasse `.dark` für Tailwind-`dark:` |
| 3 | Tokens | Skin-Overrides nur über `[data-theme="…"]` auf `--ats-*`; `:root` / `.dark` bleiben ATS-Defaults |
| 4 | Persistenz | `localStorage["ats-theme"]` (nicht AppConfig); unbekannte Werte → Systempräferenz → light/dark |
| 5 | Logo | Bei `team-spirit`: Header + Splash + Boot-Splash → `/themes/team-spirit/logo.png`; sonst `/logo.png`. App-Titel bleibt ATS |
| 6 | Header-Toggle | `ThemeToggle` zyklisch über alle registrierten Themes |
| 7 | Status-Chips | `emerald`/`amber`/`sky` + `dark:` unverändert |
| 8 | Favicon | bleibt `/logo.png` |

---

## Team-Spirit-Tokens

| Token | Wert |
|-------|------|
| `--ats-bg` | `#0a0a0a` |
| `--ats-fg` | `#f5f5f5` |
| `--ats-card` / elevated | `#141414` / `#1a1a1a` |
| `--ats-muted` | `#a3a39a` |
| `--ats-border` | `rgba(245,245,245,0.12)` |
| `--ats-primary` | `#B59546` |
| `--ats-primary-fg` | `#0a0a0a` |
| `--ats-primary-soft` | `rgba(181,149,70,0.16)` |
| `--ats-accent` | `#C9A84C` |
| `--ats-destructive` | `#D80000` |
| Glow / Progress | schwaches Gold / sehr schwaches Rot; Progress Gold→helleres Gold |

### Spirit 2 (A/B, v1 unverändert)

| Token | Wert | Hinweis |
|-------|------|---------|
| `--ats-primary` | `#C4A052` | etwas helleres Gold |
| `--ats-destructive` | `#E04A4A` | Spirit-Rot, UI-tauglicher als `#D80000` |
| `--ats-success` | `#A8B85C` | Olive-Gold statt Mint-Grün |
| Emerald-Scale | remapped | `emerald-*` Utilities → Olive (verbunden / Medien / Wizard) |

Logo: gleiches Asset wie Team Spirit (`logo.svg`). Ambient: zentriertes Watermark.  
**Spirit 2:** Shell = luftiges Liquid Glass; Float (QR / Progress / Upload / Dialog / Toast) = dichtere Platte für Lesbarkeit, gleiche Hairline/Frost-Sprache.

---

## Technik

| Schicht | Änderung |
|---------|----------|
| `themeStore` | `ThemeId`, `THEMES`, `applyDom`, Zyklus, Migration light/dark |
| `index.css` | `html.dark[data-theme="team-spirit"]` Token-Block |
| `index.html` | Boot-Script erkennt `team-spirit`; Splash-Vars + Logo |
| Settings / Wizard | Appearance-Grid über `THEMES` |
| `ThemeToggle` | Zyklus + Icon je Theme |
| `themeLogo.ts` | Pfad-Resolver |
| HeaderBrand / SplashScreen | Logo aus Resolver |
| Asset | `public/themes/team-spirit/logo.svg` (+ optional PNG) |
| Ambient | `html[data-theme]::before` zentriertes Watermark + sanfter Drift |
| i18n | `common.labels.themeTeamSpirit` de/en/es-MX |

---

## Out of Scope

- Weitere Spezialthemes (nur Katalog-Hook)
- Theme in AppConfig / AMS
- Favicon je Theme
- Umbau Status-Farben
- Font-/Layout-Redesign
- Export-/Wasserzeichen-Branding

---

## Manuelle Abnahme

| # | Fall |
|---|------|
| A | Light/Dark unverändert |
| B | Team Spirit: Gold-Primary, schwarzer BG |
| C | Persistenz nach Restart inkl. Boot-Splash |
| D | Logo wechselt nur bei Team Spirit |
| E | Wizard Appearance wählt Team Spirit |
| F | Unbekannter localStorage-Wert → Fallback |

---

## Referenzen

```
src/store/themeStore.ts
src/lib/themeLogo.ts
src/index.css
index.html
src/components/ThemeToggle.tsx
src/components/settings/tabs/GeneralTab.tsx
src/components/SetupWizard.tsx
src/components/chrome/HeaderBrand.tsx
src/components/SplashScreen.tsx
public/themes/team-spirit/logo.png
src/locales/de.json | en.json | es-MX.json
```

---

## Agent-Prompt

```
Implementiere Phase 54 aus @docs/phases/open/54-ui-themes.md
Regeln: @AGENTS.md
Nur 54.
Danach npm run check && npm run tauri dev.
```
