//! SMB / server upload (port of legacy `file_utils.py` network parts).

pub mod client;

pub use client::{
    test_connection, upload_path, ConnectionTestResult, UploadProgress, UploadResult,
};
