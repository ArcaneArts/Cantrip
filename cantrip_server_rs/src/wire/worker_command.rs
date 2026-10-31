//! Explicit native counterparts of outgoing worker command refinements.
use super::{JsString, Parsed, ValidationError, Value, value::json};
use std::collections::HashSet;

fn text(value: &Value) -> Result<&JsString, ValidationError> {
    value.as_js_string().ok_or(ValidationError::Operation)
}
fn truth(value: Option<&Value>) -> bool {
    super::coercion::truthy(value)
}
fn later(end: &Value, start: &Value) -> bool {
    super::live::datetime_millis(end)
        .zip(super::live::datetime_millis(start))
        .is_some_and(|(end, start)| end > start)
}
fn message_with(prefix: &str, value: &JsString, suffix: &str) -> JsString {
    JsString::new(
        prefix
            .encode_utf16()
            .chain(value.units().iter().copied())
            .chain(suffix.encode_utf16())
            .collect(),
    )
}
fn portable_path(value: &JsString, allow_root: bool) -> bool {
    let units = value.units();
    if units.is_empty()
        || units.contains(&0)
        || units.contains(&92)
        || units.first() == Some(&47)
        || units.get(1) == Some(&58) && units.first().is_some_and(|u| matches!(*u,65..=90|97..=122))
    {
        return false;
    }
    if units == [46] {
        return allow_root;
    }
    units
        .split(|u| *u == 47)
        .all(|part| !part.is_empty() && part != [46] && part != [46, 46])
}
fn key(target: &Value, fields: &[&str]) -> Result<Vec<u16>, ValidationError> {
    let mut output = Vec::new();
    for (index, field) in fields.iter().enumerate() {
        if index > 0 {
            output.push(0);
        }
        let value = match target.get(field) {
            Some(value) => {
                super::coercion::string(value).map_err(|_| ValidationError::Operation)?
            }
            None => "undefined".into(),
        };
        output.extend_from_slice(value.units());
    }
    Ok(output)
}

pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
    message: Option<&str>,
) -> Result<bool, ValidationError> {
    let Some(tag) = tag.strip_prefix("worker-command-") else {
        return Ok(false);
    };
    let (tag, parameter) = tag.split_once(':').unwrap_or((tag, ""));
    let value = result.value.as_ref().ok_or(ValidationError::Operation)?;
    let mut issues = Vec::new();
    let mut custom = |suffix: &[Value], message: JsString| {
        let mut at = path.to_vec();
        at.extend_from_slice(suffix);
        issues.push(Value::object([
            ("code", Value::String("custom".into())),
            ("message", Value::String(message)),
            ("path", Value::Array(at)),
        ]));
    };
    macro_rules! issue {
        ($suffix:expr, $message:expr) => {
            custom($suffix, $message.into())
        };
    }
    let invalid = match tag {
        "nul-free" => text(value)?.units().contains(&0),
        "not-blank" => text(value)?.trim().is_empty(),
        "no-equals" => text(value)?.units().contains(&61),
        "no-controls" => text(value)?
            .units()
            .iter()
            .any(|u| matches!(*u, 0..=31 | 127)),
        "not-dot" => value == "." || value == "..",
        "dart-path" => !text(value)?.units().ends_with(&[46, 100, 97, 114, 116]),
        "safe-revision" => {
            let units = text(value)?.units();
            units.first() == Some(&45) || units.iter().any(|u| matches!(*u, 0 | 10 | 13))
        }
        "secret-path" => {
            let units = text(value)?.units();
            units.first() == Some(&47)
                || units.last() == Some(&47)
                || units
                    .split(|u| *u == 47)
                    .any(|part| part.is_empty() || part == [46] || part == [46, 46])
        }
        "portable-path" | "portable-directory" => {
            !portable_path(text(value)?, tag == "portable-directory")
        }
        "review-path" => {
            let units = text(value)?.units();
            units.first() == Some(&47)
                || units.contains(&92)
                || units
                    .split(|u| *u == 47)
                    .any(|part| part.is_empty() || part == [46, 46])
        }
        "stun-url" => {
            let units = text(value)?.units();
            let prefix = if units.starts_with(&[115, 116, 117, 110, 58]) {
                5
            } else if units.starts_with(&[115, 116, 117, 110, 115, 58]) {
                6
            } else {
                0
            };
            prefix == 0
                || units.len() == prefix
                || units[prefix..]
                    .iter()
                    .any(|u| char::from_u32(u32::from(*u)).is_some_and(crate::text::whitespace))
        }
        "unique" => {
            let mut seen = HashSet::new();
            let mut duplicate = false;
            for item in value.as_array().ok_or(ValidationError::Operation)? {
                if !seen.insert(text(item)?) {
                    duplicate = true;
                    break;
                }
            }
            duplicate
        }
        "protected-bytes" | "control-content" => {
            let limit: usize = parameter.parse().map_err(|_| ValidationError::Operation)?;
            text(&value["envelope"]["ciphertext"])?.len() > ((limit + 16) * 4).div_ceil(3)
                || tag == "control-content" && value["domain"] != "client-control-content"
        }
        "surface-kind" => value["classification"]["recordKind"] != parameter,
        "tunnel-domain" => value["protectedContent"]["domain"] != "tunnel-content",
        "chat-title" => value["titleProtection"]["classification"]["recordKind"] != "chat",
        "task-model" => value["modelId"].is_null(),
        "source-path-pair" => {
            value.get("sourcePath").is_some() != value.get("sourceDisplayPath").is_some()
        }
        "workflow-inputs" => {
            value["inputs"]
                .as_object()
                .ok_or(ValidationError::Operation)?
                .len()
                > 50
        }
        "scratch-archive" => !later(&value["archiveExpiresAt"], &value["archivedAt"]),
        "scratch-archive-result" => {
            if value["archivedAt"].is_null() != value["archiveExpiresAt"].is_null() {
                issue!(
                    &[],
                    "Archive timestamps must both be present or both be absent."
                );
            } else if truth(value.get("archivedAt"))
                && truth(value.get("archiveExpiresAt"))
                && super::live::datetime_millis(&value["archiveExpiresAt"])
                    .zip(super::live::datetime_millis(&value["archivedAt"]))
                    .is_some_and(|(expiry, at)| expiry <= at)
            {
                issue!(
                    &[],
                    "Archive expiry must be later than the archive timestamp."
                );
            }
            false
        }
        "scratch-reconcile" => {
            value["archivedAt"].is_null() != value["archiveExpiresAt"].is_null()
                || truth(value.get("archivedAt"))
                    && truth(value.get("archiveExpiresAt"))
                    && !later(&value["archiveExpiresAt"], &value["archivedAt"])
        }
        "attachment-envelope" | "surface-envelope" => {
            if value["envelope"]["version"] != value["formatVersion"]
                || value["envelope"]["keyRevision"] != value["keyRevision"]
            {
                issue!(
                    &[json!("envelope")],
                    if tag == "attachment-envelope" {
                        "Protected attachment metadata envelope must agree."
                    } else {
                        "Protected surface-state envelope metadata must agree."
                    }
                );
            }
            false
        }
        "retry" => {
            if (value["status"] == "scheduled") == value["nextAttemptAt"].is_null() {
                issue!(
                    &[json!("nextAttemptAt")],
                    "Only scheduled retries have a next-attempt deadline."
                );
            }
            false
        }
        "steer" => {
            if truth(value.get("prompt")) == truth(value.get("protectedPrompt")) {
                issue!(
                    &[json!("protectedPrompt")],
                    "Chat steering requires exactly one visible or protected prompt."
                );
            }
            false
        }
        "interaction-response" => {
            if truth(value.get("protectedResponse")) == truth(value.get("response")) {
                issue!(&[], "Provide exactly one interaction response.");
            }
            false
        }
        "task-goal" => {
            if value["startMessage"]["classification"]["role"] != "user"
                || value["startMessage"]["classification"]["mode"] != "goal"
            {
                issue!(
                    &[json!("startMessage"), json!("classification")],
                    "An encrypted Task Goal requires an encrypted user message."
                );
            }
            false
        }
        "queued-prompt" => {
            if truth(value.get("customSubagentModel")) && !truth(value.get("subagentModelId")) {
                issue!(
                    &[json!("subagentModelId")],
                    "A custom queued subagent model must be selected."
                );
            }
            if value["pendingMessage"]["classification"]["mode"] != value["classification"]["mode"]
                || value["pendingMessage"]["classification"]["attachmentIds"].stringify()
                    != value["classification"]["attachmentIds"].stringify()
                || value["pendingMessage"].get("reasoningEffort") != value.get("reasoningEffort")
            {
                issue!(
                    &[json!("pendingMessage")],
                    "Queued prompt metadata must match its future encrypted chat message."
                );
            }
            false
        }
        "task-relay" => {
            let direct = value["classification"]["kind"] == "direct";
            if value["classification"]["status"] != "running"
                || truth(value["classification"].get("hasOutputPlan"))
                || truth(value["classification"].get("hasOutputQuestions"))
                || truth(value["classification"].get("hasOutputGoalPrompt"))
                || !value["classification"]["error"].is_null()
                || value["userMessage"]["classification"]["role"] != "user"
                || value["userMessage"]["classification"]["mode"]
                    != if direct { "default" } else { "plan" }
            {
                issue!(
                    &[json!("classification")],
                    "Encrypted Task relay input must describe a running operation."
                );
            }
            false
        }
        "chat-root" => {
            if !((value["contextKind"] == "project"
                && !value["worktreeId"].is_null()
                && value["scratchRootId"].is_null())
                || (value["contextKind"] == "standalone"
                    && value["worktreeId"].is_null()
                    && !value["scratchRootId"].is_null()))
            {
                issue!(
                    &[json!("contextKind")],
                    "Chat message execution root is invalid."
                );
            }
            false
        }
        "chat-turn" => {
            let project = value["executionProfile"] == "ide"
                && value["contextKind"] == "project"
                && !value["worktreeId"].is_null()
                && value["scratchRootId"].is_null()
                && !value["rootKind"].is_null()
                && !value["worktreeMode"].is_null()
                && !value["worktreePolicy"].is_null()
                && !value["policyProjectId"].is_null();
            let standalone = value["executionProfile"] == "standalone-chat"
                && value["contextKind"] == "standalone"
                && value["worktreeId"].is_null()
                && !value["scratchRootId"].is_null()
                && value["rootKind"].is_null()
                && truth(value.get("isPrimary"))
                && value["worktreeMode"].is_null()
                && value["worktreePolicy"].is_null()
                && value["policyProjectId"].is_null()
                && value["planMode"] == "default"
                && value["automationPaused"] == false
                && value.get("subagentDefaults").is_none_or(Value::is_null)
                && value.get("subagentProtocolVersion").is_none()
                && value.get("taskDispatchLease").is_none();
            if !project && !standalone {
                issue!(
                    &[json!("executionProfile")],
                    "Chat turn execution profile does not match its execution root and capabilities."
                );
            }
            if value["executionProfile"] == "ide"
                && (!value["standalonePolicies"]["policies"]
                    .as_array()
                    .ok_or(ValidationError::Operation)?
                    .is_empty()
                    || !value["chatSkillAudienceKeys"]
                        .as_array()
                        .ok_or(ValidationError::Operation)?
                        .is_empty())
            {
                issue!(
                    &[json!("standalonePolicies")],
                    "IDE chat turns cannot receive standalone Policy bodies or Chat Skill audiences."
                );
            }
            if ["prompt", "protectedPrompt", "protectedTaskPrompt"]
                .iter()
                .filter(|field| truth(value.get(field)))
                .count()
                != 1
            {
                issue!(
                    &[json!("protectedPrompt")],
                    "Chat turns require exactly one visible or protected prompt."
                );
            }
            if truth(value.get("protectedTaskPrompt"))
                && value["resultMode"]["kind"] != "task-message-encrypted"
            {
                issue!(
                    &[json!("resultMode")],
                    "Protected Task prompts require protected Task results."
                );
            }
            if truth(value.get("protectedPrompt"))
                && value["resultMode"]["kind"] != "chat-message-encrypted"
            {
                issue!(
                    &[json!("resultMode")],
                    "Protected chat prompts require protected chat results."
                );
            }
            if truth(value.get("taskDispatchLease"))
                && value["resultMode"]["kind"] != "task-encrypted"
                && value["resultMode"]["kind"] != "task-message-encrypted"
            {
                issue!(
                    &[json!("taskDispatchLease")],
                    "Task dispatch leases are only valid for Task turns."
                );
            }
            false
        }
        "surface-command" => {
            let browser = value["configuration"]["kind"] == "browser";
            let valid_resource = if browser {
                value["stateResource"] == "browser-row"
                    || value["stateResource"] == "browser-remote-surface"
            } else {
                value["stateResource"] == "remote-desktop-row"
                    || value["stateResource"] == "remote-desktop-surface"
            };
            if value["stateProtection"]["classification"]["recordKind"]
                != if browser {
                    "browser-state"
                } else {
                    "remote-desktop-state"
                }
                || value["stateRevision"].is_null()
                || !valid_resource
            {
                issue!(
                    &[json!("stateProtection")],
                    "Surface commands require protected state matching their kind."
                );
            }
            false
        }
        "observation-targets" => {
            let mut seen = HashSet::new();
            for (index, target) in value
                .as_array()
                .ok_or(ValidationError::Operation)?
                .iter()
                .enumerate()
            {
                let fields: &[&str] = if parameter == "codegraph" {
                    &["rootKind", "sourcePath", "worktreePath"]
                } else {
                    &["sourcePath", "worktreePath"]
                };
                if !seen.insert(key(target, fields)?) {
                    issue!(
                        &[json!(index)],
                        if parameter == "codegraph" {
                            "CodeGraph observation targets must be unique."
                        } else {
                            "Worktree observation targets must be unique."
                        }
                    );
                }
            }
            false
        }
        "secret-references" => {
            let mut seen = HashSet::new();
            for (index, secret) in value
                .as_array()
                .ok_or(ValidationError::Operation)?
                .iter()
                .enumerate()
            {
                if !seen.insert(text(&secret["reference"])?) {
                    issue!(
                        &[json!(index), json!("reference")],
                        "Protected secret references must be unique."
                    );
                }
            }
            false
        }
        "run-document" => {
            if value.stringify().len() > 524288 {
                issue!(
                    &[],
                    "Run configuration documents cannot exceed 524288 encoded bytes."
                );
            }
            false
        }
        "environment-names" => {
            let mut seen = HashSet::new();
            for collection in ["variables", "secrets"] {
                if let Some(items) = value.get(collection).and_then(Value::as_array) {
                    for (index, item) in items.iter().enumerate() {
                        let name = text(&item["name"])?;
                        if !seen.insert(name.lowercase()) {
                            issue!(
                                &[json!(collection), json!(index), json!("name")],
                                message_with("Environment name ", name, " is already declared.")
                            );
                        }
                    }
                }
            }
            false
        }
        "cargo-features" | "dart-defines" => {
            let mut seen = HashSet::new();
            let field = if tag == "cargo-features" {
                "features"
            } else {
                "dartDefines"
            };
            if let Some(items) = value.get(field).and_then(Value::as_array) {
                for (index, item) in items.iter().enumerate() {
                    let name = text(if tag == "cargo-features" {
                        item
                    } else {
                        &item["name"]
                    })?;
                    if !seen.insert(name) {
                        if tag == "cargo-features" {
                            issue!(
                                &[json!(field), json!(index)],
                                message_with("Cargo feature ", name, " is already enabled.")
                            );
                        } else {
                            issue!(
                                &[json!(field), json!(index), json!("name")],
                                message_with("Dart define ", name, " is already declared.")
                            );
                        }
                    }
                }
            }
            false
        }
        "conflict" => {
            if value["strategy"] == "manual" && value["content"].is_null() {
                issue!(
                    &[json!("content")],
                    "Manual conflict resolution requires result content."
                );
            }
            if value["strategy"] != "manual" && !value["content"].is_null() {
                issue!(
                    &[json!("content")],
                    "Only manual conflict resolution accepts result content."
                );
            }
            false
        }
        "rebase-todo" => {
            if value["action"] == "reword" && !truth(value.get("message")) {
                issue!(
                    &[json!("message")],
                    "Reword steps require a replacement commit message."
                );
            }
            if value["action"] != "reword" && truth(value.get("message")) {
                issue!(
                    &[json!("message")],
                    "Only reword steps accept a replacement commit message."
                );
            }
            false
        }
        "tag-action" => {
            if value["type"] == "create" {
                if truth(value.get("annotated")) && !truth(value.get("message")) {
                    issue!(&[json!("message")], "Annotated tags require a message.");
                }
                if !truth(value.get("annotated")) && truth(value.get("message")) {
                    issue!(
                        &[json!("message")],
                        "Lightweight tags do not have a tag message."
                    );
                }
            }
            false
        }
        "stash" => {
            if !truth(value.get("includeStaged"))
                && !truth(value.get("includeUnstaged"))
                && !truth(value.get("includeUntracked"))
            {
                issue!(&[], "Select at least one change scope.");
            }
            if truth(value.get("includeStaged"))
                && !truth(value.get("includeUnstaged"))
                && truth(value.get("includeUntracked"))
            {
                issue!(
                    &[],
                    "Git cannot combine staged-only and untracked stash scopes."
                );
            }
            false
        }
        "commit-search" | "history-filter" => {
            if truth(value.get("branch")) && truth(value.get("tag")) {
                issue!(
                    &[json!("tag")],
                    if tag == "commit-search" {
                        "Search can target a branch or tag, not both."
                    } else {
                        "History can target a branch or tag, not both."
                    }
                );
            }
            if truth(value.get("dateFrom"))
                && truth(value.get("dateTo"))
                && text(&value["dateFrom"])?.units() > text(&value["dateTo"])?.units()
            {
                issue!(
                    &[json!("dateTo")],
                    if tag == "commit-search" {
                        "Search end date cannot precede its start date."
                    } else {
                        "History end date cannot precede its start date."
                    }
                );
            }
            if tag == "commit-search"
                && !value
                    .as_object()
                    .ok_or(ValidationError::Operation)?
                    .values()
                    .any(|v| truth(Some(v)))
            {
                issue!(&[], "At least one commit search filter is required.");
            }
            false
        }
        "inline-comment" => {
            if value["startLine"].is_null() != value["startSide"].is_null() {
                issue!(
                    &[json!("startLine")],
                    "A multi-line comment requires both start line and side."
                );
            }
            if !value["startLine"].is_null()
                && value["startLine"]
                    .as_f64()
                    .ok_or(ValidationError::Operation)?
                    > value["line"].as_f64().ok_or(ValidationError::Operation)?
            {
                issue!(
                    &[json!("startLine")],
                    "Review start line cannot be after the end line."
                );
            }
            false
        }
        "review-reason" => {
            if value["event"] == "request-changes" && !truth(value.get("body")) {
                issue!(
                    &[json!("body")],
                    "Requesting changes requires an explanation."
                );
            }
            false
        }
        "pull-branches" => {
            if value["base"] == value["head"] {
                issue!(
                    &[json!("head")],
                    "Pull request head and base branches must differ."
                );
            }
            false
        }
        "runtime-profiles" => {
            if value["action"] == "clear-profiles" && value["component"] != "playwright" {
                issue!(
                    &[json!("component")],
                    "Only the managed browser runtime has persistent profiles."
                );
            }
            false
        }
        "link-lease" => {
            if super::live::datetime_millis(&value["expiresAt"])
                .zip(super::live::datetime_millis(&value["issuedAt"]))
                .is_some_and(|(expiry, issued)| expiry <= issued)
            {
                issue!(
                    &[json!("expiresAt")],
                    "Lease expiry must be later than issuance."
                );
            }
            if super::live::datetime_millis(&value["absoluteExpiresAt"])
                .zip(super::live::datetime_millis(&value["expiresAt"]))
                .is_some_and(|(absolute, expiry)| absolute < expiry)
            {
                issue!(
                    &[json!("absoluteExpiresAt")],
                    "Absolute expiry cannot precede lease expiry."
                );
            }
            false
        }
        "link-configuration" => {
            if truth(value.get("relayOnly"))
                && value["directRoutes"]
                    .as_object()
                    .ok_or(ValidationError::Operation)?
                    .values()
                    .any(|v| truth(Some(v)))
            {
                issue!(
                    &[json!("directRoutes")],
                    "Relay-only WorkerLink policy cannot enable a direct route."
                );
            }
            if !truth(value["directRoutes"].get("wan"))
                && !value["stunUrls"]
                    .as_array()
                    .ok_or(ValidationError::Operation)?
                    .is_empty()
            {
                issue!(
                    &[json!("stunUrls")],
                    "WorkerLink STUN URLs require the WAN route."
                );
            }
            false
        }
        "link-grant" => {
            if (value["binding"]["resource"]["kind"] == "observations")
                != value.get("observation").is_some()
            {
                issue!(
                    &[json!("observation")],
                    "Only observation grants require an installed observation subscription."
                );
            }
            if truth(value.get("observation"))
                && value["binding"]["resource"]["attachmentId"]
                    != value["observation"]["subscriptionId"]
            {
                issue!(
                    &[json!("observation"), json!("subscriptionId")],
                    "The observation subscription must match the exact grant attachment."
                );
            }
            false
        }
        "link-session" => {
            if !value["routePolicy"]["enabled"]
                .as_array()
                .ok_or(ValidationError::Operation)?
                .contains(&value["preferredRoute"])
            {
                issue!(
                    &[json!("preferredRoute")],
                    "Preferred route must be enabled by the session policy."
                );
            }
            false
        }
        _ => return Err(ValidationError::Operation),
    };
    if invalid {
        issue!(&[], message.unwrap_or("Invalid input"));
    }
    result.issues.extend(issues);
    Ok(true)
}
