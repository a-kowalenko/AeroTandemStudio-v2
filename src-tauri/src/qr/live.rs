//! Cheap live decode-frame preview for the QR progress UI.
//!
//! Writes a small JPEG into a per-worker ping-pong slot so the WebView never
//! reads a file while it is being overwritten. Rank-pipe frames stay in RAM
//! and are not published.

use std::cell::Cell;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use image::codecs::jpeg::JpegEncoder;
use image::GenericImageView;

const LIVE_DIR_NAME: &str = "aero_studio_qr_live";
const LIVE_MAX_EDGE: u32 = 320;
const LIVE_JPEG_QUALITY: u8 = 50;
const MAX_SLOTS: usize = 4;

type LiveSink = Arc<dyn Fn(String, String, u64) + Send + Sync>;

static SINK: Mutex<Option<LiveSink>> = Mutex::new(None);
static GEN: AtomicU64 = AtomicU64::new(1);
static NEXT_SLOT: AtomicUsize = AtomicUsize::new(0);

thread_local! {
    static SLOT: Cell<Option<usize>> = const { Cell::new(None) };
    static SIDE: Cell<u8> = const { Cell::new(0) };
}

pub fn set_sink(sink: Option<LiveSink>) {
    if let Ok(mut g) = SINK.lock() {
        *g = sink;
    }
}

pub fn teardown() {
    set_sink(None);
    discard_files();
}

/// Original photo path — no extra encode.
pub fn publish_photo(media_path: &str) {
    if media_path.trim().is_empty() {
        return;
    }
    emit(media_path, media_path, next_gen());
}

/// Video extract PNG (or any decode image) → tiny JPEG in a ping-pong slot.
pub fn publish_image(media_path: &str, image_path: &Path) {
    if media_path.trim().is_empty() {
        return;
    }
    let Ok(written) = write_slot_jpeg(image_path) else {
        return;
    };
    emit(
        media_path,
        &written.path.to_string_lossy(),
        written.gen,
    );
}

pub struct LiveJpeg {
    pub path: PathBuf,
    pub gen: u64,
}

pub fn write_slot_jpeg(image_path: &Path) -> Result<LiveJpeg, String> {
    if !image_path.is_file() {
        return Err("live source missing".into());
    }
    let img = image::open(image_path).map_err(|e| e.to_string())?;
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return Err("empty image".into());
    }
    let small = if w > LIVE_MAX_EDGE || h > LIVE_MAX_EDGE {
        img.thumbnail(LIVE_MAX_EDGE, LIVE_MAX_EDGE)
    } else {
        img
    };

    let rgb = small.to_rgb8();
    let dest = slot_dest_path();
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = dest.with_extension("jpg.part");
    {
        let mut file = File::create(&tmp).map_err(|e| e.to_string())?;
        let mut encoder = JpegEncoder::new_with_quality(&mut file, LIVE_JPEG_QUALITY);
        encoder.encode_image(&rgb).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    let _ = fs::remove_file(&dest);
    fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    Ok(LiveJpeg {
        path: dest,
        gen: next_gen(),
    })
}

pub fn discard_files() {
    let dir = live_dir();
    if dir.is_dir() {
        let _ = fs::remove_dir_all(&dir);
    }
}

fn emit(media_path: &str, live_path: &str, gen: u64) {
    let sink = SINK.lock().ok().and_then(|g| g.clone());
    if let Some(sink) = sink {
        sink(media_path.to_string(), live_path.to_string(), gen);
    }
}

fn next_gen() -> u64 {
    GEN.fetch_add(1, Ordering::Relaxed)
}

fn live_dir() -> PathBuf {
    std::env::temp_dir().join(LIVE_DIR_NAME)
}

fn worker_slot() -> usize {
    SLOT.with(|c| {
        if let Some(i) = c.get() {
            return i;
        }
        let i = NEXT_SLOT.fetch_add(1, Ordering::Relaxed) % MAX_SLOTS;
        c.set(Some(i));
        i
    })
}

fn slot_dest_path() -> PathBuf {
    let slot = worker_slot();
    let side = SIDE.with(|c| {
        let next = 1u8.saturating_sub(c.get());
        c.set(next);
        next
    });
    live_dir().join(format!("w{slot}_{side}.jpg"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};
    use std::sync::Mutex;

    fn write_test_png(path: &Path, w: u32, h: u32) {
        let img: ImageBuffer<Rgb<u8>, _> =
            ImageBuffer::from_fn(w, h, |x, y| Rgb([(x % 256) as u8, (y % 256) as u8, 80]));
        img.save(path).unwrap();
    }

    #[test]
    fn write_slot_jpeg_downscales_and_ping_pongs() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("frame.png");
        write_test_png(&src, 1280, 720);

        SLOT.with(|c| c.set(Some(0)));
        SIDE.with(|c| c.set(0));

        let a = write_slot_jpeg(&src).unwrap();
        assert!(a.path.is_file());
        assert!(a.gen > 0);
        let jpeg = image::open(&a.path).unwrap();
        assert!(jpeg.width() <= LIVE_MAX_EDGE);
        assert!(jpeg.height() <= LIVE_MAX_EDGE);

        let b = write_slot_jpeg(&src).unwrap();
        assert_ne!(a.path, b.path);
        assert!(b.gen > a.gen);
        discard_files();
    }

    #[test]
    fn publish_photo_hits_sink() {
        let got = Arc::new(Mutex::new(None));
        let got2 = Arc::clone(&got);
        set_sink(Some(Arc::new(move |p, live, gen| {
            *got2.lock().unwrap() = Some((p, live, gen));
        })));
        publish_photo("C:/media/shot.jpg");
        let (p, live, gen) = got.lock().unwrap().clone().unwrap();
        assert_eq!(p, "C:/media/shot.jpg");
        assert_eq!(live, "C:/media/shot.jpg");
        assert!(gen > 0);
        set_sink(None);
    }
}
