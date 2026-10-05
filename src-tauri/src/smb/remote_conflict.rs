//! Remote job-folder collision after staging promote.
//!
//! A name collision means the share answered. It is not an offline event.
//! Classification decides whether to heal the local upload or replace a dead remnant.

pub const REMOTE_JOB_EXISTS_CODE: &str = "REMOTE_JOB_EXISTS";
pub const MARKER_FERTIG: &str = "_fertig.txt";
pub const MARKER_PROCESSING: &str = "_in_verarbeitung.txt";

pub const ACTION_HEAL: &str = "heal";
pub const ACTION_HEAL_HANDOFF: &str = "heal_handoff";
pub const ACTION_REPLACE: &str = "replace";
pub const ACTION_UNCLEAR: &str = "unclear";
pub const ACTION_RETRY: &str = "retry";

pub const REASON_AMS_ACTIVE: &str = "ams_active";
pub const REASON_AMS_COMPLETED: &str = "ams_completed";
pub const REASON_FERTIG_WAITING: &str = "fertig_waiting";
pub const REASON_CONTENT_MATCH: &str = "content_match";
pub const REASON_INCOMPLETE: &str = "incomplete";
pub const REASON_PROBE_FAILED: &str = "probe_failed";
pub const REASON_ABSENT: &str = "absent";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteJobFacts {
    pub folder_present: bool,
    pub listed: bool,
    pub truncated: bool,
    pub has_fertig: bool,
    pub has_processing: bool,
    /// True when every local manifest path exists on the remote job.
    pub manifest_match: bool,
    /// Live AMS state. Empty when ATS only has the local placeholder (`pending` / source `local`).
    pub ams_state: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteJobDecision {
    pub action: &'static str,
    pub reason: &'static str,
}

pub fn remote_job_exists_message() -> String {
    format!("{REMOTE_JOB_EXISTS_CODE}: Zielordner existiert bereits")
}

pub fn is_remote_job_exists_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("remote_job_exists")
        || lower.contains("status_object_name_collision")
        || lower.contains("object_name_collision")
        || lower.contains("ziel existiert bereits")
        || lower.contains("zielordner existiert bereits")
        || lower.contains("already exists")
        || lower.contains("bereits vorhanden")
}

/// Ignore the local placeholder `pending` written at create time.
/// Only Bridge/Outbox states count as a real AMS claim.
pub fn ams_state_for_conflict(state: &str, source: &str) -> String {
    let source = source.trim().to_ascii_lowercase();
    if source != "bridge" && source != "outbox" {
        return String::new();
    }
    state.trim().to_ascii_lowercase()
}

pub fn manifest_paths_covered(required: &[String], remote_files: &[String]) -> bool {
    if required.is_empty() {
        return false;
    }
    let have: std::collections::HashSet<String> =
        remote_files.iter().map(|p| normalize_rel(p)).collect();
    required
        .iter()
        .map(|p| normalize_rel(p))
        .filter(|p| !p.is_empty())
        .all(|p| have.contains(&p))
}

pub fn classify_remote_job(facts: &RemoteJobFacts) -> RemoteJobDecision {
    if !facts.folder_present {
        return RemoteJobDecision {
            action: ACTION_RETRY,
            reason: REASON_ABSENT,
        };
    }
    if !facts.listed {
        return RemoteJobDecision {
            action: ACTION_UNCLEAR,
            reason: REASON_PROBE_FAILED,
        };
    }

    let ams = facts.ams_state.trim().to_ascii_lowercase();
    if facts.has_processing || is_ams_in_flight(&ams) {
        return RemoteJobDecision {
            action: ACTION_HEAL,
            reason: REASON_AMS_ACTIVE,
        };
    }
    if ams == "completed" {
        return RemoteJobDecision {
            action: ACTION_HEAL,
            reason: REASON_AMS_COMPLETED,
        };
    }
    if facts.has_fertig {
        return RemoteJobDecision {
            action: if ams.is_empty() {
                ACTION_HEAL_HANDOFF
            } else {
                ACTION_HEAL
            },
            reason: REASON_FERTIG_WAITING,
        };
    }
    if facts.manifest_match {
        return RemoteJobDecision {
            action: ACTION_HEAL,
            reason: REASON_CONTENT_MATCH,
        };
    }
    if facts.truncated {
        return RemoteJobDecision {
            action: ACTION_UNCLEAR,
            reason: REASON_PROBE_FAILED,
        };
    }
    if ams.is_empty() || is_ams_terminal_bad(&ams) {
        return RemoteJobDecision {
            action: ACTION_REPLACE,
            reason: REASON_INCOMPLETE,
        };
    }
    RemoteJobDecision {
        action: ACTION_UNCLEAR,
        reason: REASON_PROBE_FAILED,
    }
}

fn is_ams_in_flight(state: &str) -> bool {
    matches!(state, "pending" | "accepted" | "queued" | "uploading")
}

fn is_ams_terminal_bad(state: &str) -> bool {
    matches!(
        state,
        "failed" | "rejected" | "cancelled" | "canceled"
    )
}

pub fn normalize_rel(path: &str) -> String {
    path.replace('\\', "/")
        .trim_matches('/')
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> RemoteJobFacts {
        RemoteJobFacts {
            folder_present: true,
            listed: true,
            truncated: false,
            has_fertig: false,
            has_processing: false,
            manifest_match: false,
            ams_state: String::new(),
        }
    }

    #[test]
    fn collision_text_is_not_offline() {
        assert!(is_remote_job_exists_message(
            "Staging-Promote fehlgeschlagen: Protocol error: STATUS_OBJECT_NAME_COLLISION during SetInfo"
        ));
        assert!(is_remote_job_exists_message(&remote_job_exists_message()));
        assert!(is_remote_job_exists_message(
            "Ziel existiert bereits: \\\\server\\share\\Job"
        ));
        assert!(!is_remote_job_exists_message(
            "Server nicht erreichbar (Zeitüberschreitung)."
        ));
    }

    #[test]
    fn local_pending_is_not_ams_in_flight() {
        assert_eq!(ams_state_for_conflict("pending", "local"), "");
        assert_eq!(ams_state_for_conflict("pending", ""), "");
        assert_eq!(ams_state_for_conflict("uploading", "bridge"), "uploading");
        assert_eq!(ams_state_for_conflict("completed", "outbox"), "completed");
    }

    #[test]
    fn processing_marker_heals() {
        let mut f = facts();
        f.has_processing = true;
        let d = classify_remote_job(&f);
        assert_eq!(d.action, ACTION_HEAL);
        assert_eq!(d.reason, REASON_AMS_ACTIVE);
    }

    #[test]
    fn live_uploading_heals_even_without_marker() {
        let mut f = facts();
        f.ams_state = "uploading".into();
        assert_eq!(classify_remote_job(&f).action, ACTION_HEAL);
    }

    #[test]
    fn completed_heals() {
        let mut f = facts();
        f.ams_state = "completed".into();
        assert_eq!(classify_remote_job(&f).reason, REASON_AMS_COMPLETED);
    }

    #[test]
    fn fertig_without_ams_wakes_handoff() {
        let mut f = facts();
        f.has_fertig = true;
        let d = classify_remote_job(&f);
        assert_eq!(d.action, ACTION_HEAL_HANDOFF);
        assert_eq!(d.reason, REASON_FERTIG_WAITING);
    }

    #[test]
    fn fertig_with_failed_ams_does_not_replace() {
        let mut f = facts();
        f.has_fertig = true;
        f.ams_state = "failed".into();
        assert_eq!(classify_remote_job(&f).action, ACTION_HEAL);
    }

    #[test]
    fn content_match_without_marker_heals() {
        let mut f = facts();
        f.manifest_match = true;
        assert_eq!(classify_remote_job(&f).reason, REASON_CONTENT_MATCH);
    }

    #[test]
    fn incomplete_without_claim_replaces() {
        let d = classify_remote_job(&facts());
        assert_eq!(d.action, ACTION_REPLACE);
        assert_eq!(d.reason, REASON_INCOMPLETE);
    }

    #[test]
    fn failed_ams_and_incomplete_replaces() {
        let mut f = facts();
        f.ams_state = "cancelled".into();
        assert_eq!(classify_remote_job(&f).action, ACTION_REPLACE);
    }

    #[test]
    fn missing_folder_retries() {
        let mut f = facts();
        f.folder_present = false;
        assert_eq!(classify_remote_job(&f).action, ACTION_RETRY);
    }

    #[test]
    fn unlistable_folder_stays_unclear() {
        let mut f = facts();
        f.listed = false;
        assert_eq!(classify_remote_job(&f).action, ACTION_UNCLEAR);
    }

    #[test]
    fn truncated_incomplete_stays_unclear() {
        let mut f = facts();
        f.truncated = true;
        assert_eq!(classify_remote_job(&f).action, ACTION_UNCLEAR);
    }

    #[test]
    fn manifest_cover_is_case_insensitive() {
        assert!(manifest_paths_covered(
            &["Outside_Foto/A.JPG".into()],
            &["outside_foto\\a.jpg".into(), "_fertig.txt".into()],
        ));
        assert!(!manifest_paths_covered(
            &["Outside_Foto/A.JPG".into(), "Handcam_Video/b.mp4".into()],
            &["outside_foto/a.jpg".into()],
        ));
        assert!(!manifest_paths_covered(&[], &["a.jpg".into()]));
    }
}
