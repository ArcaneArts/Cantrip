//! Immutable Goal setters may retain only their exact first-cycle claim across
//! a settled provider transfer that still owns the canonical settings binding.
use super::{admit::text, managed_queue::deep_equal};
use crate::{
    database::Transaction,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::Result;

pub(crate) fn identity(claim: &Value) -> Option<Value> {
    if claim["awaiting_goal"] != true
        || !truthy(claim.get("operation_id"))
        || !truthy(claim.get("operation_generation"))
        || !truthy(claim.get("goal_epoch"))
    {
        return None;
    }
    Some(
        json!({"id":claim["id"],"promptId":claim["prompt_id"],"promptRevision":claim["prompt_revision"],
        "operationId":claim["operation_id"],"operationGeneration":claim["operation_generation"],"goalEpoch":claim["goal_epoch"]}),
    )
}

fn normalized(session: &Value, route: bool) -> Value {
    let mut value = session.clone();
    value["runtimeGeneration"] = Value::Null;
    value["connectionId"] = Value::Null;
    if !route {
        value["modelRouteId"] = Value::Null;
        value["providerAccountId"] = Value::Null;
    }
    value
}

pub(crate) async fn session_matches(
    tx: &Transaction<'_>,
    owner: &str,
    worker: &str,
    claim: &Value,
    parent: &Value,
    current: &Value,
) -> Result<bool> {
    if deep_equal(&normalized(parent, true), &normalized(current, true)) {
        return Ok(true);
    }
    if !deep_equal(&normalized(parent, false), &normalized(current, false)) {
        return Ok(false);
    }
    let Some(identity) = identity(claim) else {
        return Ok(false);
    };
    let chat = text(&current["chatId"])?;
    let rows = tx
        .query(
            "SELECT state::text FROM native_settings_states WHERE chat_id=$1",
            &[&chat],
        )
        .await?;
    let Some(row) = rows.first() else {
        return Ok(false);
    };
    let state: Value = serde_json::from_str(&row.get::<String>(0)?)?;
    let binding = &state["binding"];
    if binding["workerId"] != worker
        || [
            "chatId",
            "threadId",
            "runtimeGeneration",
            "modelRouteId",
            "providerAccountId",
            "contextKind",
            "projectId",
            "placementId",
        ]
        .iter()
        .any(|key| binding.get(key) != current.get(key))
    {
        return Ok(false);
    }
    Ok(!tx.query("SELECT operation_id FROM native_runtime_handoffs WHERE owner_id=$1 AND worker_id=$2 AND chat_id=$3 AND phase IN ('completed','cancelled') AND queued_source->>'withdrawn'='true' AND queued_source->'goalClaim'=$4::jsonb AND binding=$5::jsonb LIMIT 1", &[&owner,&worker,&chat,&serde_json::to_string(&identity)?,&serde_json::to_string(binding)?]).await?.is_empty())
}
