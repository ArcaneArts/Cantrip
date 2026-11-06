//! Canonical Task ownership, independent of generic chat runtime attachment.
use crate::{
    database::Transaction,
    settings::parse_response,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};

pub(crate) struct Source {
    pub context: Value,
    pub task_round: Value,
    pub receipt: Value,
    pub current_receipt: Value,
    pub execution_receipt: Value,
    pub native_execution: Value,
    pub native_owner: Value,
}

pub(crate) async fn source(tx: &Transaction<'_>, context: &Value) -> Result<Option<Source>> {
    if context["experience"] != "task" || context["contextKind"] != "project" {
        return Ok(None);
    }
    let chat = context["chatId"].as_str().context("Task suspension chat")?;
    let rows = tx.query("SELECT to_jsonb(r)::text,to_jsonb(t)::text FROM task_planning_rounds r INNER JOIN tasks t ON t.chat_id=r.chat_id AND t.active_operation_id=r.id WHERE t.chat_id=$1 LIMIT 1", &[&chat]).await?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let round: Value = serde_json::from_str(&row.get::<String>(0)?)?;
    let task: Value = serde_json::from_str(&row.get::<String>(1)?)?;
    let state = &round["inference_input"];
    if round["status"] != "running"
        || matches!(task["state"].as_str(), Some("complete" | "failed"))
        || state["accepted"] != true
        || state["dispatched"] != true
        || state["deferred"] == true
        || state["failedBeforeDispatch"] == true
        || !state["terminal"].is_null()
        || state["nativeExecution"].is_null()
        || state["nativeOwner"].is_null()
        || !state["receipt"]["kind"].is_null()
    {
        return Ok(None);
    }
    let receipt = parse_response("taskInferenceInputReceiptSchema", Some(&state["receipt"]))?;
    let physical = crate::tasks::resumption::checkpoint_execution(state);
    let native_execution = crate::wire::parse_property(
        "taskInferenceInputDispatchSchema",
        "nativeExecution",
        &physical["nativeExecution"],
    )
    .map_err(crate::settings::response_error)?;
    if ["chatId", "workerId", "worktreeId", "executionLaneId"]
        .iter()
        .any(|key| receipt[*key] != context[*key])
        || receipt["dispatch"]["operationId"] != round["id"]
        || receipt["clientMessageId"] != round["user_message_id"]
    {
        return Ok(None);
    }
    let task_round = json!({"operationId":round["id"],"inputOperationId":receipt["operationId"],"cycleId":receipt["dispatch"]["cycleId"]});
    let mut bound = context.clone();
    bound["threadId"] = native_execution["threadId"].clone();
    bound["modelRouteId"] = receipt["modelRouteId"].clone();
    bound["providerAccountId"] = receipt["providerAccountId"].clone();
    Ok(Some(Source {
        context: bound,
        task_round,
        current_receipt: crate::tasks::resumption::physical(state)["receipt"].clone(),
        execution_receipt: parse_response(
            "taskInferenceInputReceiptSchema",
            Some(&physical["receipt"]),
        )?,
        receipt,
        native_execution,
        native_owner: physical["nativeOwner"].clone(),
    }))
}

pub(crate) fn matches_actor(
    source: &Source,
    target: &Value,
    actor: &Value,
    active: &Value,
) -> bool {
    target["taskRound"] == source.task_round
        && actor["operationId"] == source.execution_receipt["operationId"]
        && actor["operationGeneration"] == source.execution_receipt["operationId"]
        && actor["workerGeneration"] == source.native_owner["workerGeneration"]
        && actor["runtimeGeneration"] == source.native_owner["runtimeGeneration"]
        && active["threadId"] == source.native_execution["threadId"]
        && active["turnId"] == source.native_execution["turnId"]
}
