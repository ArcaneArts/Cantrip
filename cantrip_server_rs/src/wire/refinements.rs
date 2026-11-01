use super::{Parsed, ValidationError};
use super::{Value, value::json};

pub(super) fn apply(
    tag: &str,
    result: &mut Parsed,
    path: &[Value],
    message: Option<&str>,
) -> Result<(), ValidationError> {
    if super::public_chats::refine(tag, result, path)? {
        return Ok(());
    }
    if super::tasks::refine(tag, result, path)? {
        return Ok(());
    }
    if super::agent_interactions::refine(tag, result, path)? {
        return Ok(());
    }
    if super::workspace_discovery::refine(tag, result, path)? {
        return Ok(());
    }
    if super::run_configurations::refine(tag, result, path)? {
        return Ok(());
    }
    if super::project_shares::refine(tag, result, path, message)? {
        return Ok(());
    }
    if super::project_surfaces::refine(tag, result, path, message)? {
        return Ok(());
    }
    if super::browsers::refine(tag, result, path, message)? {
        return Ok(());
    }
    if super::workspaces::refine(tag, result, path)? {
        return Ok(());
    }
    if super::project_tabs::refine(tag, result, path)? {
        return Ok(());
    }
    if super::terminals::refine(tag, result, path, message)? {
        return Ok(());
    }
    if super::worker_command::refine(tag, result, path, message)? {
        return Ok(());
    }
    if super::worker_contract::refine(tag, result, path, message)? {
        return Ok(());
    }
    if super::projects::refine(tag, result, path)? {
        return Ok(());
    }
    if super::live::refine(tag, result, path, message)? {
        return Ok(());
    }
    let value = result
        .value
        .as_ref()
        .ok_or(ValidationError::Operation)?
        .clone();
    if matches!(
        tag,
        "native-history-archive-evidence" | "native-history-evidence-revision"
    ) {
        let invalid = super::coercion::truthy(value.get("evidence"))
            && if tag == "native-history-archive-evidence" {
                value["evidence"]["revision"]
                    .as_f64()
                    .zip(value["revision"].as_f64())
                    .is_some_and(|(e, r)| e > r)
            } else {
                value["evidence"]["revision"] != value["revision"]
            };
        if invalid {
            let message = if tag == "native-history-archive-evidence" {
                "Archived evidence cannot be newer than the committed item."
            } else {
                "Native item evidence must match the prepared item revision."
            };
            let mut at = path.to_vec();
            at.extend([json!("evidence"), json!("revision")]);
            // Zod's explicit addIssue path precedes its message in Error.message.
            result
                .issues
                .push(json!({"code":"custom","path":at,"message":message}));
        }
        return Ok(());
    }
    let mut custom = |suffix: &[&str], message: &str| {
        let mut at = path.to_vec();
        at.extend(suffix.iter().map(|v| json!(v)));
        result.issue(json!({"code":"custom"}), &at, message.into(), false);
    };
    if tag == "native-command-event" {
        if !matches!(
            value["type"].as_str(),
            Some(
                "agent.protected-message"
                    | "agent.protected-task-message"
                    | "agent.interaction.requested.protected"
                    | "agent.interaction.cleared"
                    | "agent.interaction.expired"
                    | "agent.plan.protected"
                    | "computer-use.approval.request"
                    | "computer-use.approval.terminal"
            )
        ) {
            custom(&[], "Only protected native operation events are accepted.");
        }
        return Ok(());
    } else if tag == "native-command-admission" {
        let session = &value["session"];
        if value["origin"] != "gui"
            && ["threadId", "runtimeGeneration", "connectionId"]
                .iter()
                .any(|field| !super::coercion::truthy(session.get(field)))
        {
            custom(&[], "Terminal commands require a bound native session.");
        }
        if (session["contextKind"] == "standalone") != session["projectId"].is_null() {
            custom(&[], "The placement context is inconsistent.");
        }
        return Ok(());
    }
    if tag == "native-settings-evidence" {
        use super::coercion::truthy;
        if truthy(value.get("recoveryBindingId"))
            && (value["kind"] != "applied" || !truthy(value.get("permissionPolicy")))
        {
            custom(
                &[],
                "Recovery binding requires applied permission evidence.",
            );
        }
        if truthy(value.get("permissionPolicy")) && value["kind"] != "applied" {
            custom(&[], "Permission policy requires applied native evidence.");
        }
        if matches!(value["kind"].as_str(), Some("queued" | "applied"))
            && !truthy(value.get("submissionId"))
        {
            custom(
                &[],
                "Native queue/application evidence requires a submission identity.",
            );
        }
        return Ok(());
    }
    if tag == "native-deferred-pair" {
        if super::coercion::truthy(value.get("retainedPrompt"))
            != super::coercion::truthy(value.get("attachments"))
        {
            custom(
                &[],
                "Retained prompt and attachments must be supplied together.",
            );
        }
        return Ok(());
    }
    if tag == "native-settings-version" {
        let valid = value.as_str().is_some_and(|s| {
            !s.is_empty()
                && s.len() <= 20
                && (s == "0" || !s.starts_with('0'))
                && s.bytes().all(|b| b.is_ascii_digit())
                && s.parse::<u64>().is_ok()
        });
        if !valid {
            custom(&[], message.unwrap_or("Invalid input"));
        }
        return Ok(());
    }
    if tag == "conversion-source-pair" {
        if value.get("projectSourceId").is_some() != value.get("workerId").is_some() {
            custom(&[], "Conversion source fields must be provided together.");
        }
        return Ok(());
    }
    if tag == "worktree-create-mutation-failure" {
        let outcome = value["mutation"]["outcome"].as_str().unwrap_or_default();
        let suffix = match outcome {
            "notStarted" => "not-started",
            "rolledBack" => "rolled-back",
            other => other,
        };
        if value["code"] != format!("worktree-create-{suffix}").as_str() {
            custom(
                &["code"],
                "Worktree mutation failure code must match its outcome.",
            );
        }
        if (outcome == "notStarted") != value["mutation"]["target"].is_null() {
            custom(
                &["mutation", "target"],
                "Only a worktree mutation that did not start may omit its recovery target.",
            );
        }
        return Ok(());
    }
    if tag == "worker-link-signal-bytes" || tag == "worker-link-mailbox-bytes" {
        if value.stringify().len() > 4 * 1024 * 1024 {
            if tag == "worker-link-signal-bytes" {
                custom(
                    &["signals"],
                    "WorkerLink peer signaling exceeds the byte limit.",
                );
            } else {
                custom(&[], "WorkerLink peer mailbox exceeds the byte limit.");
            }
        }
        return Ok(());
    }
    let wrapper = &value["passwordWrappedMasterKey"];
    match tag {
        "task-message-relay-result" => {
            if value["message"]["classification"]["role"] != "assistant" {
                let mut at = path.to_vec();
                at.extend([json!("message"), json!("classification")]);
                result.issues.push(json!({"code":"custom","message":"An encrypted Task turn must return an assistant message.","path":at}));
            }
        }
        "chat-message-root" => {
            let valid = (value["contextKind"] == "project"
                && !value["worktreeId"].is_null()
                && value["scratchRootId"].is_null())
                || (value["contextKind"] == "standalone"
                    && value["worktreeId"].is_null()
                    && !value["scratchRootId"].is_null());
            if !valid {
                custom(&["contextKind"], "Chat message execution root is invalid.");
            }
        }
        "encrypted-plan-state" => {
            if !value["state"].is_null()
                && value["state"]["classification"]["hasQuestion"] != value["hasQuestion"]
            {
                custom(
                    &["state", "classification", "hasQuestion"],
                    "Encrypted plan question metadata is inconsistent.",
                );
            }
            if value["state"].is_null() && value["hasQuestion"] == true {
                custom(
                    &["state"],
                    "Pending encrypted plans require protected state.",
                );
            }
        }
        "pane-title" => {
            if value["titleProtection"]["classification"]["recordKind"] != "tab-group" {
                custom(&[], "Tab-group title classification must be tab-group.");
            }
        }
        "pane-order-unique" | "member-order-unique" | "group-order-unique" => {
            let values = value.as_array().ok_or(ValidationError::Operation)?;
            let mut seen = std::collections::HashSet::new();
            if values
                .iter()
                .any(|v| v.as_js_string().is_some_and(|s| !seen.insert(s.clone())))
            {
                custom(&[], message.ok_or(ValidationError::Operation)?);
            }
        }
        "surface-open-target" => {
            if super::coercion::truthy(value.get("targetPaneId"))
                && super::coercion::truthy(value.get("targetRegion"))
            {
                custom(
                    &[],
                    "Specify either a target pane or a target region, not both.",
                );
            }
        }
        "workspace-receipt" => {
            if value["appliedRevision"].as_f64() > value["layout"]["revision"].as_f64() {
                custom(&[], "Receipt is newer than its layout");
            }
        }
        "tunnel-create-operation" => {
            if value["id"] != value["protectedRecord"]["operationId"] {
                custom(
                    &[],
                    "A new tunnel record must use its tunnel id as operation id.",
                );
            }
        }
        "tunnel-create-revision" => {
            if value["protectedRecord"]["revision"] != 1 {
                custom(&[], "A new tunnel record must begin at revision one.");
            }
        }
        "repository-agent-model" => {
            if value["agent"] != true && value.get("modelId").is_some() {
                custom(
                    &[],
                    "Repository model selection is only valid for agent operations.",
                );
            }
        }
        "provider-initial-account" => {
            let requires_account = value["kind"] == "chatgpt" || value["kind"] == "grok";
            if requires_account == value["initialAccount"].is_null() {
                custom(
                    &["initialAccount"],
                    "Account-backed providers require one protected initial account.",
                );
            }
        }
        "provider-account-update-fields" => {
            if value
                .as_object()
                .ok_or(ValidationError::Operation)?
                .is_empty()
            {
                custom(&[], "Provide at least one provider account update.");
            }
        }
        "provider-auth-live-kind" => {
            if value["status"]["state"] == "authenticated"
                && value["status"]["authMode"] != value["providerKind"]
            {
                custom(
                    &["status", "authMode"],
                    "Provider auth mode must match the provider kind.",
                );
            }
        }
        "settings-elite-range" => {
            if value["glitchCountMax"]
                .as_f64()
                .ok_or(ValidationError::Operation)?
                < value["glitchCountMin"]
                    .as_f64()
                    .ok_or(ValidationError::Operation)?
            {
                custom(
                    &[],
                    "Maximum glitches must be greater than or equal to minimum glitches.",
                );
            }
        }
        "settings-cursor-content" => {
            if value["domain"] != "customization-content"
                || value["envelope"]["ciphertext"]
                    .as_js_string()
                    .ok_or(ValidationError::Operation)?
                    .len()
                    > 4 * 4112_usize.div_ceil(3)
            {
                custom(
                    &[],
                    "Cursor preferences require bounded customization ciphertext.",
                );
            }
        }
        "model-routes-enabled" => {
            if !value
                .as_array()
                .ok_or(ValidationError::Operation)?
                .iter()
                .any(|route| route["enabled"] == Value::Bool(true))
            {
                custom(&[], "At least one provider route must be enabled.");
            }
        }
        "settings-destination-fields" => {
            if [
                "lastAppMode",
                "lastIdeProjectId",
                "lastIdeWorkspaceId",
                "lastStandaloneChatId",
            ]
            .iter()
            .all(|name| value.get(name).is_none())
            {
                custom(&[], "At least one destination field must be updated.");
            }
        }
        "settings-mobile-project-limit" => {
            if value.as_object().ok_or(ValidationError::Operation)?.len() > 200 {
                custom(
                    &[],
                    "Mobile tab configurations cannot contain more than 200 projects.",
                );
            }
        }
        "policy-update-fields" => {
            if ["content", "enabled", "mandatory", "audience"]
                .iter()
                .all(|name| value.get(name).is_none())
            {
                custom(&[], "At least one encrypted policy field is required.");
            }
        }
        "policy-assignment-references" => {
            let policies = value["policies"]
                .as_array()
                .ok_or(ValidationError::Operation)?;
            let direct = value["directPolicyIds"]
                .as_array()
                .ok_or(ValidationError::Operation)?;
            for (index, id) in direct.iter().enumerate() {
                if !policies.iter().any(|policy| policy["id"] == *id) {
                    let mut at = path.to_vec();
                    at.extend([json!("directPolicyIds"), json!(index)]);
                    result.issue(
                        json!({"code":"custom"}),
                        &at,
                        "Direct assignments must reference a listed policy.".into(),
                        false,
                    );
                }
            }
        }
        "usage-history-window" => {
            if let (Some(from), Some(to)) = (
                super::live::datetime_millis(&value["from"]),
                super::live::datetime_millis(&value["to"]),
            ) {
                if to <= from {
                    custom(&["to"], "History end must be after its start.");
                } else {
                    let hourly = value["resolution"] == "hour";
                    let maximum = if hourly { 31 } else { 2 * 366 } * 86_400_000_i64;
                    if to - from > maximum {
                        custom(
                            &["from"],
                            if hourly {
                                "Hourly history is limited to 31 days."
                            } else {
                                "Daily history is limited to two years."
                            },
                        );
                    }
                }
            }
        }
        "usage-live-traffic-query" => {
            let after = super::coercion::truthy(value.get("after"));
            let epoch = super::coercion::truthy(value.get("epoch"));
            if after != epoch {
                custom(
                    &[if after { "epoch" } else { "after" }],
                    "Live traffic epoch and cursor must be provided together.",
                );
            }
        }
        "model-configuration" => {
            if value["customSubagentModel"] == Value::Bool(true)
                && !super::coercion::truthy(value.get("subagentModelId"))
            {
                custom(
                    &["subagentModelId"],
                    "A custom subagent model must be selected.",
                );
            }
        }
        "task-worker-update" => {
            if ![
                "name",
                "enabled",
                "modelConfiguration",
                "maxConcurrency",
                "allowsPlanGoal",
                "continuityFamilyOverride",
            ]
            .iter()
            .any(|key| value.get(key).is_some())
            {
                custom(&[], "A Task Worker update must change at least one field.");
            }
        }
        "canonical-base64url" => {
            let value = value.as_js_string().ok_or(ValidationError::Operation)?;
            let len = value.len();
            let remainder = len % 4;
            let last = value
                .units()
                .last()
                .and_then(|ch| char::from_u32(u32::from(*ch)))
                .and_then(|ch| {
                    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".find(ch)
                });
            let valid = remainder == 0
                || last.is_some_and(|last| {
                    if remainder == 2 {
                        last & 15 == 0
                    } else if remainder == 3 {
                        last & 3 == 0
                    } else {
                        false
                    }
                });
            if !valid {
                custom(
                    &[],
                    message.unwrap_or("Value is not canonical unpadded base64url."),
                );
            }
        }
        "password-wrapper-pair" => {
            if value["passwordKdf"].is_null() != wrapper.is_null() {
                custom(
                    &["passwordWrappedMasterKey"],
                    "Password KDF parameters and wrapper must both be present or absent.",
                );
            } else if !wrapper.is_null() {
                if value["passwordKdf"] != wrapper["kdf"] {
                    custom(
                        &["passwordKdf"],
                        "Password KDF parameters must match the wrapped key envelope.",
                    );
                }
                if wrapper["masterKeyRevision"] != value["activeMasterKeyRevision"] {
                    custom(
                        &["passwordWrappedMasterKey", "masterKeyRevision"],
                        "Password wrapper must target the active Account Master Key revision.",
                    );
                }
            }
        }
        "password-wrapper" => {
            if value["envelope"]["keyRevision"] != value["masterKeyRevision"] {
                custom(
                    &["envelope", "keyRevision"],
                    "Master-key and envelope revisions must match.",
                );
            }
            if value["envelope"]["ciphertext"]
                .as_js_string()
                .map(super::JsString::len)
                != Some(64)
            {
                custom(
                    &["envelope", "ciphertext"],
                    "Wrapped Account Master Key must contain exactly 48 bytes.",
                );
            }
        }
        "initial-client-wrapper" => {
            if value["initialClient"]["wrappedMasterKey"]["clientId"]
                != value["initialClient"]["id"]
                || value["initialClient"]["wrappedMasterKey"]["masterKeyRevision"]
                    != value["profile"]["activeMasterKeyRevision"]
            {
                custom(
                    &["initialClient", "wrappedMasterKey"],
                    "Initial client wrapper does not match the profile or principal.",
                );
            }
        }
        "password-change-kdf" => {
            if value["passwordKdf"] != wrapper["kdf"] {
                custom(
                    &["passwordKdf"],
                    "Password KDF parameters must match the wrapped key envelope.",
                );
            }
        }
        "principal-state" => {
            if (value["kind"] == "worker") == value["workerId"].is_null() {
                custom(
                    &["workerId"],
                    "Only worker principals may bind a worker identity.",
                );
            }
            let approved = super::coercion::truthy(Some(&value["approvedAt"]));
            let revoked = super::coercion::truthy(Some(&value["revokedAt"]));
            if value["state"] == "pending" && (approved || revoked) {
                custom(
                    &["state"],
                    "Pending principals cannot have approval or revocation timestamps.",
                );
            }
            if value["state"] == "approved" && (!approved || revoked) {
                custom(
                    &["state"],
                    "Approved principals require an approval timestamp only.",
                );
            }
            if value["state"] == "revoked" && !revoked {
                custom(
                    &["state"],
                    "Revoked principals require a revocation timestamp.",
                );
            }
        }
        "grant-create-metadata" | "grant-metadata" => {
            let wrapped = &value["wrappedKey"];
            if wrapped["purpose"] == "client-account-master-key" {
                if value["component"] != "account-master-key"
                    || wrapped["masterKeyRevision"] != value["keyRevision"]
                    || (tag == "grant-metadata" && wrapped["clientId"] != value["principalId"])
                {
                    custom(
                        &["wrappedKey"],
                        "Client grant metadata does not match its wrapped key.",
                    );
                }
            } else if wrapped["purpose"] == "worker-component-key"
                && (value["component"] != wrapped["component"]
                    || value["keyRevision"] != wrapped["keyRevision"])
            {
                custom(
                    &["wrappedKey"],
                    "Worker grant metadata does not match its wrapped key.",
                );
            }
            if tag == "grant-metadata"
                && (value["state"] == "revoked") == value["revokedAt"].is_null()
            {
                custom(
                    &["state"],
                    "Grant state and revocation timestamp must agree.",
                );
            }
        }
        "worker-encryption-status" => {
            if value["supported"] == false && value["state"] != "unavailable" {
                custom(
                    &["state"],
                    "Unsupported worker encryption must be unavailable.",
                );
            }
            if value["state"] == "ready" && value["principalId"].is_null() {
                custom(
                    &["principalId"],
                    "Ready worker encryption requires a principal.",
                );
            }
        }
        "worker-bootstrap" => {
            if value["principal"]["ownerId"] != value["ownerId"]
                || value["principal"]["kind"] != "worker"
            {
                custom(
                    &["principal"],
                    "Worker bootstrap identity does not match its owner.",
                );
            }
            if value["grants"]
                .as_array()
                .ok_or(ValidationError::Operation)?
                .iter()
                .any(|g| {
                    g["ownerId"] != value["ownerId"]
                        || g["principalId"] != value["principal"]["id"]
                        || g["state"] != "active"
                        || g["wrappedKey"]["purpose"] != "worker-component-key"
                })
            {
                custom(&["grants"], "Worker bootstrap contains an invalid grant.");
            }
        }
        "managed-runtime-components" => {
            if value["search"]["component"] != "searxng" {
                custom(
                    &["search", "component"],
                    "Search runtime status must describe SearXNG.",
                );
            }
            if value["browser"]["component"] != "playwright" {
                custom(
                    &["browser", "component"],
                    "Browser runtime status must describe Playwright.",
                );
            }
        }
        "managed-runtime-progress" => {
            if value["totalBytes"] != 0
                && super::numeric(&value["completedBytes"]) > super::numeric(&value["totalBytes"])
            {
                custom(
                    &[],
                    message.unwrap_or("Managed web runtime progress cannot exceed its total."),
                );
            }
        }
        _ => return Err(ValidationError::Operation),
    }
    Ok(())
}
