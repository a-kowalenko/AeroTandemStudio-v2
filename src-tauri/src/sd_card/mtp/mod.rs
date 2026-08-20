//! MTP / USB camera import (Phase 23).
//!
//! Volume-based SD detection stays in [`crate::sd_card::monitor`].
//! This module holds the strict vendor allowlist, USB enumeration, and
//! platform staging adapters (macOS Image Capture / Windows WPD).

#![allow(dead_code)] // Parts consumed as Phase 23.x lands.

pub mod allowlist;
pub mod catalog;
pub mod usb_enumerate;

#[cfg(target_os = "macos")]
pub mod macos_ica;

#[cfg(target_os = "windows")]
pub mod windows_wpd;
