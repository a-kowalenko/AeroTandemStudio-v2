//! Optional mpv / libmpv playback backend for Cutter & clip player (OPT-13).
//!
//! ## Playback model
//! - Preferred: **mpv JSON-IPC** process driven from Rust (`idle` + local file path).
//! - Frames for the WebView: `screenshot-to-file` → JPEG under a session temp dir,
//!   served via the existing loopback media HTTP server (same Range/URL idea as HTML5).
//! - When mpv is missing (CI / Dev without install): frontend keeps HTML5 `VideoPlayer`.
//!
//! Working-copy paths are passed as absolute filesystem paths (`loadfile`), not
//! `asset://` / `media://` URLs — mpv reads the file directly.
//!
//! Packaging: see `docs/MACOS_BUILD.md`, `docs/LINUX_BUILD.md`, and
//! `src-tauri/resources/mpv/README.md`.

pub mod detect;
pub mod ipc;
pub mod session;

pub use detect::{mpv_availability, MpvAvailability};
pub use session::{MpvSessionInfo, MpvSessionManager, SessionSnapshot};
