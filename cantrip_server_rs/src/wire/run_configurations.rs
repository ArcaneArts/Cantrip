use super::{Parsed, ValidationError, Value, value::json};
pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
) -> Result<bool, ValidationError> {
    if !matches!(
        tag,
        "run-repository-entry"
            | "run-codex-source"
            | "run-secret-summary"
            | "run-secret-summaries"
            | "run-provider-validation"
            | "run-detection-candidate"
            | "run-definition-list"
            | "run-provider-capabilities"
            | "run-ready-entry"
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
        "run-provider-validation" => {
            let errors = value["diagnostics"]
                .as_array()
                .ok_or(ValidationError::Operation)?
                .iter()
                .any(|row| row["severity"] == "error");
            if value["valid"].as_bool() == Some(errors) {
                issue(
                    &[json!("valid")],
                    "Provider validation is valid exactly when it has no error diagnostics.",
                );
            }
        }
        "run-detection-candidate" => {
            if value["provider"] != value["document"]["provider"] {
                issue(
                    &[json!("provider")],
                    "The detected provider must match its document.",
                );
            }
        }
        "run-ready-entry" => {
            if value["status"] != "ready" {
                issue(&[], "Successful writes require a ready repository entry.");
            }
        }
        "run-provider-capabilities" => {
            let mut seen = std::collections::HashSet::new();
            for (index, row) in value
                .as_array()
                .ok_or(ValidationError::Operation)?
                .iter()
                .enumerate()
            {
                if !seen.insert(row["provider"].as_js_string()) {
                    issue(
                        &[json!(index), json!("provider")],
                        "Provider capabilities must be unique.",
                    );
                }
            }
        }
        "run-definition-list" => {
            // Preserve Map insertion order, including replacement of duplicate keys.
            let mut ready: Vec<(&Value, &Value)> = Vec::new();
            for entry in value["inventory"]["entries"]
                .as_array()
                .ok_or(ValidationError::Operation)?
            {
                if entry["status"] == "ready"
                    && super::coercion::truthy(entry.get("id"))
                    && super::coercion::truthy(entry.get("document"))
                {
                    if let Some(existing) = ready.iter_mut().find(|(id, _)| **id == entry["id"]) {
                        existing.1 = &entry["document"]["provider"];
                    } else {
                        ready.push((&entry["id"], &entry["document"]["provider"]));
                    }
                }
            }
            let mut seen = Vec::new();
            for (index, validation) in value["validations"]
                .as_array()
                .ok_or(ValidationError::Operation)?
                .iter()
                .enumerate()
            {
                let id = &validation["configurationId"];
                if seen.contains(&id) {
                    issue(
                        &[json!("validations"), json!(index), json!("configurationId")],
                        "Run configuration list validations must be unique.",
                    );
                }
                seen.push(id);
                if ready
                    .iter()
                    .find(|(ready_id, _)| ready_id == &id)
                    .is_none_or(|(_, provider)| **provider != validation["provider"])
                {
                    issue(
                        &[json!("validations"), json!(index)],
                        "Run configuration list validation does not match a ready definition.",
                    );
                }
            }
            for (id, _) in ready {
                if !seen.contains(&id) {
                    issue(
                        &[json!("validations")],
                        "Every ready Run configuration must include provider validation.",
                    );
                }
            }
        }
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
