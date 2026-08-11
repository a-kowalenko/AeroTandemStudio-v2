//! Photo-series helpers for post-QR cleanup (same burst / capture series).

use std::collections::HashSet;
use std::path::Path;

use chrono::NaiveDateTime;
use regex::Regex;

/// Max gap between consecutive chrono-sorted photos to stay in the same series.
pub const QR_PHOTO_SERIES_GAP_SECS: f64 = 10.0;
/// Stop expanding a direction after this many consecutive non-QR neighbors.
pub const QR_PHOTO_MISS_STREAK_STOP: usize = 3;
/// Global cap on follow-up scans (both directions combined, excluding the hit).
pub const QR_PHOTO_FOLLOWUP_SCAN_CAP: usize = 40;

/// Parse capture instant (unix seconds + fractional ms) from a chrono import filename.
///
/// Expects `Foto_yyyyMMddHHmmssSSS…` (17 digits after `Foto_`).
pub fn capture_epoch_secs_from_photo_filename(filename: &str) -> Option<f64> {
    let name = Path::new(filename)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(filename);
    let re = Regex::new(r"(?i)^Foto_(\d{17})").ok()?;
    let caps = re.captures(name)?;
    let digits = caps.get(1)?.as_str();
    let wall = &digits[..14];
    let ms: u32 = digits[14..17].parse().ok()?;
    let dt = NaiveDateTime::parse_from_str(wall, "%Y%m%d%H%M%S").ok()?;
    Some(dt.and_utc().timestamp() as f64 + f64::from(ms) / 1000.0)
}

pub fn path_key(path: &str) -> String {
    path.replace('\\', "/").to_ascii_lowercase()
}

/// Whether consecutive chrono-sorted photos belong to the same capture series.
pub fn same_series_step(earlier: &str, later: &str, gap_secs: f64) -> bool {
    let name_a = Path::new(earlier)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(earlier);
    let name_b = Path::new(later)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(later);
    match (
        capture_epoch_secs_from_photo_filename(name_a),
        capture_epoch_secs_from_photo_filename(name_b),
    ) {
        (Some(a), Some(b)) => (b - a).abs() <= gap_secs,
        // Missing chrono → keep walking (index adjacency only).
        _ => true,
    }
}

fn find_hit_index(ordered_paths: &[String], hit_path: &str) -> Option<usize> {
    let hit_key = path_key(hit_path);
    ordered_paths.iter().position(|p| path_key(p) == hit_key)
}

/// Index of `hit_path` in the chrono-sorted list (for parallel follow-up walkers).
pub fn hit_index_in_list(ordered_paths: &[String], hit_path: &str) -> Option<usize> {
    find_hit_index(ordered_paths, hit_path)
}

/// Expand from a QR hit in one direction; `scan` returns true when the path has a customer QR.
///
/// - Series gap > `gap_secs` stops the direction (hard wall).
/// - `miss_streak_stop` consecutive non-QR results stop the direction.
/// - Paths already in `visited` are skipped (claimed elsewhere); new paths are claimed before `scan`.
/// - `scans_used` counts actual `scan` invocations toward `scan_cap`.
///
/// Returns paths that should be removed (QR hits only, not the original hit).
pub fn expand_direction_qr_hits<F>(
    ordered_paths: &[String],
    hit_idx: usize,
    // `-1` = toward lower indices, `+1` = toward higher indices.
    step: i32,
    gap_secs: f64,
    miss_streak_stop: usize,
    scan_cap: usize,
    visited: &mut HashSet<String>,
    scans_used: &mut usize,
    mut scan: F,
) -> Vec<String>
where
    F: FnMut(&str) -> bool,
{
    let mut out = Vec::new();
    if step == 0 || miss_streak_stop == 0 || ordered_paths.is_empty() {
        return out;
    }
    if hit_idx >= ordered_paths.len() {
        return out;
    }

    let mut miss_streak = 0usize;
    let mut i = hit_idx as i32 + step;

    while i >= 0 && (i as usize) < ordered_paths.len() {
        if *scans_used >= scan_cap {
            break;
        }
        let idx = i as usize;
        let prev_idx = (i - step) as usize;

        // Series wall between the previous kept index and this candidate.
        let (earlier, later) = if step > 0 {
            (&ordered_paths[prev_idx], &ordered_paths[idx])
        } else {
            (&ordered_paths[idx], &ordered_paths[prev_idx])
        };
        if !same_series_step(earlier, later, gap_secs) {
            break;
        }

        let path = &ordered_paths[idx];
        let key = path_key(path);
        if !visited.insert(key) {
            i += step;
            continue;
        }

        *scans_used += 1;
        if scan(path) {
            out.push(path.clone());
            miss_streak = 0;
        } else {
            miss_streak += 1;
            if miss_streak >= miss_streak_stop {
                break;
            }
        }
        i += step;
    }
    out
}

/// Bidirectional expansion from `hit_path` using `scan` (true = customer QR).
/// Returns additional QR-carrier paths to remove (excludes the hit itself).
pub fn expand_bidirectional_qr_hits<F>(
    ordered_paths: &[String],
    hit_path: &str,
    gap_secs: f64,
    miss_streak_stop: usize,
    scan_cap: usize,
    mut scan: F,
) -> Vec<String>
where
    F: FnMut(&str) -> bool,
{
    let Some(hit_idx) = find_hit_index(ordered_paths, hit_path) else {
        return Vec::new();
    };

    let mut visited = HashSet::new();
    visited.insert(path_key(hit_path));

    let mut scans_used = 0usize;
    let mut left = expand_direction_qr_hits(
        ordered_paths,
        hit_idx,
        -1,
        gap_secs,
        miss_streak_stop,
        scan_cap,
        &mut visited,
        &mut scans_used,
        &mut scan,
    );
    let right = expand_direction_qr_hits(
        ordered_paths,
        hit_idx,
        1,
        gap_secs,
        miss_streak_stop,
        scan_cap,
        &mut visited,
        &mut scans_used,
        &mut scan,
    );
    left.extend(right);
    left
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn chrono_at_ms(total_ms: u32, seq: u32) -> String {
        let s = total_ms / 1000;
        let ms = total_ms % 1000;
        format!("C:/w/Foto_202401011200{s:02}{ms:03}_{seq:04}.JPG")
    }

    #[test]
    fn parses_chrono_filename() {
        let t = capture_epoch_secs_from_photo_filename("Foto_20240101120000000_0001.JPG").unwrap();
        let t2 = capture_epoch_secs_from_photo_filename("Foto_20240101120001000_0002.JPG").unwrap();
        assert!((t2 - t - 1.0).abs() < 1e-6);
    }

    #[test]
    fn bidirectional_removes_qr_chain_and_stops_after_miss_streak() {
        // indices: 0 real, 1-3 QR, 4 hit QR, 5-6 QR, 7-10 real
        let paths: Vec<String> = (0..11u32).map(|i| chrono_at_ms(i * 100, i + 1)).collect();
        let qr: HashSet<String> = [1usize, 2, 3, 4, 5, 6]
            .into_iter()
            .map(|i| path_key(&paths[i]))
            .collect();
        let scanned = RefCell::new(Vec::<String>::new());

        let hits = expand_bidirectional_qr_hits(
            &paths,
            &paths[4],
            QR_PHOTO_SERIES_GAP_SECS,
            QR_PHOTO_MISS_STREAK_STOP,
            QR_PHOTO_FOLLOWUP_SCAN_CAP,
            |p| {
                scanned.borrow_mut().push(p.to_string());
                qr.contains(&path_key(p))
            },
        );

        let hit_keys: HashSet<_> = hits.iter().map(|p| path_key(p)).collect();
        assert!(hit_keys.contains(&path_key(&paths[1])));
        assert!(hit_keys.contains(&path_key(&paths[2])));
        assert!(hit_keys.contains(&path_key(&paths[3])));
        assert!(hit_keys.contains(&path_key(&paths[5])));
        assert!(hit_keys.contains(&path_key(&paths[6])));
        assert!(!hit_keys.contains(&path_key(&paths[4]))); // hit itself excluded
        assert!(!hit_keys.contains(&path_key(&paths[0])));
        assert!(!hit_keys.contains(&path_key(&paths[7])));

        // No double scans
        let mut keys: Vec<_> = scanned.borrow().iter().map(|p| path_key(p)).collect();
        let before = keys.len();
        keys.sort();
        keys.dedup();
        assert_eq!(keys.len(), before);
    }

    #[test]
    fn series_gap_stops_direction() {
        let paths = vec![
            chrono_at_ms(0, 1),
            chrono_at_ms(100, 2),  // QR
            chrono_at_ms(200, 3),  // hit
            chrono_at_ms(20_000, 4), // +19.8s — other series
            chrono_at_ms(20_100, 5),
        ];
        let qr: HashSet<String> = [1usize, 2, 3, 4]
            .into_iter()
            .map(|i| path_key(&paths[i]))
            .collect();

        let hits = expand_bidirectional_qr_hits(
            &paths,
            &paths[2],
            QR_PHOTO_SERIES_GAP_SECS,
            QR_PHOTO_MISS_STREAK_STOP,
            QR_PHOTO_FOLLOWUP_SCAN_CAP,
            |p| qr.contains(&path_key(p)),
        );
        let keys: HashSet<_> = hits.iter().map(|p| path_key(p)).collect();
        assert!(keys.contains(&path_key(&paths[1])));
        assert!(!keys.contains(&path_key(&paths[3])));
        assert!(!keys.contains(&path_key(&paths[4])));
    }

    #[test]
    fn miss_between_qrs_resets_streak() {
        let paths = vec![
            chrono_at_ms(0, 1),   // QR
            chrono_at_ms(100, 2), // miss
            chrono_at_ms(200, 3), // QR
            chrono_at_ms(300, 4), // hit
            chrono_at_ms(400, 5), // miss
            chrono_at_ms(500, 6), // miss
            chrono_at_ms(600, 7), // miss → stop right
        ];
        let qr: HashSet<String> = [0usize, 2, 3]
            .into_iter()
            .map(|i| path_key(&paths[i]))
            .collect();

        let hits = expand_bidirectional_qr_hits(
            &paths,
            &paths[3],
            QR_PHOTO_SERIES_GAP_SECS,
            QR_PHOTO_MISS_STREAK_STOP,
            QR_PHOTO_FOLLOWUP_SCAN_CAP,
            |p| qr.contains(&path_key(p)),
        );
        let keys: HashSet<_> = hits.iter().map(|p| path_key(p)).collect();
        assert!(keys.contains(&path_key(&paths[0])));
        assert!(keys.contains(&path_key(&paths[2])));
        assert!(!keys.contains(&path_key(&paths[1])));
    }

    #[test]
    fn scan_cap_limits_total_scans() {
        let paths: Vec<String> = (0..30u32).map(|i| chrono_at_ms(i * 50, i + 1)).collect();
        let scanned = RefCell::new(0usize);
        let hits = expand_bidirectional_qr_hits(
            &paths,
            &paths[15],
            QR_PHOTO_SERIES_GAP_SECS,
            QR_PHOTO_MISS_STREAK_STOP,
            8,
            |_p| {
                *scanned.borrow_mut() += 1;
                true
            },
        );
        assert_eq!(*scanned.borrow(), 8);
        assert_eq!(hits.len(), 8);
    }

    #[test]
    fn hit_at_list_edge_only_one_side() {
        let paths = vec![chrono_at_ms(0, 1), chrono_at_ms(100, 2), chrono_at_ms(200, 3)];
        let qr: HashSet<String> = paths.iter().map(|p| path_key(p)).collect();
        let hits = expand_bidirectional_qr_hits(
            &paths,
            &paths[0],
            QR_PHOTO_SERIES_GAP_SECS,
            QR_PHOTO_MISS_STREAK_STOP,
            QR_PHOTO_FOLLOWUP_SCAN_CAP,
            |p| qr.contains(&path_key(p)),
        );
        assert_eq!(hits.len(), 2);
        assert_eq!(path_key(&hits[0]), path_key(&paths[1]));
        assert_eq!(path_key(&hits[1]), path_key(&paths[2]));
    }

    #[test]
    fn gap_of_ten_seconds_still_same_series() {
        assert!(same_series_step(
            "Foto_20240101120000000_0001.JPG",
            "Foto_20240101120010000_0002.JPG",
            QR_PHOTO_SERIES_GAP_SECS
        ));
    }

    #[test]
    fn gap_over_ten_seconds_breaks_series() {
        assert!(!same_series_step(
            "Foto_20240101120000000_0001.JPG",
            "Foto_20240101120010001_0002.JPG",
            QR_PHOTO_SERIES_GAP_SECS
        ));
    }
}
