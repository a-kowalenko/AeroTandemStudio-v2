//! SMB / server upload (port of legacy `file_utils.py` network parts).

pub mod auto_mount;
pub mod client;
pub mod handoff_upload;
pub mod parallel_upload;
pub mod reconnect;
pub mod staging_gc;
pub mod unix_mapping;
pub mod windows_mapping;

pub use client::{
    cleanup_remote_upload_folder, spawn_smb_staging_gc, test_connection, upload_path,
    ConnectionTestResult, UploadProgress, UploadResult,
};
pub use handoff_upload::{
    abort_handoff_upload, notify_handoff_after_upload, upload_failure_is_cancelled,
    HandoffUploadContext,
};
