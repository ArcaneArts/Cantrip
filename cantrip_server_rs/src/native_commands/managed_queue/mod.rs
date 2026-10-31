//! The canonical executable queue retains encrypted input and immutable receipts.
mod authority;
mod claims;
mod delivery;
mod imports;
mod mutation;
mod replay;
mod snapshot;
use super::{
    admit::{raw_one, reject, text},
    settings_persistence::parse,
    transaction::TransactionRepository,
};
use crate::{
    database::{Database, Transaction},
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::Result;
pub(super) use mutation::mutate as mutate_in_transaction;
use sha2::{Digest, Sha256};
use std::sync::Arc;
#[derive(Clone)]
pub struct QueueRepository {
    database: Arc<Database>,
}
impl QueueRepository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
}
pub(super) fn digest(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub(super) fn spread(value: &Value) -> Value {
    match value {
        Value::Object(_) => value.clone(),
        Value::Array(items) => Value::object(
            items
                .iter()
                .enumerate()
                .map(|(i, v)| (i.to_string(), v.clone())),
        ),
        Value::String(s) => Value::object(s.units().iter().enumerate().map(|(i, u)| {
            (
                i.to_string(),
                Value::String(crate::wire::JsString::new(vec![*u])),
            )
        })),
        _ => Value::object([] as [(&str, Value); 0]),
    }
}
pub(super) fn normalized(value: &Value, fields: &[&str]) -> Value {
    let mut result = spread(value);
    for field in fields {
        result[*field] = Value::Null;
    }
    result
}
// Node's isDeepStrictEqual distinguishes negative zero, unlike JavaScript ===.
pub(super) fn deep_equal(left: &Value, right: &Value) -> bool {
    let mut pending = vec![(left, right)];
    while let Some((left, right)) = pending.pop() {
        match (left, right) {
            (Value::Number(a), Value::Number(b)) => {
                if !(a.is_nan() && b.is_nan())
                    && (*a != *b || (*a == 0.0 && a.is_sign_negative() != b.is_sign_negative()))
                {
                    return false;
                }
            }
            (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
                pending.extend(a.iter().zip(b))
            }
            (Value::Object(a), Value::Object(b)) if a.len() == b.len() => {
                for (key, value) in a {
                    let Some(other) = b.get(key) else {
                        return false;
                    };
                    pending.push((value, other));
                }
            }
            (a, b) if a == b => (),
            _ => return false,
        }
    }
    true
}
pub(super) const NO_PERMISSION: &str = "NOT EXISTS (SELECT 1 FROM native_settings_states s WHERE s.chat_id=c.id AND (EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(s.state->'pending','[]'::jsonb)) p WHERE p->'intent'->'permissionTransition' IS NOT NULL) OR (s.state->>'desiredStatus'='uncertain' AND s.state->'desired'->'permissionTransition' IS NOT NULL)))";
pub(super) const NO_HANDOFF: &str = "NOT EXISTS (SELECT 1 FROM native_runtime_handoffs h WHERE h.chat_id=c.id AND h.phase IN ('preparing','prepared','committed'))";
pub(super) async fn bump(tx: &Transaction<'_>, chat: &str) -> Result<()> {
    super::queue::changed(tx, chat).await
}
pub(super) fn claim_value(row: &Value) -> Result<Value> {
    let mut result = Value::object([] as [(&str, Value); 0]);
    for (field, column) in [
        ("id", "id"),
        ("chatId", "chat_id"),
        ("promptId", "prompt_id"),
        ("promptRevision", "prompt_revision"),
        ("awaitingGoal", "awaiting_goal"),
        ("goalEpoch", "goal_epoch"),
        ("goalOperationId", "goal_operation_id"),
        ("goalOperationGeneration", "goal_operation_generation"),
        ("requestOperationId", "request_operation_id"),
        ("status", "status"),
        ("operationId", "operation_id"),
        ("operationGeneration", "operation_generation"),
        ("nativeTurnId", "native_turn_id"),
    ] {
        result[field] = row[column].clone();
    }
    result["createdAt"] = super::receipt::iso(&row["created_at"])?;
    parse("managedQueueClaimSchema", &result)
}
pub(crate) async fn retain_input(
    tx: &Transaction<'_>,
    claim: &str,
    prompt: &Value,
) -> Result<Option<Value>> {
    if !truthy(prompt.get("opaque_content")) {
        return Ok(None);
    }
    let input = parse("queuedPromptOpaqueContentSchema", &prompt["opaque_content"])?;
    if input.get("id") != prompt.get("id") {
        return reject("queue-input-snapshot-mismatch");
    }
    let value = json!({"claimId":claim,"promptId":prompt["id"],"promptRevision":prompt["revision"],"protectedInput":input});
    if let Some(row) = raw_one(
        tx,
        "SELECT to_jsonb(s)::text FROM managed_queue_input_snapshots s WHERE claim_id=$1",
        &[&claim],
    )
    .await?
    {
        let existing = json!({"claimId":row["claim_id"],"promptId":row["prompt_id"],"promptRevision":row["prompt_revision"],"protectedInput":row["protected_input"]});
        if existing != value {
            return reject("queue-input-snapshot-conflict");
        }
        return Ok(Some(existing));
    }
    tx.query("INSERT INTO managed_queue_input_snapshots(claim_id,prompt_id,prompt_revision,protected_input) VALUES($1,$2,$3::text::integer,$4::text::jsonb)",&[&claim,&text(&prompt["id"])?,&prompt["revision"].stringify(),&value["protectedInput"].stringify()]).await?;
    Ok(Some(value))
}
