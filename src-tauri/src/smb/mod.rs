//! SMB / server upload (port of legacy `file_utils.py` network parts).

pub mod client;
pub mod handoff_upload;
pub mod parallel_upload;

pub use client::{
    cleanup_remote_upload_folder, test_connection, upload_path, ConnectionTestResult,
    UploadProgress, UploadResult,
};
pub use handoff_upload::{
    abort_handoff_upload, notify_handoff_after_upload, upload_failure_is_cancelled,
    HandoffUploadContext,
};
