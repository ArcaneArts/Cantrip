//! Immutable Goal setters may retain only their exact first-cycle claim across
//! a settled provider transfer that still owns the canonical settings binding.
use super::{
    admit::{raw_one, text},
    managed_queue::deep_equal,
    settings_persistence::parse,
};
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

async fn recovery_marker_matches(
    tx: &Transaction<'_>,
    owner: &str,
    worker: &str,
    claim: &Value,
    current: &Value,
) -> Result<bool> {
    if truthy(claim.get("native_turn_id"))
        || !matches!(claim["status"].as_str(), Some("dispatched" | "uncertain"))
    {
        return Ok(false);
    }
    let chat = text(&current["chatId"])?;
    let state = raw_one(
        tx,
        "SELECT to_jsonb(s)::text FROM managed_queue_states s WHERE chat_id=$1",
        &[&chat],
    )
    .await?;
    let Some(marker) = state
        .and_then(|s| s.get("goal_recovery").cloned())
        .filter(|m| !m.is_null())
    else {
        return Ok(false);
    };
    let marker = parse("nativeGoalRecoverySchema", &marker)?;
    if marker["source"].get("goalEpoch") != claim.get("goal_epoch")
        || marker["source"].get("threadId") != current.get("threadId")
    {
        return Ok(false);
    }
    let source = raw_one(tx, "SELECT to_jsonb(n)::text FROM native_commands n WHERE owner_id=$1 AND worker_id=$2 AND chat_id=$3 AND operation_id=$4 AND operation_generation=$5", &[
        &owner,&worker,&chat,&text(&marker["source"]["operationId"])?,&text(&marker["source"]["operationGeneration"])?]).await?;
    if source.is_none_or(|s| {
        !truthy(s.get("execution_completed_at"))
            || !deep_equal(&s["goal_recovery_source"], &marker["source"])
    }) {
        return Ok(false);
    }
    if !truthy(marker.get("admission")) {
        return Ok(!truthy(claim.get("goal_operation_id"))
            && !truthy(claim.get("goal_operation_generation")));
    }
    if claim.get("goal_operation_id") != marker["admission"].get("operationId")
        || claim.get("goal_operation_generation") != marker["admission"].get("operationGeneration")
    {
        return Ok(false);
    }
    let child = raw_one(tx, "SELECT to_jsonb(n)::text FROM native_commands n WHERE owner_id=$1 AND worker_id=$2 AND chat_id=$3 AND operation_id=$4 AND operation_generation=$5", &[
        &owner,&worker,&chat,&text(&marker["admission"]["operationId"])?,&text(&marker["admission"]["operationGeneration"])?]).await?;
    Ok(child.is_some_and(|c| {
        c["status"] == "accepted"
            && !truthy(c.get("execution_completed_at"))
            && deep_equal(&c["intent"]["goalRecovery"], &marker["source"])
            && c["intent"]["goalRecoveryOrderEpoch"]
                .as_f64()
                .unwrap_or(0.0)
                == marker["orderEpoch"].as_f64().unwrap_or(0.0)
            && c["intent"].get("workerGeneration") == marker["admission"].get("workerGeneration")
            && c["identity"].get("runtimeGeneration") == current.get("runtimeGeneration")
            && deep_equal(
                &normalized(&c["identity"], true),
                &normalized(current, true),
            )
    }))
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
    if recovery_marker_matches(tx, owner, worker, claim, current).await? {
        return Ok(true);
    }
    Ok(!tx.query("SELECT operation_id FROM native_runtime_handoffs WHERE owner_id=$1 AND worker_id=$2 AND chat_id=$3 AND phase IN ('completed','cancelled') AND queued_source->>'withdrawn'='true' AND queued_source->'goalClaim'=$4::jsonb AND binding=$5::jsonb LIMIT 1", &[&owner,&worker,&chat,&serde_json::to_string(&identity)?,&serde_json::to_string(binding)?]).await?.is_empty())
}
