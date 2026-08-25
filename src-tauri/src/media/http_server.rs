//! Loopback HTTP server for HTML5 `<video>` playback.
//!
//! WebKitGTK cannot reliably play media via custom URI schemes (`asset://`,
//! `media://`): unsolicited `206` responses stall the pipeline, and GStreamer
//! often reports `MEDIA_ERR_SRC_NOT_SUPPORTED`. Serving the same files over
//! `http://127.0.0.1` with proper Range support works (see tauri#15472 / #3725).

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use http_range::HttpRange;

use super::stream_protocol::{mime_for_path, path_from_uri, MAX_CHUNK};

/// Shared handle for the loopback media server.
#[derive(Debug, Clone)]
pub struct MediaServerState {
    pub base_url: String,
}

impl MediaServerState {
    pub fn url_for_path(&self, path: &str) -> String {
        let encoded = percent_encoding::utf8_percent_encode(
            path,
            percent_encoding::NON_ALPHANUMERIC,
        );
        format!("{}/{encoded}", self.base_url.trim_end_matches('/'))
    }
}

/// Bind `127.0.0.1:0` and serve Range-capable GETs in background threads.
pub fn start() -> Result<MediaServerState, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("media HTTP server bind failed: {e}"))?;
    listener
        .set_nonblocking(false)
        .map_err(|e| format!("media HTTP server config failed: {e}"))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("media HTTP server addr failed: {e}"))?;
    let base_url = format!("http://127.0.0.1:{}", addr.port());

    thread::Builder::new()
        .name("ats-media-http".into())
        .spawn(move || accept_loop(listener))
        .map_err(|e| format!("media HTTP server spawn failed: {e}"))?;

    Ok(MediaServerState { base_url })
}

fn accept_loop(listener: TcpListener) {
    for conn in listener.incoming() {
        match conn {
            Ok(stream) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(120)));
                thread::spawn(move || {
                    if let Err(e) = handle_connection(stream) {
                        eprintln!("media HTTP: {e}");
                    }
                });
            }
            Err(e) => {
                eprintln!("media HTTP accept: {e}");
            }
        }
    }
}

fn handle_connection(mut stream: TcpStream) -> Result<(), String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut request_line = String::new();
    reader
        .read_line(&mut request_line)
        .map_err(|e| e.to_string())?;
    if request_line.is_empty() {
        return Ok(());
    }

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_ascii_uppercase();
    let target = parts.next().unwrap_or("").to_string();

    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).map_err(|e| e.to_string())?;
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }

    if method == "OPTIONS" {
        return write_response(
            &mut stream,
            204,
            &[
                ("Access-Control-Allow-Origin", "*"),
                ("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"),
                ("Access-Control-Allow-Headers", "Range, Content-Type"),
                ("Accept-Ranges", "bytes"),
                ("Content-Length", "0"),
            ],
            &[],
        );
    }

    if method != "GET" && method != "HEAD" {
        return write_response(
            &mut stream,
            405,
            &[
                ("Access-Control-Allow-Origin", "*"),
                ("Content-Type", "text/plain"),
                ("Content-Length", "18"),
            ],
            b"Method Not Allowed",
        );
    }

    let path = path_from_request_target(&target).ok_or_else(|| format!("bad path: {target}"))?;
    if !path.is_file() {
        return write_response(
            &mut stream,
            404,
            &[
                ("Access-Control-Allow-Origin", "*"),
                ("Content-Type", "text/plain"),
                ("Content-Length", "9"),
            ],
            b"Not Found",
        );
    }

    // Open file and serve with no-store so in-place trims are not cached by the browser.
    let mut file = File::open(&path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let mime = mime_for_path(&path);
    let mtime = file
        .metadata()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let etag = format!("\"{mtime}-{len}\"");
    let range_header = headers
        .iter()
        .find(|(k, _)| k == "range")
        .map(|(_, v)| v.as_str());

    if method == "HEAD" {
        return write_response(
            &mut stream,
            200,
            &[
                ("Access-Control-Allow-Origin", "*"),
                ("Accept-Ranges", "bytes"),
                ("Cache-Control", "no-store"),
                ("ETag", &etag),
                ("Content-Type", mime),
                ("Content-Length", &len.to_string()),
                (
                    "Access-Control-Expose-Headers",
                    "content-range, accept-ranges, content-length, etag",
                ),
            ],
            &[],
        );
    }

    if let Some(range_header) = range_header {
        let ranges = HttpRange::parse(range_header, len).map_err(|_| "invalid range".to_string())?;
        let first = ranges.first().ok_or_else(|| "empty range".to_string())?;
        let start = first.start;
        let mut end = start + first.length - 1;
        if start >= len || end < start {
            let body = b"Range Not Satisfiable";
            return write_response(
                &mut stream,
                416,
                &[
                    ("Access-Control-Allow-Origin", "*"),
                    ("Content-Range", &format!("bytes */{len}")),
                    ("Content-Type", "text/plain"),
                    ("Content-Length", &body.len().to_string()),
                ],
                body,
            );
        }
        end = start + (end - start).min(len - start).min(MAX_CHUNK - 1);
        let nbytes = end + 1 - start;
        let mut buf = vec![0_u8; nbytes as usize];
        file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
        file.read_exact(&mut buf).map_err(|e| e.to_string())?;
        let content_range = format!("bytes {start}-{end}/{len}");
        return write_response(
            &mut stream,
            206,
            &[
                ("Access-Control-Allow-Origin", "*"),
                ("Accept-Ranges", "bytes"),
                ("Cache-Control", "no-store"),
                ("ETag", &etag),
                ("Content-Type", mime),
                ("Content-Range", &content_range),
                ("Content-Length", &nbytes.to_string()),
                (
                    "Access-Control-Expose-Headers",
                    "content-range, accept-ranges, content-length, etag",
                ),
            ],
            &buf,
        );
    }

    // No Range: stream the full file (WebKit over real HTTP typically follows
    // with Range requests after seeing Accept-Ranges + Content-Length).
    write_headers_only(
        &mut stream,
        200,
        &[
            ("Access-Control-Allow-Origin", "*"),
            ("Accept-Ranges", "bytes"),
            ("Cache-Control", "no-store"),
            ("ETag", &etag),
            ("Content-Type", mime),
            ("Content-Length", &len.to_string()),
            (
                "Access-Control-Expose-Headers",
                "content-range, accept-ranges, content-length, etag",
            ),
        ],
    )?;
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    match std::io::copy(&mut file, &mut stream) {
        Ok(_) => Ok(()),
        // Client often aborts the full GET once it has headers / switches to Range
        // (or when the UI switches clips / cancels filmstrip prefetch).
        Err(e) if is_client_abort(&e) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// True when the peer closed the socket mid-transfer (clip switch, seek, cancel).
///
/// On Windows this often surfaces as os error 10053 (`WSAECONNABORTED`) with
/// `ErrorKind::ConnectionAborted` rather than `BrokenPipe` / `ConnectionReset`.
fn is_client_abort(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::ConnectionAborted
            | std::io::ErrorKind::WriteZero
    ) || err.raw_os_error() == Some(10053) // WSAECONNABORTED (Windows)
}

fn map_write_err(err: std::io::Error) -> Result<(), String> {
    if is_client_abort(&err) {
        Ok(())
    } else {
        Err(err.to_string())
    }
}

fn path_from_request_target(target: &str) -> Option<PathBuf> {
    let path_part = target.split('?').next().unwrap_or(target);
    path_from_uri(path_part)
}

fn write_headers_only(
    stream: &mut TcpStream,
    status: u16,
    headers: &[(&str, &str)],
) -> Result<(), String> {
    let reason = reason_phrase(status);
    let mut out = format!("HTTP/1.1 {status} {reason}\r\n");
    for (k, v) in headers {
        out.push_str(k);
        out.push_str(": ");
        out.push_str(v);
        out.push_str("\r\n");
    }
    out.push_str("Connection: close\r\n\r\n");
    match stream.write_all(out.as_bytes()) {
        Ok(()) => Ok(()),
        Err(e) => map_write_err(e),
    }
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Result<(), String> {
    write_headers_only(stream, status, headers)?;
    if !body.is_empty() {
        match stream.write_all(body) {
            Ok(()) => {}
            Err(e) => return map_write_err(e),
        }
    }
    Ok(())
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        206 => "Partial Content",
        404 => "Not Found",
        405 => "Method Not Allowed",
        416 => "Range Not Satisfiable",
        _ => "Error",
    }
}

/// Validate that `path` is an existing regular file.
pub fn ensure_media_file(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty media path".into());
    }
    let pb = PathBuf::from(trimmed);
    if !pb.is_file() {
        return Err(format!("media file not found: {trimmed}"));
    }
    Ok(pb)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::ErrorKind;
    use std::net::TcpStream;
    use std::time::Duration;

    #[test]
    fn client_abort_kinds_are_ignored() {
        assert!(is_client_abort(&std::io::Error::from(ErrorKind::BrokenPipe)));
        assert!(is_client_abort(&std::io::Error::from(
            ErrorKind::ConnectionReset
        )));
        assert!(is_client_abort(&std::io::Error::from(
            ErrorKind::ConnectionAborted
        )));
        assert!(is_client_abort(&std::io::Error::from(ErrorKind::WriteZero)));
        assert!(!is_client_abort(&std::io::Error::from(
            ErrorKind::TimedOut
        )));
        assert!(map_write_err(std::io::Error::from(ErrorKind::ConnectionAborted)).is_ok());
        assert!(map_write_err(std::io::Error::from(ErrorKind::TimedOut)).is_err());
    }

    #[test]
    fn url_for_path_percent_encodes() {
        let state = MediaServerState {
            base_url: "http://127.0.0.1:9".into(),
        };
        let url = state.url_for_path("/tmp/a b.mp4");
        assert!(url.starts_with("http://127.0.0.1:9/"));
        assert!(url.contains("%2Ftmp%2F"));
        assert!(url.contains("a%20b") || url.contains("a%2520b") || url.contains("%20"));
    }

    #[test]
    fn server_serves_range_and_full_get() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.mp4");
        {
            let mut f = File::create(&path).unwrap();
            f.write_all(&(0u8..200).collect::<Vec<_>>()).unwrap();
        }
        let state = start().expect("start server");
        // Give acceptor a moment on slow CI.
        thread::sleep(Duration::from_millis(50));

        let url_path = state.url_for_path(path.to_str().unwrap());
        let host_port = url_path
            .trim_start_matches("http://")
            .split('/')
            .next()
            .unwrap();
        let encoded = url_path.splitn(2, &format!("http://{host_port}")).nth(1).unwrap();

        // Range request
        let mut stream = TcpStream::connect(host_port).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let req = format!(
            "GET {encoded} HTTP/1.1\r\nHost: {host_port}\r\nRange: bytes=10-19\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(req.as_bytes()).unwrap();
        let mut resp = Vec::new();
        stream.read_to_end(&mut resp).unwrap();
        let text = String::from_utf8_lossy(&resp);
        assert!(text.contains("206 Partial Content"), "{text}");
        assert!(text.contains("Content-Range: bytes 10-19/200"), "{text}");
        assert!(resp.ends_with(&(10u8..20).collect::<Vec<_>>()));

        // Full GET
        let mut stream = TcpStream::connect(host_port).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let req = format!(
            "GET {encoded} HTTP/1.1\r\nHost: {host_port}\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(req.as_bytes()).unwrap();
        let mut resp = Vec::new();
        stream.read_to_end(&mut resp).unwrap();
        let text = String::from_utf8_lossy(&resp);
        assert!(text.contains("200 OK"), "{text}");
        assert!(text.contains("Accept-Ranges: bytes"), "{text}");
        assert!(resp.ends_with(&(0u8..200).collect::<Vec<_>>()));
    }
}
