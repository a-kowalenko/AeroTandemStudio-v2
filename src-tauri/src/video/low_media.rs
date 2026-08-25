//! Soft low-media thresholds before create (Phase 29).
//!
//! Product-scoped soft confirm only — never a hard error in `validate_create_job`.
//! Keep in sync with `src/lib/lowMediaConfirm.ts`.
//!
//! The create UI evaluates this in TypeScript; this module is the tested source of truth.

#![allow(dead_code)]

use crate::model::Kunde;
use crate::video::export_paths::{needs_foto_product, needs_video_product};

/// Warn when booked video product has this many videos or fewer.
pub const LOW_MEDIA_VIDEO_MAX: usize = 1;
/// Warn when booked photo product has fewer than this many photos.
pub const LOW_MEDIA_PHOTO_MIN: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LowMediaReason {
    Video,
    Photos,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LowMediaWarn {
    pub reasons: Vec<LowMediaReason>,
    pub video_count: usize,
    pub photo_count: usize,
}

impl LowMediaWarn {
    pub fn should_warn(&self) -> bool {
        !self.reasons.is_empty()
    }
}

/// Product-scoped soft check: only booked media kinds are evaluated.
pub fn should_warn_low_media(
    kunde: &Kunde,
    video_count: usize,
    photo_count: usize,
) -> LowMediaWarn {
    let mut reasons = Vec::new();

    if needs_video_product(kunde) && video_count <= LOW_MEDIA_VIDEO_MAX {
        reasons.push(LowMediaReason::Video);
    }
    if needs_foto_product(kunde) && photo_count < LOW_MEDIA_PHOTO_MIN {
        reasons.push(LowMediaReason::Photos);
    }

    LowMediaWarn {
        reasons,
        video_count,
        photo_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kunde_with(video: bool, foto: bool) -> Kunde {
        Kunde {
            handcam_video: video,
            handcam_foto: foto,
            ..Kunde::default()
        }
    }

    #[test]
    fn no_products_never_warns() {
        let w = should_warn_low_media(&kunde_with(false, false), 0, 0);
        assert!(!w.should_warn());
        assert!(w.reasons.is_empty());
    }

    #[test]
    fn video_product_warns_at_one_or_zero() {
        let k = kunde_with(true, false);
        let w0 = should_warn_low_media(&k, 0, 50);
        assert!(w0.should_warn());
        assert_eq!(w0.reasons, vec![LowMediaReason::Video]);

        let w1 = should_warn_low_media(&k, 1, 50);
        assert!(w1.should_warn());
        assert_eq!(w1.reasons, vec![LowMediaReason::Video]);
    }

    #[test]
    fn video_product_no_warn_at_two() {
        let w = should_warn_low_media(&kunde_with(true, false), 2, 0);
        assert!(!w.should_warn());
    }

    #[test]
    fn photo_product_warns_below_twenty() {
        let k = kunde_with(false, true);
        let w19 = should_warn_low_media(&k, 0, 19);
        assert!(w19.should_warn());
        assert_eq!(w19.reasons, vec![LowMediaReason::Photos]);

        let w1 = should_warn_low_media(&k, 5, 1);
        assert!(w1.should_warn());
        assert_eq!(w1.reasons, vec![LowMediaReason::Photos]);
    }

    #[test]
    fn photo_product_no_warn_at_twenty() {
        let w = should_warn_low_media(&kunde_with(false, true), 0, 20);
        assert!(!w.should_warn());
    }

    #[test]
    fn unbooked_kind_ignored() {
        // Video booked only — low photo count must not warn.
        let video_only = should_warn_low_media(&kunde_with(true, false), 2, 3);
        assert!(!video_only.should_warn());

        // Photo booked only — low video count must not warn.
        let photo_only = should_warn_low_media(&kunde_with(false, true), 1, 25);
        assert!(!photo_only.should_warn());
    }

    #[test]
    fn both_products_independent_reasons() {
        let k = kunde_with(true, true);
        let both = should_warn_low_media(&k, 1, 12);
        assert!(both.should_warn());
        assert_eq!(
            both.reasons,
            vec![LowMediaReason::Video, LowMediaReason::Photos]
        );
        assert_eq!(both.video_count, 1);
        assert_eq!(both.photo_count, 12);

        let video_only = should_warn_low_media(&k, 1, 50);
        assert_eq!(video_only.reasons, vec![LowMediaReason::Video]);

        let photo_only = should_warn_low_media(&k, 3, 19);
        assert_eq!(photo_only.reasons, vec![LowMediaReason::Photos]);

        let none = should_warn_low_media(&k, 2, 20);
        assert!(!none.should_warn());
    }

    #[test]
    fn outside_products_count_as_booked() {
        let mut k = Kunde::default();
        k.outside_video = true;
        k.outside_foto = true;
        let w = should_warn_low_media(&k, 1, 5);
        assert_eq!(
            w.reasons,
            vec![LowMediaReason::Video, LowMediaReason::Photos]
        );
    }
}
