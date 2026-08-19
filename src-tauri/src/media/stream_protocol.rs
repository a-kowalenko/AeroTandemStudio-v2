//! Custom `media://` URI scheme for HTML5 `<video>` with HTTP Range support.
//!
//! Why: Tauri's built-in `asset://` handler reads the **entire** file when the
//! client omits a `Range` header. WebKitGTK on Linux often does that on first
//! load, so importing a multi‑GB DJI clip freezes / OOM the app. This protocol
//! never serves more than [`MAX_CHUNK`] bytes per response.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use http::header::{
    ACCEPT_RANGES, ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS, CONTENT_LENGTH,
    CONTENT_RANGE, CONTENT_TYPE,
};
use http::{Method, Request, Response, StatusCode};
use http_range::HttpRange;

/// Max bytes returned in a single response (keeps large clips playable).
pub const MAX_CHUNK: u64 = 2 * 1024 * 1024;

/// Files at or below this size may be returned in one 200 response without Range.
const SMALL_FILE_FULL: u64 = MAX_CHUNK;

pub fn build_response(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    match try_build_response(request) {
        Ok(resp) => resp,
        Err(status) => error_response(status),
    }
}

fn try_build_response(request: Request<Vec<u8>>) -> Result<Response<Vec<u8>>, StatusCode> {
    if request.method() == Method::OPTIONS {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(ACCEPT_RANGES, "bytes")
            .body(Vec::new())
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
    }

    let path = path_from_uri(request.uri().path()).ok_or(StatusCode::BAD_REQUEST)?;
    if !path.is_file() {
        return Err(StatusCode::NOT_FOUND);
    }

    let mut file = File::open(&path).map_err(|_| StatusCode::NOT_FOUND)?;
    let len = file.metadata().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?.len();
    let mime = mime_for_path(&path);

    if request.method() == Method::HEAD {
        return Response::builder()
            .status(StatusCode::OK)
            .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(ACCEPT_RANGES, "bytes")
            .header(CONTENT_TYPE, mime)
            .header(CONTENT_LENGTH, len)
            .body(Vec::new())
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR);
    }

    if request.method() != Method::GET {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }

    let range_header = request
        .headers()
        .get(http::header::RANGE)
        .and_then(|v| v.to_str().ok());

    let (start, end) = if let Some(range_header) = range_header {
        let ranges = HttpRange::parse(range_header, len).map_err(|_| StatusCode::RANGE_NOT_SATISFIABLE)?;
        let first = ranges.first().ok_or(StatusCode::RANGE_NOT_SATISFIABLE)?;
        let start = first.start;
        let mut end = start + first.length - 1;
        if start >= len || end < start {
            return Err(StatusCode::RANGE_NOT_SATISFIABLE);
        }
        end = start + (end - start).min(len - start).min(MAX_CHUNK - 1);
        (start, end)
    } else if len <= SMALL_FILE_FULL {
        // Tiny files: full body is fine.
        return read_full(&mut file, len, mime);
    } else {
        // WebKitGTK often omits Range on the first GET. Serving the whole multi‑GB
        // file would hang the UI — return the first chunk as 206 instead.
        (0, (len - 1).min(MAX_CHUNK - 1))
    };

    read_range(&mut file, len, start, end, mime, true)
}

fn read_full(file: &mut File, len: u64, mime: &str) -> Result<Response<Vec<u8>>, StatusCode> {
    let mut buf = Vec::with_capacity(len as usize);
    file.read_to_end(&mut buf)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Response::builder()
        .status(StatusCode::OK)
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(ACCEPT_RANGES, "bytes")
        .header(CONTENT_TYPE, mime)
        .header(CONTENT_LENGTH, len)
        .body(buf)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn read_range(
    file: &mut File,
    len: u64,
    start: u64,
    end: u64,
    mime: &str,
    partial: bool,
) -> Result<Response<Vec<u8>>, StatusCode> {
    let nbytes = end + 1 - start;
    let mut buf = Vec::with_capacity(nbytes as usize);
    file.seek(SeekFrom::Start(start))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    file.take(nbytes)
        .read_to_end(&mut buf)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let status = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };

    Response::builder()
        .status(status)
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(ACCEPT_RANGES, "bytes")
        .header(ACCESS_CONTROL_EXPOSE_HEADERS, "content-range, accept-ranges")
        .header(CONTENT_TYPE, mime)
        .header(CONTENT_RANGE, format!("bytes {start}-{end}/{len}"))
        .header(CONTENT_LENGTH, nbytes)
        .body(buf)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn error_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(CONTENT_TYPE, "text/plain")
        .body(
            status
                .canonical_reason()
                .unwrap_or("error")
                .as_bytes()
                .to_vec(),
        )
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/// Decode `%2Ftmp%2F…` / `C%3A%5C…` path from `media://localhost/<encoded>`.
pub fn path_from_uri(uri_path: &str) -> Option<PathBuf> {
    let stripped = uri_path.strip_prefix('/').unwrap_or(uri_path);
    if stripped.is_empty() {
        return None;
    }
    let decoded = percent_encoding::percent_decode_str(stripped)
        .decode_utf8()
        .ok()?;
    let path = PathBuf::from(decoded.as_ref());
    if path.as_os_str().is_empty() {
        return None;
    }
    Some(path)
}

pub fn mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        Some("avi") => "video/x-msvideo",
        Some("ts") | Some("m2ts") => "video/mp2t",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn path_from_uri_decodes_unix_and_windows() {
        let unix = path_from_uri("/%2Ftmp%2Faero%2Fclip.mp4").unwrap();
        assert_eq!(unix, PathBuf::from("/tmp/aero/clip.mp4"));

        let win = path_from_uri("/C%3A%5CUsers%5Cme%5Cclip.mp4").unwrap();
        assert_eq!(win, PathBuf::from(r"C:\Users\me\clip.mp4"));
    }

    #[test]
    fn large_file_without_range_returns_partial_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.bin");
        {
            let mut f = File::create(&path).unwrap();
            let chunk = vec![0xABu8; 64 * 1024];
            for _ in 0..(MAX_CHUNK as usize / chunk.len() + 2) {
                f.write_all(&chunk).unwrap();
            }
        }
        let encoded = percent_encoding::utf8_percent_encode(
            path.to_str().unwrap(),
            percent_encoding::NON_ALPHANUMERIC,
        )
        .to_string();
        let request = Request::builder()
            .method("GET")
            .uri(format!("/{encoded}"))
            .body(Vec::new())
            .unwrap();

        let resp = build_response(request);
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);
        assert!(resp.body().len() as u64 <= MAX_CHUNK);
        assert!(resp.headers().get(CONTENT_RANGE).is_some());
    }

    #[test]
    fn small_file_without_range_returns_200_full() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("small.mp4");
        std::fs::write(&path, b"fake-mp4-bytes").unwrap();
        let encoded = percent_encoding::utf8_percent_encode(
            path.to_str().unwrap(),
            percent_encoding::NON_ALPHANUMERIC,
        )
        .to_string();
        let request = Request::builder()
            .method("GET")
            .uri(format!("/{encoded}"))
            .body(Vec::new())
            .unwrap();
        let resp = build_response(request);
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.body(), b"fake-mp4-bytes");
    }
}
