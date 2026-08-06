//! Content-area and background dimensions (port of legacy `constants.py`).

/// Original dimensions of `hintergrund.png`.
pub const HINTERGRUND_ORIGINAL_WIDTH: u32 = 3056;
pub const HINTERGRUND_ORIGINAL_HEIGHT: u32 = 2037;

/// Content region corners in original background pixels:
/// (94, 94) → (1626, 1974).
pub const CONTENT_AREA_X1: f64 = 94.0;
pub const CONTENT_AREA_Y1: f64 = 94.0;
pub const CONTENT_AREA_X2: f64 = 1626.0;
pub const CONTENT_AREA_Y2: f64 = 1974.0;

/// Padding inside the content area (percent per side).
pub const CONTENT_AREA_PADDING_LEFT: f64 = 5.0;
pub const CONTENT_AREA_PADDING_RIGHT: f64 = 2.0;
pub const CONTENT_AREA_PADDING_TOP: f64 = 5.0;
pub const CONTENT_AREA_PADDING_BOTTOM: f64 = 5.0;

/// Default intro duration in seconds (matches legacy config default).
pub const DEFAULT_INTRO_DAUER_SECS: f64 = 5.0;

/// Bundled asset filenames under `resources/assets/`.
pub const ASSET_HINTERGRUND: &str = "hintergrund.png";
#[allow(dead_code)]
pub const ASSET_LOGO: &str = "logo.png";
pub const ASSET_PREVIEW_STEMPEL: &str = "preview_stempel.png";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hintergrund_aspect_is_landscape() {
        assert!(HINTERGRUND_ORIGINAL_WIDTH > HINTERGRUND_ORIGINAL_HEIGHT);
    }

    #[test]
    fn content_area_is_inside_background() {
        assert!(CONTENT_AREA_X1 < CONTENT_AREA_X2);
        assert!(CONTENT_AREA_Y1 < CONTENT_AREA_Y2);
        assert!(CONTENT_AREA_X2 <= f64::from(HINTERGRUND_ORIGINAL_WIDTH));
        assert!(CONTENT_AREA_Y2 <= f64::from(HINTERGRUND_ORIGINAL_HEIGHT));
    }
}
