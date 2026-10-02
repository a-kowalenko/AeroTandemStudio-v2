//! OPT-24 B6: sync `#[tauri::command]`s run on the main thread in Tauri 2.
//! Only pure getters / flag setters may stay sync; everything with file, network,
//! process or SQLite work must be `async` + `spawn_blocking`.

use std::path::Path;

/// Sync commands that only touch memory (mutex / atomics / ring buffer / channels).
const SYNC_ALLOWLIST: &[&str] = &[
    // app.rs
    "get_app_info",
    "get_recent_logs",
    "clear_log_buffer",
    "get_log_min_level",
    "focus_main_window_after_update",
    "peek_post_update_restart",
    "consume_post_update_restart",
    // config.rs
    "get_config",
    "validate_kunde_cmd",
    // video.rs
    "has_video_cut_undo",
    "list_video_cut_marks",
    "clear_video_cut_undo",
    "discard_video_cut_undo_for_path",
    "cancel_encode",
    "cancel_upload_slot",
    "cancel_secondary_backup",
    "reset_workflow_cancel",
    "reset_upload_slot_cancel",
    "resolve_intro_mux_fallback",
    "resolve_body_concat_fallback",
    "resolve_reencode_confirm",
    "speculative_create_status",
    // media.rs
    "get_working_dir",
    "get_media_server_base",
    "has_photo_edit_undo",
    "list_photo_edit_marks",
    "clear_photo_edit_undo",
    "discard_photo_edit_undo_for_path",
    "preview_frame_extract_times",
    // sd_card.rs — `start_sd_monitor` installs a window subclass (must run on the UI thread).
    "start_sd_monitor",
    "stop_sd_monitor",
    "decline_sd_backup",
    "clear_sd_files",
    // updater/mod.rs
    "cancel_update_install",
    "get_updater_status",
    "get_updater_install_hint",
];

/// `(command fn name, is_async)` for every `#[tauri::command]` in `source`.
fn tauri_commands(source: &str) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    let mut pending = false;
    for line in source.lines() {
        let t = line.trim();
        if t.starts_with("#[tauri::command") {
            pending = true;
            continue;
        }
        if !pending || t.is_empty() || t.starts_with("#[") || t.starts_with("//") {
            continue;
        }
        pending = false;
        let rest = t.strip_prefix("pub ").unwrap_or(t);
        let (is_async, rest) = match rest.strip_prefix("async ") {
            Some(r) => (true, r),
            None => (false, rest),
        };
        if let Some(sig) = rest.strip_prefix("fn ") {
            let name: String = sig
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            out.push((name, is_async));
        }
    }
    out
}

fn sync_commands_outside_allowlist(source: &str) -> Vec<String> {
    tauri_commands(source)
        .into_iter()
        .filter(|(name, is_async)| !is_async && !SYNC_ALLOWLIST.contains(&name.as_str()))
        .map(|(name, _)| name)
        .collect()
}

#[test]
fn parser_detects_sync_and_async_commands() {
    let src = r#"
#[tauri::command]
pub fn get_config() -> u32 { 1 }

/// docs
#[tauri::command(rename = "x")]
#[allow(dead_code)]
pub async fn load_stuff<R: Runtime>(app: AppHandle<R>) {}

#[tauri::command]
pub fn new_io_command(path: String) -> bool { false }
"#;
    assert_eq!(
        tauri_commands(src),
        vec![
            ("get_config".to_string(), false),
            ("load_stuff".to_string(), true),
            ("new_io_command".to_string(), false),
        ]
    );
    assert_eq!(sync_commands_outside_allowlist(src), vec!["new_io_command"]);
}

#[test]
fn no_sync_io_commands_outside_allowlist() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files: Vec<_> = std::fs::read_dir(root.join("commands"))
        .expect("read commands dir")
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|ext| ext == "rs"))
        .filter(|p| !p.ends_with("sync_command_guard.rs"))
        .collect();
    files.push(root.join("updater").join("mod.rs"));

    let mut offenders = Vec::new();
    let mut total = 0usize;
    for file in files {
        let src = std::fs::read_to_string(&file).expect("read command source");
        total += tauri_commands(&src).len();
        for name in sync_commands_outside_allowlist(&src) {
            offenders.push(format!(
                "{}::{name}",
                file.file_name().unwrap().to_string_lossy()
            ));
        }
    }
    assert!(total > 50, "expected to find the command set, found {total}");
    assert!(
        offenders.is_empty(),
        "sync #[tauri::command] outside allowlist (make async + spawn_blocking or allowlist pure getters): {offenders:?}"
    );
}
