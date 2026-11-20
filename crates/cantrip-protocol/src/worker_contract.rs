//! Native counterparts of explicitly registered incoming worker refinements.
use super::{JsString, Parsed, ValidationError, Value, value::json};
use std::{collections::HashSet, sync::OnceLock};

fn text(value: &Value) -> Result<&JsString, ValidationError> {
    value.as_js_string().ok_or(ValidationError::Operation)
}
fn number(value: &Value) -> Result<f64, ValidationError> {
    value.as_f64().ok_or(ValidationError::Operation)
}
fn controls(value: &JsString) -> bool {
    value
        .units()
        .iter()
        .any(|unit| matches!(*unit, 0..=31 | 127..=159))
}

fn cua_timeline(value: &Value) -> Result<bool, ValidationError> {
    let mut held = HashSet::new();
    let mut pointer = false;
    let mut time = 0;
    for frame in value.as_array().ok_or(ValidationError::Operation)? {
        let at = frame["atMs"].as_u64().ok_or(ValidationError::Operation)?;
        let down = frame["keyDown"]
            .as_array()
            .ok_or(ValidationError::Operation)?;
        let up = frame["keyUp"]
            .as_array()
            .ok_or(ValidationError::Operation)?;
        let key_modifiers = frame["keyModifiers"]
            .as_array()
            .ok_or(ValidationError::Operation)?;
        let pointer_modifiers = frame["pointerModifiers"]
            .as_array()
            .ok_or(ValidationError::Operation)?;
        let pointer_down = frame.get("pointerDown").is_some();
        if at < time
            || (frame.get("pointerButton").is_some() && !pointer_down)
            || (!key_modifiers.is_empty() && down.is_empty())
            || (!pointer_modifiers.is_empty() && !pointer_down)
        {
            return Ok(false);
        }
        time = at;
        for key in up {
            if !held.remove(text(key)?) {
                return Ok(false);
            }
        }
        for key in down {
            if !held.insert(text(key)?) {
                return Ok(false);
            }
        }
        if held.len() > 16 {
            return Ok(false);
        }
        if frame["pointerUp"] == true {
            if !pointer {
                return Ok(false);
            }
            pointer = false;
        }
        if pointer_down {
            if pointer {
                return Ok(false);
            }
            pointer = true;
        }
    }
    Ok(held.is_empty() && !pointer)
}
pub(super) fn uuid(value: &Value) -> bool {
    static PATTERN: OnceLock<regress::Regex> = OnceLock::new();
    value.as_js_string().is_some_and(|value| {
        PATTERN.get_or_init(|| regress::Regex::new(
            r"^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
        ).expect("protocol UUID pattern")).find_from_utf16(value.units(), 0).next().is_some()
    })
}

pub(super) fn refine(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
    message: Option<&str>,
) -> Result<bool, ValidationError> {
    if !tag.starts_with("worker-wire-") {
        return Ok(false);
    }
    let value = result.value.as_ref().ok_or(ValidationError::Operation)?;
    let mut issues = Vec::new();
    let mut custom = |suffix: &[&str], message: &str| {
        let mut at = path.to_vec();
        at.extend(suffix.iter().map(|key| json!(key)));
        issues.push(json!({"code":"custom","message":message,"path":at}));
    };
    match tag {
        "worker-wire-provider-observation" => {
            if value["status"]["state"] == "authenticated"
                && value["status"]["authMode"] != value["providerKind"]
            {
                custom(
                    &["status", "authMode"],
                    "Provider auth mode must match the provider kind.",
                );
            }
        }
        "worker-wire-provider-status" => {
            let authenticated = value["state"] == "authenticated";
            let failed = ["cancelled", "expired", "failed"]
                .iter()
                .any(|state| value["state"] == *state);
            if authenticated == value["authMode"].is_null() {
                custom(
                    &["authMode"],
                    "Only authenticated provider state may include an auth mode.",
                );
            }
            if failed == value["failureCode"].is_null() {
                custom(
                    &["failureCode"],
                    "Provider auth failures require one safe failure code.",
                );
            }
            if (value["state"] == "cancelled" && value["failureCode"] != "authorization-cancelled")
                || (value["state"] == "expired" && value["failureCode"] != "authorization-expired")
                || (value["state"] == "failed"
                    && ["authorization-cancelled", "authorization-expired"]
                        .iter()
                        .any(|code| value["failureCode"] == *code))
            {
                custom(
                    &["failureCode"],
                    "Provider auth lifecycle and failure code do not match.",
                );
            }
            if !authenticated
                && ["email", "planType", "weeklyUsage"]
                    .iter()
                    .any(|key| super::coercion::truthy(value.get(key)))
            {
                custom(
                    &[],
                    "Signed-out provider state may not include account details.",
                );
            }
        }
        "worker-wire-runtime-result" => {
            if value["outcome"] == "not-found" && !value["observation"].is_null() {
                custom(
                    &["observation"],
                    "A missing runtime cannot include an observation.",
                );
            }
            if value["outcome"] != "not-found" && value["observation"].is_null() {
                custom(
                    &["observation"],
                    "A runtime operation result requires an observation.",
                );
            }
        }
        "worker-wire-runtime-observation" => {
            let terminal = ["idle", "exited", "failed", "lost"]
                .iter()
                .any(|state| value["state"] == *state);
            if terminal && value["endedAt"].is_null() {
                custom(
                    &["endedAt"],
                    "A terminal runtime observation requires an end time.",
                );
            }
            if !terminal && !value["endedAt"].is_null() {
                custom(
                    &["endedAt"],
                    "An active runtime observation cannot have an end time.",
                );
            }
            if !value["failure"].is_null() && value["state"] != "failed" && value["state"] != "lost"
            {
                custom(
                    &["failure"],
                    "Only failed or lost runtimes may include failure metadata.",
                );
            }
            if !value["exitCode"].is_null()
                && value["state"] != "idle"
                && value["state"] != "exited"
                && value["state"] != "failed"
            {
                custom(
                    &["exitCode"],
                    "An active or lost runtime cannot include an exit code.",
                );
            }
        }
        "worker-wire-repository-path" => {
            let units = text(value)?.units();
            let drive = units.len() >= 3
                && matches!(units[0], 65..=90 | 97..=122)
                && units[1] == 58
                && matches!(units[2], 47 | 92);
            if units.first() == Some(&47)
                || drive
                || units
                    .split(|unit| matches!(*unit, 47 | 92))
                    .any(|segment| segment == [46, 46])
                || units.contains(&0)
            {
                custom(&[], message.unwrap_or("Invalid input"));
            }
        }
        "worker-wire-observation-size" => {
            if value.stringify().len() > 512 * 1024 {
                custom(
                    &[],
                    "Worker observation envelopes may contain at most 512 KiB.",
                );
            }
        }
        "worker-wire-observation-progress" => {
            let valid_root = (value["contextKind"] == "project"
                && !value["worktreeId"].is_null()
                && value["scratchRootId"].is_null())
                || (value["contextKind"] == "standalone"
                    && value["worktreeId"].is_null()
                    && !value["scratchRootId"].is_null());
            if !valid_root {
                custom(
                    &["contextKind"],
                    "The observation execution root is invalid.",
                );
            }
            let event = &value["event"];
            let provisional =
                |message: &Value| message["streaming"] == true || message["phase"] == "commentary";
            let allowed = match event["type"].as_str() {
                Some("agent.activity" | "agent.inference-progress") => true,
                Some("agent.message") => provisional(&event["message"]),
                Some("agent.protected-message" | "agent.protected-task-message") => {
                    let telemetry = &event["telemetry"];
                    matches!(telemetry["kind"].as_str(), Some("activity" | "usage"))
                        || (telemetry["kind"] == "message" && provisional(telemetry))
                }
                _ => false,
            };
            if !allowed {
                custom(
                    &["event"],
                    "Final messages, outcomes, approvals, and durable worker events cannot use the provisional observation channel.",
                );
            }
        }
        "worker-wire-observation-notification" => {
            let allowed = match value["notification"]["type"].as_str() {
                Some("worktree.filesystem.changed") => value["topic"] == "filesystem",
                Some(
                    "worktree.inventory.observed"
                    | "worktree.status.observed"
                    | "git.operation.observed",
                ) => value["topic"] == "worktree",
                Some(
                    "terminal.runtime.observed"
                    | "codegraph.status.observed"
                    | "project.run-configuration-runtime.observed"
                    | "project.run-configuration-definitions.changed",
                ) => value["topic"] == "runtime",
                _ => false,
            };
            if !allowed {
                custom(
                    &["notification"],
                    "This worker notification is not authorized for the selected provisional observation topic.",
                );
            }
        }
        "worker-wire-chat-turn-root" => {
            let project = value["contextKind"] == "project"
                && !value["worktreeId"].is_null()
                && value["scratchRootId"].is_null();
            let standalone = value["contextKind"] == "standalone"
                && value["worktreeId"].is_null()
                && !value["scratchRootId"].is_null();
            if !project && !standalone {
                custom(
                    &["contextKind"],
                    "Chat turn outcome execution root is invalid.",
                );
            }
        }
        "worker-wire-link-candidates" => {
            if !super::coercion::truthy(value.get("complete"))
                && value["candidates"]
                    .as_array()
                    .ok_or(ValidationError::Operation)?
                    .is_empty()
            {
                custom(
                    &["candidates"],
                    "An incomplete candidate advertisement cannot be empty.",
                );
            }
        }
        "worker-wire-link-signal" => {
            if value["envelope"]["sender"] != "worker" {
                custom(
                    &["envelope", "sender"],
                    "Worker peer notifications must be worker-authored.",
                );
            }
        }
        "worker-wire-utf8-256" => {
            if text(value)?.lossy().len() > 256 {
                custom(&[], message.unwrap_or("Invalid input"));
            }
        }
        "worker-wire-cua-id" => {
            let value = text(value)?;
            if value.is_empty() || controls(value) {
                custom(&[], message.unwrap_or("Invalid input"));
            }
        }
        "worker-wire-cursor-label" => {
            let value = text(value)?;
            if std::char::decode_utf16(value.units().iter().copied()).count() > 64
                || controls(value)
            {
                custom(&[], message.unwrap_or("Invalid input"));
            }
        }
        "worker-wire-image-pixels" => {
            if number(&value["width"])? * number(&value["height"])? > 4_194_304.0 {
                custom(&[], message.unwrap_or("Invalid input"));
            }
        }
        "worker-wire-cua-title-size" | "worker-wire-cua-application-size" => {
            let max = if tag == "worker-wire-cua-title-size" {
                4096
            } else {
                1024
            };
            if text(value)?.lossy().len() > max {
                custom(&[], message.unwrap_or("Invalid input"));
            }
        }
        "worker-wire-cua-clipboard-bytes" => {
            if text(value)?.lossy().len() > 1024 * 1024 {
                custom(&[], message.unwrap_or("Invalid input"));
            }
        }
        "worker-wire-cua-clipboard-unicode" | "worker-wire-cua-input-text" => {
            let content = text(value)?;
            let input_text = tag == "worker-wire-cua-input-text";
            if (input_text && content.lossy().len() > 8192)
                || std::char::decode_utf16(content.units().iter().copied()).any(|decoded| {
                    match decoded {
                        Err(_) => true,
                        Ok(c) => input_text && matches!(c as u32, 0..=8 | 11 | 12 | 14..=31 | 127),
                    }
                })
            {
                custom(&[], message.unwrap_or("Invalid input"));
            }
        }
        "worker-wire-cua-input-modifiers" => {
            let items = value.as_array().ok_or(ValidationError::Operation)?;
            if !items
                .iter()
                .enumerate()
                .all(|(index, item)| !items[..index].contains(item))
            {
                custom(&[], message.unwrap_or("Invalid input"));
            }
        }
        "worker-wire-cua-input-timeline" => {
            if !cua_timeline(value)? {
                custom(&[], message.unwrap_or("Timeline downs and ups must balance, with ordered times and at most 16 held keys."));
            }
        }
        "worker-wire-cua-target-ids" => {
            let targets = value.as_array().ok_or(ValidationError::Operation)?;
            let mut ids = std::collections::HashSet::new();
            if targets
                .iter()
                .any(|target| !ids.insert(target["id"].as_js_string()))
            {
                custom(&[], message.unwrap_or("Invalid input"));
            }
        }
        "worker-wire-cua-inventory-cursor" => {
            if let Some(cursor) = value.get("nextCursor") {
                let targets = value["targets"]
                    .as_array()
                    .ok_or(ValidationError::Operation)?;
                if value["truncated"] != true
                    || targets.last().is_none_or(|last| &last["id"] != cursor)
                    || targets.windows(2).any(|pair| {
                        pair[0]["id"].as_js_string().map(JsString::units)
                            >= pair[1]["id"].as_js_string().map(JsString::units)
                    })
                {
                    custom(&[], message.unwrap_or("Invalid input"));
                }
            }
        }
        "worker-wire-interaction-storage" => {
            if value.stringify().encode_utf16().count() > 1_000_000 {
                custom(&[], message.unwrap_or("Invalid input"));
            }
        }
        "worker-wire-communication-envelope" | "worker-wire-task-envelope" => {
            if value["envelope"]["version"] != value["formatVersion"]
                || value["envelope"]["keyRevision"] != value["keyRevision"]
            {
                custom(
                    &["envelope"],
                    if tag == "worker-wire-task-envelope" {
                        "Protected Task envelope metadata must match its outer metadata."
                    } else {
                        "Protected communication envelope metadata must match its outer metadata."
                    },
                );
            }
        }
        "worker-wire-attachment-ids" => {
            let mut seen = HashSet::new();
            if value
                .as_array()
                .ok_or(ValidationError::Operation)?
                .iter()
                .any(|value| !seen.insert(value.as_js_string()))
            {
                custom(&[], message.unwrap_or("Invalid input"));
            }
        }
        "worker-wire-permission-cwd" => {
            if value["cwd"].is_null() && value["source"] != "native-computer-use" {
                // The refinement's configured path is applied by Contracts.
                custom(&[], message.unwrap_or("Invalid input"));
            }
        }
        "worker-wire-inference-progress" => {
            if value["precision"] == "indeterminate" && !value["fractionComplete"].is_null() {
                custom(
                    &["precision"],
                    "Indeterminate progress cannot include a completed fraction.",
                );
            }
            if value["precision"] != "indeterminate" && value["fractionComplete"].is_null() {
                custom(
                    &["precision"],
                    "Determinate progress requires a completed fraction.",
                );
            }
            if !value["totalTokens"].is_null() && value["completedTokens"].is_null() {
                custom(
                    &["totalTokens"],
                    "A total token count requires a completed token count.",
                );
            }
            if !value["completedTokens"].is_null()
                && !value["totalTokens"].is_null()
                && number(&value["completedTokens"])? > number(&value["totalTokens"])?
            {
                custom(
                    &["completedTokens"],
                    "Completed tokens cannot exceed total tokens.",
                );
            }
            if super::live::datetime_millis(&value["startedAt"])
                .zip(super::live::datetime_millis(&value["observedAt"]))
                .is_some_and(|(start, observed)| start > observed)
            {
                custom(
                    &["startedAt"],
                    "Inference progress cannot be observed before it starts.",
                );
            }
        }
        "worker-wire-raw-metadata" => {
            if value.as_object().ok_or(ValidationError::Operation)?.len() > 32 {
                custom(&[], message.unwrap_or("Invalid input"));
            }
        }
        "worker-wire-raw-request" | "worker-wire-raw-response" | "worker-wire-command-output" => {
            let limit = if tag == "worker-wire-raw-request" {
                65_536
            } else {
                262_144
            };
            if text(value)?.lossy().len() > limit {
                let message = if tag == "worker-wire-command-output" {
                    format!("Agent command output may contain at most {limit} encoded bytes.")
                } else {
                    format!("Raw capture text may contain at most {limit} encoded bytes.")
                };
                custom(&[], &message);
            }
        }
        "worker-wire-computer-use-activity" => {
            let binding = &value["binding"];
            let scope = value.get("agentScope");
            let correlation = value.get("correlation");
            let invalid_actor = if value["source"] == "user-preview" {
                !binding["threadId"].is_null()
                    || !binding["turnId"].is_null()
                    || super::coercion::truthy(scope)
            } else {
                !super::coercion::truthy(scope)
                    || scope.is_none_or(|scope| binding["threadId"] != scope["agentThreadId"])
                    || binding["turnId"].is_null()
            };
            let status_mismatch = if value["outcome"] == "cancelled" {
                value["status"] != "failed"
            } else {
                value["status"] != value["outcome"]
            };
            if invalid_actor
                || correlation.is_some_and(|correlation| {
                    super::coercion::truthy(Some(correlation))
                        && (correlation["threadId"] != binding["threadId"]
                            || correlation["turnId"] != binding["turnId"])
                })
                || status_mismatch
                || number(&value["completedAtMs"])? < number(&value["startedAtMs"])?
                || number(&value["updatedAtMs"])? < number(&value["startedAtMs"])?
            {
                custom(
                    &[],
                    "Computer-use activity must retain its actual actor, outcome and timing.",
                );
            }
        }
        "worker-wire-discovery-progress" => {
            if (value["truncated"] == Value::Bool(true))
                != (value["diagnosticCode"] == "scan-truncated")
            {
                custom(
                    &["diagnosticCode"],
                    "Repository discovery truncation metadata is invalid.",
                );
            }
        }
        "worker-wire-computer-use-content" => {
            if value["domain"] != "client-control-content"
                || text(&value["envelope"]["ciphertext"])?.len()
                    > ((262_144usize + 16) * 4).div_ceil(3)
            {
                custom(&[], message.unwrap_or("Invalid input"));
            }
        }
        "worker-wire-protected-interaction-owner" => {
            if value["provenance"]["owner"] == "computer-use" {
                if value.get("id").is_some_and(|id| !uuid(id)) {
                    custom(
                        &["id"],
                        "Computer-use interaction IDs must be genuine request UUIDs.",
                    );
                }
                if value["classification"]["kind"] != "permissions" {
                    custom(
                        &["classification", "kind"],
                        "Computer-use interactions require permissions classification.",
                    );
                }
            }
        }
        _ => return Err(ValidationError::Operation),
    }
    result.issues.extend(issues);
    Ok(true)
}
