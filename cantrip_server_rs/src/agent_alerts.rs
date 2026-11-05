//! The same live binding authority used by the Node MCP relay.
use crate::wire::Value;

pub const OPERATIONS: &[&str] = &[
    "context.get",
    "alert.raise",
    "alert.resolve",
    "task.create",
    "task.list",
    "task.status",
    "task.wait",
    "chat.list",
    "chat.read",
    "chat.wait",
    "chat.send",
    "context.compact",
    "policy.list",
    "policy.read",
    "target.list",
    "target.inspect",
    "run-configuration.list",
    "run-configuration.get",
    "run-configuration.detect",
    "run-configuration.create",
    "run-configuration.update",
    "run-configuration.delete",
    "run-configuration.start",
    "run-configuration.restart",
    "run-configuration.stop",
    "run-configuration.status",
    "run-configuration.read-output",
    "run-configuration.secret-set",
    "worktree.list",
    "worktree.status",
    "worktree.create",
    "worktree.switch",
    "worktree.release",
    "worktree.remove",
];
pub fn is_mutation(operation: &str) -> bool {
    matches!(
        operation,
        "alert.raise"
            | "alert.resolve"
            | "task.create"
            | "chat.send"
            | "context.compact"
            | "run-configuration.create"
            | "run-configuration.update"
            | "run-configuration.delete"
            | "run-configuration.start"
            | "run-configuration.restart"
            | "run-configuration.stop"
            | "run-configuration.secret-set"
            | "worktree.create"
            | "worktree.switch"
            | "worktree.release"
            | "worktree.remove"
    )
}
fn permitted(permission: &Value, operation: &str) -> bool {
    permission != ":read-only"
        || matches!(
            operation,
            "context.get"
                | "alert.raise"
                | "alert.resolve"
                | "task.list"
                | "task.status"
                | "task.wait"
                | "chat.list"
                | "chat.read"
                | "chat.wait"
                | "policy.list"
                | "policy.read"
                | "target.list"
                | "target.inspect"
                | "run-configuration.list"
                | "run-configuration.get"
                | "run-configuration.detect"
                | "run-configuration.status"
                | "run-configuration.read-output"
                | "worktree.list"
                | "worktree.status"
        )
}
#[derive(Debug)]
pub struct BindingError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
}
fn error(status: u16, code: &'static str, message: impl Into<String>) -> BindingError {
    BindingError {
        status,
        code,
        message: message.into(),
    }
}
pub fn validate_binding(
    owner: &str,
    binding: &Value,
    context: &Value,
    operation: &str,
    permission: &Value,
    now: i64,
) -> Result<(), BindingError> {
    if binding["ownerId"] != owner {
        return Err(error(
            403,
            "forbidden",
            "The MCP binding belongs to a different owner.",
        ));
    }
    let time = |key: &str| {
        binding[key]
            .as_js_string()
            .and_then(crate::wire::date_milliseconds)
            .unwrap_or(i64::MIN)
    };
    if time("issuedAt") > now + 60_000 {
        return Err(error(
            400,
            "invalid",
            "The MCP binding issue time is invalid.",
        ));
    }
    if time("expiresAt") <= now {
        return Err(error(401, "expired", "The MCP binding has expired."));
    }
    if !OPERATIONS.contains(&operation)
        || !binding["allowedOperations"]
            .as_array()
            .is_some_and(|v| v.iter().any(|v| v == operation))
    {
        return Err(error(
            403,
            "forbidden",
            "The MCP binding does not authorize that operation.",
        ));
    }
    let mut changed = Vec::new();
    for (key, label) in [
        ("contextKind", "context kind"),
        ("chatId", "chat"),
        ("projectId", "project"),
        ("scratchRootId", "scratch root"),
        ("workerId", "worker"),
    ] {
        if binding[key] != context[key] {
            changed.push(label);
        }
    }
    let exact = binding["contextKind"] == "standalone" || is_mutation(operation);
    if exact {
        for (key, label) in [
            ("executionLaneId", "execution lane"),
            ("worktreeId", "worktree"),
            ("rootKind", "root kind"),
        ] {
            if binding[key] != context[key] {
                changed.push(label);
            }
        }
        if &binding["permissionProfileId"] != permission {
            changed.push("permission profile");
        }
    }
    if operation != "context.get"
        && !matches!(
            context["status"].as_str(),
            Some("running" | "waiting-for-approval")
        )
    {
        changed.push("chat status");
    }
    if !changed.is_empty() {
        return Err(error(
            409,
            "stale-binding",
            format!(
                "The MCP binding no longer matches the active Cantrip chat lane (changed: {}).",
                changed.join(", ")
            ),
        ));
    }
    if !permitted(permission, operation) {
        return Err(error(
            403,
            "forbidden",
            "The active permission profile does not authorize that MCP operation.",
        ));
    }
    Ok(())
}

pub fn readiness(binding: &Value, context: &Value, permission: &Value) -> Value {
    use crate::wire::value::json;
    let mut changed = Vec::new();
    for (key, label) in [
        ("contextKind", "context-kind"),
        ("chatId", "chat"),
        ("projectId", "project"),
        ("scratchRootId", "scratch-root"),
        ("workerId", "worker"),
        ("executionLaneId", "execution-lane"),
        ("worktreeId", "worktree"),
        ("rootKind", "root-kind"),
    ] {
        if binding[key] != context[key] {
            changed.push(label);
        }
    }
    if &binding["permissionProfileId"] != permission {
        changed.push("permission-profile");
    }
    if !matches!(
        context["status"].as_str(),
        Some("running" | "waiting-for-approval")
    ) {
        changed.push("chat-status");
    }
    let authorized = binding["allowedOperations"]
        .as_array()
        .is_some_and(|operations| {
            operations
                .iter()
                .filter_map(Value::as_str)
                .any(|operation| {
                    OPERATIONS.contains(&operation)
                        && is_mutation(operation)
                        && permitted(permission, operation)
                })
        });
    let status = if !changed.is_empty() {
        "refresh-required"
    } else if authorized {
        "ready"
    } else {
        "read-only"
    };
    let recovery = match status {
        "refresh-required" => json!(
            "Do not retry mutations on this attachment. Start or resume a turn in the active Cantrip chat to refresh it."
        ),
        "read-only" => json!(
            "This attachment is read-only. Select a write-capable permission profile and start a new turn to enable mutations."
        ),
        _ => Value::Null,
    };
    json!({"status":status,"mutationReady":status=="ready","staleClaims":changed,"recoveryInstruction":recovery,"expiresAt":binding["expiresAt"]})
}
