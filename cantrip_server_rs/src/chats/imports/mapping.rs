use super::*;
pub(super) fn job(row: &Value) -> Result<Value> {
    let mut result = Value::object(
        [
            ("id", "id"),
            ("projectId", "project_id"),
            ("chatId", "chat_id"),
            ("sourceKind", "source_kind"),
            ("sourceWorkerId", "source_worker_id"),
            ("sourceId", "source_id"),
            ("sourceThreadId", "source_thread_id"),
            ("targetPlacement", "target_placement"),
            ("managedThreadId", "managed_thread_id"),
            ("targetModelRouteId", "target_model_route_id"),
            ("targetProviderAccountId", "target_provider_account_id"),
            ("state", "state"),
            ("stateRevision", "state_revision"),
            ("idempotencyKey", "idempotency_key"),
            ("attempt", "attempt"),
            ("progress", "progress"),
            ("sourceMetadata", "source_metadata"),
            ("attachmentCount", "attachment_count"),
            ("attachmentWarningCount", "attachment_warning_count"),
        ]
        .into_iter()
        .map(|(key, column)| (key, row[column].clone())),
    );
    result["error"] = if crate::wire::coercion::truthy(row.get("last_error_code")) {
        json!({"code":row["last_error_code"],"retryable":row.get("error_retryable").filter(|v|!v.is_null()).cloned().unwrap_or(json!(false))})
    } else {
        Value::Null
    };
    for (key, column) in [
        ("createdAt", "created_at"),
        ("updatedAt", "updated_at"),
        ("startedAt", "started_at"),
        ("completedAt", "completed_at"),
    ] {
        result[key] = date(&row[column])?;
    }
    crate::settings::parse_response("chatImportJobSummarySchema", Some(&result))
}
