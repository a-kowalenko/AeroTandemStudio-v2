# Phase 14 — ML Foto-Klassifikation (optional, später)

> **Agent-Attach:** Diese Datei bei Bedarf (Backlog).
> Regeln: `@AGENTS.md` · Index: `@docs/IMPLEMENTATION_PLAN.md`

**Status:** ⬜ Backlog  
**Abhängigkeiten:** Phase 7  
**Ziel:** Handcam-Phasen automatisch erkennen (plane, door, exit, …)

#### Aufgaben

- [ ] Separates Python-Trainings-Repo (`AeroTandemStudio-ml`)
- [ ] Modell exportieren als ONNX
- [ ] `ort` (ONNX Runtime) in Rust — DirectML (Win) / CoreML (Mac) / optional Linux EP
- [ ] Tauri-Command `classify_photo(path)` → phase_label

---


