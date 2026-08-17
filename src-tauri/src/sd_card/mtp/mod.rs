//! MTP / USB camera import (Phase 23).
//!
//! Volume-based SD detection stays in [`crate::sd_card::monitor`].
//! This module holds the strict vendor allowlist, USB enumeration, and
//! Image Capture staging (macOS).

#![allow(dead_code)] // Parts consumed as Phase 23.1+ lands.

pub mod allowlist;
pub mod usb_enumerate;

#[cfg(target_os = "macos")]
pub mod macos_ica;
