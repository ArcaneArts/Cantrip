use super::*;
pub(super) fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Interaction string")?
        .lossy()
        .into_owned())
}
pub(super) fn optional_text(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        Ok(None)
    } else {
        text(value).map(Some)
    }
}
pub(super) fn parse(schema: &str, value: &Value) -> Result<Value> {
    crate::settings::parse_response(schema, Some(value))
}
pub(super) fn iso(value: &Value) -> Result<Value> {
    if value.is_null() {
        return Ok(Value::Null);
    }
    let ms = value
        .as_js_string()
        .and_then(crate::wire::date_milliseconds)
        .context("Invalid time value")?;
    Ok(json!(
        crate::wire::date_iso_milliseconds(ms).context("Invalid time value")?
    ))
}
pub(super) fn map(row: &Value) -> Result<Value> {
    let mut provenance = json!({"chatId":row["chat_id"],"threadId":row["thread_id"],"turnId":row["turn_id"],"itemId":row["item_id"],"executionLaneId":row["execution_lane_id"],"workerId":row["worker_id"]});
    if row["interaction_owner"] == "computer-use" {
        provenance["owner"] = json!("computer-use");
    }
    let mut result = json!({"id":row["id"],"requestKey":row["request_key"],"projectId":row["project_id"],"provenance":provenance,"status":row["status"],"resolvedByUserId":row["resolved_by_user_id"],"expiresAt":iso(&row["expires_at"])?,"resolvedAt":iso(&row["resolved_at"])?,"createdAt":iso(&row["created_at"])?,"updatedAt":iso(&row["updated_at"])?});
    let protected = truthy(row.get("protected_payload"));
    if protected {
        if truthy(row.get("payload")) || truthy(row.get("response")) {
            anyhow::bail!("An interaction row mixes visible and protected data.");
        }
        result["classification"] = json!({"kind":row["kind"]});
        result["protectedPayload"] = row["protected_payload"].clone();
        result["protectedResponse"] = row["protected_response"].clone();
    } else {
        if !truthy(row.get("payload")) || truthy(row.get("protected_response")) {
            anyhow::bail!("An interaction row has incomplete protected data.");
        }
        result["payload"] = row["payload"].clone();
        result["response"] = row["response"].clone();
    }
    parse(
        if protected {
            "encryptedAgentInteractionRequestSchema"
        } else {
            "agentInteractionRequestSchema"
        },
        &result,
    )
}
pub(super) fn map_as(row: &Value, protected: bool) -> Result<Value> {
    parse(
        if protected {
            "encryptedAgentInteractionRequestSchema"
        } else {
            "agentInteractionRequestSchema"
        },
        &map(row)?,
    )
}
