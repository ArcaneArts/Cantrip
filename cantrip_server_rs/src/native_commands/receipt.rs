use crate::wire::{self, Value, coercion::truthy, value::json};
use anyhow::{Context, Result};

pub(super) fn iso(value: &Value) -> Result<Value> {
    let millis = value
        .as_js_string()
        .and_then(wire::date_milliseconds)
        .context("Invalid time value")?;
    Ok(json!(
        wire::date_iso_milliseconds(millis).context("Invalid time value")?
    ))
}
/// Map the stored row without opening its protected payload or result.
pub fn from_row(row: &Value) -> Result<Value> {
    let mut receipt = json!({"startsExecution":row["kind"]=="start"});
    for (target, column) in [
        ("chatId", "chat_id"),
        ("operationId", "operation_id"),
        ("operationGeneration", "operation_generation"),
        ("logicalOperationId", "logical_operation_id"),
        ("previousOperationId", "previous_operation_id"),
        ("activationGeneration", "activation_generation"),
        ("executionLaneId", "execution_lane_id"),
        ("status", "status"),
        ("method", "method"),
        ("payloadDigest", "payload_digest"),
        ("rejectionCode", "rejection_code"),
    ] {
        if let Some(value) = row.get(column) {
            receipt[target] = value.clone();
        }
    }
    if truthy(row.get("settings_application")) {
        receipt["settingsApplication"] = row["settings_application"].clone();
    }
    if let Some(thread) = wire::property(row.get("identity"), "threadId")? {
        receipt["threadId"] = thread.clone();
    }
    receipt["createdAt"] = iso(&row["created_at"])?;
    receipt["updatedAt"] = iso(&row["updated_at"])?;
    crate::settings::parse_response("nativeCommandReceiptSchema", Some(&receipt))
}
