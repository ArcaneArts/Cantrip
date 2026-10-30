//! Attached workspace names and repository discovery/import metadata contracts.
use super::{Parsed, ValidationError, Value, value::json};
use std::collections::HashSet;

pub(crate) fn classification_valid(candidate: &Value, origin: &str) -> bool {
    let github = !candidate["github"].is_null();
    let origin = !candidate[origin].is_null();
    let diagnostic = !candidate["diagnosticCode"].is_null();
    let unsupported = matches!(
        candidate["diagnosticCode"].as_str(),
        Some("bare-repository" | "linked-worktree")
    );
    match candidate["classification"].as_str() {
        Some("github-accessible") => github && origin && !diagnostic,
        Some("github-unavailable") => !github && origin && diagnostic && !unsupported,
        Some("unclassified" | "local-git") => !github && !unsupported,
        Some("unsupported") => !github && unsupported,
        _ => false,
    }
}
pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if !matches!(
        tag,
        "discovery-truncation"
            | "discovery-candidate-summary"
            | "discovery-import-classification"
            | "discovery-worker-classification"
            | "discovery-import-unique"
            | "project-workspace-name"
            | "project-workspace-name-bytes"
            | "project-workspace-update"
    ) {
        return Ok(false);
    }
    let value = result
        .value
        .as_ref()
        .ok_or(ValidationError::Operation)?
        .clone();
    let mut issue = |suffix: &[&str], message: &str| {
        let mut at = path.to_vec();
        at.extend(suffix.iter().map(|s| json!(s)));
        result.issue(json!({"code":"custom"}), &at, message.into(), false);
    };
    match tag {
        "discovery-truncation" => {
            if value["truncated"] != Value::Bool(value["diagnosticCode"] == "scan-truncated") {
                issue(
                    &["diagnosticCode"],
                    "Repository discovery truncation metadata is invalid.",
                );
            }
        }
        "discovery-candidate-summary" => {
            if !classification_valid(&value, "originUrlHandle") {
                issue(
                    &["classification"],
                    "Repository candidate classification metadata is invalid.",
                );
            }
            let needs = matches!(value["importState"].as_str(), Some("blocked" | "failed"));
            if needs == value["importError"].is_null() {
                issue(
                    &["importError"],
                    "Repository candidate import error metadata is invalid.",
                );
            }
            if value["importState"] != "pending" && !super::coercion::truthy(value.get("projectId"))
            {
                issue(
                    &["projectId"],
                    "Repository candidate import project identity is missing.",
                );
            }
        }
        "discovery-import-classification" | "discovery-worker-classification" => {
            if !classification_valid(&value, "originUrl") {
                issue(
                    &["classification"],
                    if tag == "discovery-import-classification" {
                        "Repository import classification metadata is invalid."
                    } else {
                        "Repository candidate classification metadata is invalid."
                    },
                );
            }
        }
        "discovery-import-unique" => {
            let mut seen = HashSet::new();
            if value
                .as_array()
                .ok_or(ValidationError::Operation)?
                .iter()
                .any(|v| !seen.insert(v["candidateId"].clone().stringify()))
            {
                issue(&[], "Repository import candidates must be unique.");
            }
        }
        "project-workspace-name" => {
            if value["envelope"]["keyRevision"] != value["keyRevision"] {
                issue(
                    &["envelope", "keyRevision"],
                    "Workspace name and envelope key revisions must match.",
                );
            }
        }
        "project-workspace-name-bytes" => {
            if value["ciphertext"]
                .as_js_string()
                .is_some_and(|s| s.len() > 448)
            {
                issue(&[], "Encrypted workspace name is too large.");
            }
        }
        "project-workspace-update" => {
            if value.get("nameProtection").is_none() && value.get("isDefault").is_none() {
                issue(&[], "At least one workspace field is required.");
            }
        }
        _ => unreachable!(),
    }
    Ok(true)
}
