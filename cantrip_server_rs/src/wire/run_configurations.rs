use super::{Parsed, ValidationError, Value, value::json};
pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if !matches!(
        tag,
        "run-repository-entry" | "run-codex-source" | "run-secret-summary" | "run-secret-summaries"
    ) {
        return Ok(false);
    }
    let value = result.value.clone().ok_or(ValidationError::Operation)?;
    let mut issue = |suffix: &[Value], message: &str| {
        let mut at = path.to_vec();
        at.extend_from_slice(suffix);
        result.issue(json!({"code":"custom"}), &at, message.into(), false);
    };
    match tag {
        "run-repository-entry" => {
            if value["status"] == "ready"
                && (value["document"].is_null() || value["revision"].is_null())
            {
                issue(&[], "Ready entries require a document and revision.");
            }
            if value["status"] != "ready"
                && value["diagnostics"].as_array().is_some_and(Vec::is_empty)
            {
                issue(
                    &[json!("diagnostics")],
                    "Non-ready entries require at least one diagnostic.",
                );
            }
            if !value["document"].is_null() && value["id"] != value["document"]["id"] {
                issue(&[json!("id")], "Entry identity must match its document.");
            }
        }
        "run-codex-source" => {
            if value["configured"] == false && !value["revision"].is_null() {
                issue(
                    &[json!("revision")],
                    "An absent Codex environment cannot have a revision.",
                );
            }
            if value["configured"] == false && value["hasSetup"] == true {
                issue(
                    &[json!("hasSetup")],
                    "An absent Codex environment cannot have a setup script.",
                );
            }
            if value["valid"] == true
                && value["diagnostics"]
                    .as_array()
                    .is_some_and(|rows| rows.iter().any(|row| row["severity"] == "error"))
            {
                issue(
                    &[json!("diagnostics")],
                    "A valid Codex environment cannot include error diagnostics.",
                );
            }
        }
        "run-secret-summary" => {
            if (value["available"] == true)
                != (!value["revision"].is_null() && !value["updatedAt"].is_null())
            {
                issue(
                    &[],
                    "Available Run configuration secrets require revision metadata.",
                );
            }
        }
        _ => {
            let mut seen = std::collections::HashSet::new();
            for (index, row) in value
                .as_array()
                .ok_or(ValidationError::Operation)?
                .iter()
                .enumerate()
            {
                if !seen.insert(row["reference"].as_js_string()) {
                    issue(
                        &[json!(index), json!("reference")],
                        "Secret summary references must be unique.",
                    );
                }
            }
        }
    }
    Ok(true)
}
