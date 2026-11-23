use super::*;
pub(super) fn job(row: &Value) -> Result<Value> {
    let mut v = Value::object(
        [
            ("id", "id"),
            ("projectId", "project_id"),
            ("chatId", "chat_id"),
            ("state", "state"),
            ("stateRevision", "state_revision"),
            ("idempotencyKey", "idempotency_key"),
            ("sourcePlacement", "source_placement"),
            ("sourcePlacementRevision", "source_placement_revision"),
            ("targetPlacement", "target_placement"),
            ("targetRuntimeThreadId", "target_runtime_thread_id"),
            ("targetModelRouteId", "target_model_route_id"),
            ("targetProviderAccountId", "target_provider_account_id"),
            ("attempt", "attempt"),
            ("progress", "progress"),
        ]
        .into_iter()
        .map(|(k, f)| (k, row[f].clone())),
    );
    v["contextSnapshotId"] = row["id"].clone();
    v["error"] = if crate::wire::coercion::truthy(row.get("last_error_code")) {
        json!({"code":row["last_error_code"],"retryable":row.get("error_retryable").filter(|v|!v.is_null()).cloned().unwrap_or(json!(false))})
    } else {
        Value::Null
    };
    for (k, f) in [
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("startedAt", "started_at"),
        ("cancellationUnsafeAt", "cancellation_unsafe_at"),
        ("completedAt", "completed_at"),
    ] {
        v[k] = date(&row[f])?;
    }
    crate::settings::parse_response("chatRelocationJobSummarySchema", Some(&v))
}
pub(super) fn snapshot(row: &Value) -> Result<Value> {
    let mut v = Value::object(
        [
            ("id", "id"),
            ("chatId", "chat_id"),
            ("sourcePlacement", "source_placement"),
            ("throughSequence", "through_sequence"),
            ("transcriptSha256", "transcript_sha256"),
            ("messageCount", "message_count"),
            ("attachmentCount", "attachment_count"),
            ("modelId", "model_id"),
            ("modelRouteId", "model_route_id"),
            ("permissionProfileId", "permission_profile_id"),
            ("requiredRevision", "required_revision"),
        ]
        .into_iter()
        .map(|(k, f)| (k, row[f].clone())),
    );
    v["createdAt"] = date(&row["created_at"])?;
    Ok(
        json!({"summary":crate::settings::parse_response("chatRelocationSnapshotSummarySchema",Some(&v))?,"payload":crate::settings::parse_response("chatRelocationContextPayloadSchema",Some(&row["payload"]))?}),
    )
}
pub(super) fn chat(row: &Value) -> Result<Value> {
    let mut v = Value::object(
        [
            ("id", "id"),
            ("projectId", "project_id"),
            ("titleProtection", "protected_label"),
            ("experience", "experience"),
            ("position", "position"),
            ("status", "status"),
            ("activeWorkerId", "active_worker_id"),
            ("activeWorktreeId", "active_worktree_id"),
            ("placementRevision", "placement_revision"),
            ("worktreeMode", "worktree_mode"),
            ("modelId", "model_id"),
            ("reasoningEffort", "reasoning_effort"),
            ("permissionProfileId", "permission_profile_id"),
            ("planMode", "plan_mode"),
            ("hasPendingPlanQuestion", "has_pending_plan_question"),
            ("automationPaused", "automation_paused"),
        ]
        .into_iter()
        .map(|(k, f)| (k, row[f].clone())),
    );
    v["createdAt"] = date(&row["created_at"])?;
    v["updatedAt"] = date(&row["updated_at"])?;
    crate::settings::parse_response("chatWireSummarySchema", Some(&v))
}
