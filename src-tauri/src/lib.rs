mod commands;
mod constants;
mod media;
mod model;
mod qr;
mod sd_card;
mod smb;
mod storage;
mod updater;
mod util;
mod video;

use commands::app::{
    cleanup_cache, clear_log_buffer, get_app_info, get_recent_logs, run_startup_checks,
};
use commands::config::{
    ensure_default_media_dirs_cmd, get_config, get_config_paths, propose_default_media_dirs_cmd,
    reload_config, reset_config, save_config, validate_kunde_cmd, ConfigState,
};
use commands::media::{
    clear_photo_edit_undo, clear_working_session, crop_photo, delete_working_copy,
    discard_photo_edit_undo_for_path, expand_media_paths, get_file_sizes, get_media_server_base,
    get_working_dir, has_photo_edit_undo, import_photos, list_photo_edit_marks, media_file_url,
    rotate_photo, undo_photo_edit_for_path,
};
use commands::qr::{
    discard_qr_preview_file, scan_qr_photo, scan_qr_photo_followups, scan_qr_photos, scan_qr_video,
    scan_qr_videos,
};
use commands::sd_card::{
    backup_sd_card, clear_sd_files, decline_sd_backup, delete_processed_files, eject_sd_card,
    enrich_sd_files, get_media_thumbnail, get_sd_status, import_sd_files, init_sd_monitor,
    list_processed_files, list_sd_files, purge_processed_files, scan_sd_drives, start_sd_monitor,
    stop_sd_monitor,
};
use commands::smb::{test_server_connection, upload_to_server};
use commands::video::{
    cancel_encode, clear_video_cut_undo, concat_videos, create_job, create_video, cut_video,
    discard_video_cut_undo_for_path, encode_video, generate_preview, get_hw_info,
    get_video_filmstrip, has_video_cut_undo, import_videos, list_video_cut_marks,
    list_video_keyframes, probe_video, resolve_intro_mux_fallback, rotate_video, split_video,
    trim_video, undo_all_video_cuts, undo_last_video_cut, undo_video_cut_for_path,
    validate_create_job,
};
use commands::vorgang_history::{delete_vorgaenge, list_vorgang_dateien, list_vorgaenge};
use storage::logging::{init_logging, log_info, set_log_emitter};
use storage::cache::cleanup_on_app_exit;
use updater::{
    cancel_update_install, check_for_updates, get_updater_install_hint, get_updater_status,
    install_specific_version, install_update, list_available_versions,
};
use tauri::Emitter;

/// Allow WebKitGTK/GStreamer to play custom URI schemes (Linux media hang fix).
#[cfg(target_os = "linux")]
fn ensure_webkit_gst_protocols() {
    const NEEDED: &[&str] = &["asset", "media", "http", "https", "file"];
    let existing = std::env::var("WEBKIT_GST_ALLOWED_URI_PROTOCOLS").unwrap_or_default();
    let mut protocols: Vec<String> = existing
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    for p in NEEDED {
        if !protocols.iter().any(|x| x.eq_ignore_ascii_case(p)) {
            protocols.push((*p).to_string());
        }
    }
    // SAFETY: called once at process start before any threads/WebView exist.
    std::env::set_var("WEBKIT_GST_ALLOWED_URI_PROTOCOLS", protocols.join(","));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    ensure_webkit_gst_protocols();

    let config_state = ConfigState::new().unwrap_or_else(|e| {
        panic!("failed to initialize config store: {e}");
    });
    let media_server = media::http_server::start().unwrap_or_else(|e| {
        panic!("failed to start media HTTP server: {e}");
    });
    let media_base_url = media_server.base_url.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(config_state)
        .manage(media_server)
        .register_asynchronous_uri_scheme_protocol("media", |_ctx, request, responder| {
            // Kept for compatibility; HTML5 video uses the loopback HTTP server
            // (WebKitGTK cannot play custom schemes reliably).
            std::thread::spawn(move || {
                let response = media::stream_protocol::build_response(request);
                responder.respond(response);
            });
        })
        .setup(move |app| {
            match init_logging() {
                Ok(path) => {
                    log_info(&format!("Logging initialized at {}", path.display()));
                }
                Err(e) => {
                    eprintln!("failed to init app.log: {e}");
                }
            }
            set_log_emitter({
                let handle = app.handle().clone();
                move |entry| {
                    let _ = handle.emit("log-line", entry);
                }
            });

            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            init_sd_monitor(app.handle());
            log_info("SD monitor initialized");
            log_info(&format!("Media HTTP server at {media_base_url}"));

            // Win/Linux: frameless (`decorations: false` in conf) + custom titlebar in React.
            // macOS: keep native traffic lights with a transparent overlay titlebar.
            #[cfg(target_os = "macos")]
            {
                use tauri::{Manager, TitleBarStyle};
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) = window.set_decorations(true) {
                        eprintln!("macOS set_decorations failed: {e}");
                    }
                    if let Err(e) = window.set_title_bar_style(TitleBarStyle::Overlay) {
                        eprintln!("macOS set_title_bar_style failed: {e}");
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_hw_info,
            encode_video,
            concat_videos,
            trim_video,
            cut_video,
            split_video,
            rotate_video,
            undo_last_video_cut,
            undo_video_cut_for_path,
            undo_all_video_cuts,
            has_video_cut_undo,
            list_video_cut_marks,
            clear_video_cut_undo,
            discard_video_cut_undo_for_path,
            cancel_encode,
            probe_video,
            list_video_keyframes,
            get_video_filmstrip,
            import_videos,
            create_video,
            create_job,
            resolve_intro_mux_fallback,
            validate_create_job,
            generate_preview,
            get_config,
            save_config,
            reload_config,
            reset_config,
            get_config_paths,
            propose_default_media_dirs_cmd,
            ensure_default_media_dirs_cmd,
            validate_kunde_cmd,
            scan_qr_video,
            scan_qr_photo,
            scan_qr_videos,
            scan_qr_photos,
            scan_qr_photo_followups,
            discard_qr_preview_file,
            expand_media_paths,
            get_file_sizes,
            import_photos,
            rotate_photo,
            crop_photo,
            undo_photo_edit_for_path,
            has_photo_edit_undo,
            list_photo_edit_marks,
            clear_photo_edit_undo,
            discard_photo_edit_undo_for_path,
            get_working_dir,
            clear_working_session,
            delete_working_copy,
            get_media_server_base,
            media_file_url,
            start_sd_monitor,
            stop_sd_monitor,
            get_sd_status,
            scan_sd_drives,
            list_sd_files,
            enrich_sd_files,
            backup_sd_card,
            clear_sd_files,
            import_sd_files,
            decline_sd_backup,
            eject_sd_card,
            get_media_thumbnail,
            list_processed_files,
            delete_processed_files,
            purge_processed_files,
            list_vorgaenge,
            list_vorgang_dateien,
            delete_vorgaenge,
            test_server_connection,
            upload_to_server,
            get_updater_status,
            get_updater_install_hint,
            check_for_updates,
            install_update,
            cancel_update_install,
            list_available_versions,
            install_specific_version,
            get_app_info,
            get_recent_logs,
            clear_log_buffer,
            run_startup_checks,
            cleanup_cache,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                sd_card::autoplay::uninstall();
                let result = cleanup_on_app_exit();
                if result.deleted_dirs.is_empty() && result.deleted_files.is_empty() {
                    log_info("Exit cleanup: nothing to remove");
                } else {
                    log_info(&format!("Exit cleanup: {}", result.summary));
                }
            }
        });
}
