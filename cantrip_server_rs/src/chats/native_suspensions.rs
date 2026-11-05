//! Public projection never exposes checkpoint storage, source, or runtime ownership.
use crate::{
    settings::parse_response,
    wire::{Value, value::json},
};
use anyhow::Result;

impl super::Repository {
    /// Strict recovery reads retain unsupported bytes rather than resetting state.
    pub async fn native_suspension(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        let rows = self
            .database
            .query(
                "SELECT native_suspension_state::text FROM chats WHERE owner_id=$1 AND id=$2",
                &[&owner, &chat],
            )
            .await?;
        let row = rows.first().ok_or_else(|| {
            super::guard::NativeCommandError::new("chat-not-found", Some("Chat not found."), 404)
        })?;
        let Some(raw) = row.get::<Option<String>>(0)? else {
            return Ok(None);
        };
        let parsed: Value = serde_json::from_str(&raw)?;
        parse_response("nativeSuspensionRecordSchema", Some(&parsed))
            .map(Some)
            .map_err(|_| {
                super::guard::NativeCommandError::new("suspension-state-unreadable", None, 409)
                    .into()
            })
    }
}

pub fn stored_summary(raw: &Value) -> Value {
    let Ok(record) = parse_response("nativeSuspensionRecordSchema", Some(raw)) else {
        return json!({"controlId":Value::Null,"action":Value::Null,"phase":"error","resumable":false,"active":Value::Null,"updatedAt":Value::Null,
            "pausedAt":Value::Null,"pausedMilliseconds":0,
            "error":json!({"code":"suspension-state-unreadable","protectedDetails":Value::Null})});
    };
    let mut summary = Value::object(
        [
            "controlId",
            "action",
            "phase",
            "active",
            "updatedAt",
            "pausedAt",
            "pausedMilliseconds",
            "error",
        ]
        .map(|key| (key, record[key].clone())),
    );
    summary["resumable"] = json!(
        record["action"] != "stop"
            && !record["checkpoint"].is_null()
            && (record["phase"] == "paused"
                || (record["phase"] == "error" && record["action"] == "resume"))
    );
    summary
}
