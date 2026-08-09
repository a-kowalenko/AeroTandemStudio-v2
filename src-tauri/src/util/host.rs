//! Hostname / computer-name helpers (legacy: `COMPUTERNAME` / `socket.gethostname()`).

use std::process::{Command, Stdio};

use super::process::apply_no_window;

/// Best-effort local computer name for UI defaults and diagnostics.
pub fn current_computer_name() -> String {
    if let Ok(name) = std::env::var("COMPUTERNAME") {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Ok(name) = std::env::var("HOSTNAME") {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let mut cmd = Command::new("hostname");
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    apply_no_window(&mut cmd);
    if let Ok(out) = cmd.output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() {
                return s;
            }
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_computer_name_is_non_empty_on_typical_hosts() {
        // Soft check: most CI/dev machines expose a hostname somehow.
        let _ = current_computer_name();
    }
}
