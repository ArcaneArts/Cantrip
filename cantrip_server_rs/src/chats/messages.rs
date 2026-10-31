//! Stored message metadata is mapped without opening its encrypted envelope.
use crate::wire::{Value, coercion::truthy, value::json};
use anyhow::{Result, bail};

pub(super) fn opaque(raw: &Value) -> Result<Value> {
    if !truthy(raw.get("protected_content"))
        || truthy(raw.get("content"))
        || truthy(raw.get("task_protected_content"))
    {
        bail!("Visible or Task messages require a different mapper.");
    }
    let mut summary = Value::object([
        (
            "contextKind",
            json!(if truthy(raw.get("scratch_root_id")) {
                "standalone"
            } else {
                "project"
            }),
        ),
        ("createdAt", super::catalog::iso(&raw["created_at"])?),
    ]);
    for (target, source) in [
        ("id", "id"),
        ("chatId", "chat_id"),
        ("worktreeId", "worktree_id"),
        ("scratchRootId", "scratch_root_id"),
        ("executionLaneId", "execution_lane_id"),
        ("sequence", "sequence"),
        ("role", "role"),
        ("mode", "mode"),
        ("attachmentIds", "attachment_ids"),
        ("protectedContent", "protected_content"),
        ("modelId", "model_id"),
        ("modelRouteId", "model_route_id"),
        ("providerId", "provider_id"),
        ("providerName", "provider_name"),
        ("providerModelName", "provider_model_name"),
        ("reasoningEffort", "reasoning_effort"),
        ("appliedReasoningEffort", "applied_reasoning_effort"),
        ("reasoningAdjusted", "reasoning_adjusted"),
        ("idempotencyKey", "idempotency_key"),
    ] {
        summary[target] = raw[source].clone();
    }
    crate::settings::parse_response("chatMessageOpaqueSummarySchema", Some(&summary))
}

pub(super) fn task(raw: &Value) -> Result<Value> {
    if !truthy(raw.get("task_protected_content")) || truthy(raw.get("content")) {
        bail!("Visible chat messages require the plaintext mapper.");
    }
    if !truthy(raw.get("worktree_id")) || truthy(raw.get("scratch_root_id")) {
        bail!("Task messages require a project worktree.");
    }
    let mut summary = common(raw)?;
    summary["attachmentIds"] = raw["task_attachment_ids"].clone();
    summary["protectedContent"] = raw["task_protected_content"].clone();
    summary["idempotencyKey"] = raw["idempotency_key"].clone();
    crate::settings::parse_response("taskMessageOpaqueSummarySchema", Some(&summary))
}

pub(super) fn plain(raw: &Value) -> Result<Value> {
    if !truthy(raw.get("content")) || truthy(raw.get("task_protected_content")) {
        bail!("Encrypted Task messages require the opaque mapper.");
    }
    let mut summary = common(raw)?;
    summary["contextKind"] = json!(if truthy(raw.get("scratch_root_id")) {
        "standalone"
    } else {
        "project"
    });
    summary["scratchRootId"] = raw["scratch_root_id"].clone();
    summary["content"] = raw["content"].clone();
    Ok(summary)
}

fn common(raw: &Value) -> Result<Value> {
    let mut summary = Value::object([("createdAt", super::catalog::iso(&raw["created_at"])?)]);
    for (target, source) in [
        ("id", "id"),
        ("chatId", "chat_id"),
        ("worktreeId", "worktree_id"),
        ("executionLaneId", "execution_lane_id"),
        ("sequence", "sequence"),
        ("role", "role"),
        ("mode", "mode"),
        ("modelId", "model_id"),
        ("modelRouteId", "model_route_id"),
        ("providerId", "provider_id"),
        ("providerName", "provider_name"),
        ("providerModelName", "provider_model_name"),
        ("reasoningEffort", "reasoning_effort"),
        ("appliedReasoningEffort", "applied_reasoning_effort"),
        ("reasoningAdjusted", "reasoning_adjusted"),
    ] {
        summary[target] = raw[source].clone();
    }
    Ok(summary)
}
