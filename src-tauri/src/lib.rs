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
    get_config, get_config_paths, reload_config, reset_config, save_config, validate_kunde_cmd,
    ConfigState,
};
use commands::media::{
    clear_working_session, delete_working_copy, expand_media_paths, get_file_sizes, get_working_dir,
    import_photos,
};
use commands::qr::{scan_qr_photo, scan_qr_photos, scan_qr_video, scan_qr_videos};
use commands::sd_card::{
    backup_sd_card, decline_sd_backup, delete_processed_files, get_media_thumbnail, get_sd_status,
    import_sd_files, init_sd_monitor, list_processed_files, list_sd_files, purge_processed_files,
    scan_sd_drives, start_sd_monitor, stop_sd_monitor,
};
use commands::smb::{test_server_connection, upload_to_server};
use commands::video::{
    cancel_encode, concat_videos, create_job, create_video, cut_video, encode_video,
    generate_preview, get_hw_info, import_videos, probe_video, split_video, trim_video,
    validate_create_job,
};
use storage::logging::{init_logging, log_info, set_log_emitter};
use storage::cache::cleanup_on_app_exit;
use updater::{check_for_updates, get_updater_status, install_update};
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config_state = ConfigState::new().unwrap_or_else(|e| {
        panic!("failed to initialize config store: {e}");
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(config_state)
        .setup(|app| {
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_hw_info,
            encode_video,
            concat_videos,
            trim_video,
            cut_video,
            split_video,
            cancel_encode,
            probe_video,
            import_videos,
            create_video,
            create_job,
            validate_create_job,
            generate_preview,
            get_config,
            save_config,
            reload_config,
            reset_config,
            get_config_paths,
            validate_kunde_cmd,
            scan_qr_video,
            scan_qr_photo,
            scan_qr_videos,
            scan_qr_photos,
            expand_media_paths,
            get_file_sizes,
            import_photos,
            get_working_dir,
            clear_working_session,
            delete_working_copy,
            start_sd_monitor,
            stop_sd_monitor,
            get_sd_status,
            scan_sd_drives,
            list_sd_files,
            backup_sd_card,
            import_sd_files,
            decline_sd_backup,
            get_media_thumbnail,
            list_processed_files,
            delete_processed_files,
            purge_processed_files,
            test_server_connection,
            upload_to_server,
            get_updater_status,
            check_for_updates,
            install_update,
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
                let result = cleanup_on_app_exit();
                if result.deleted_dirs.is_empty() && result.deleted_files.is_empty() {
                    log_info("Exit cleanup: nothing to remove");
                } else {
                    log_info(&format!("Exit cleanup: {}", result.summary));
                }
            }
        });
}
