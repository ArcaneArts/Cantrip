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
    let (round, task, state, goal_source) = if let Some(row) = rows.first() {
        let round: Value = serde_json::from_str(&row.get::<String>(0)?)?;
        let task: Value = serde_json::from_str(&row.get::<String>(1)?)?;
        let state = round["inference_input"].clone();
        (round, task, state, false)
    } else {
        let rows = tx.query("SELECT to_jsonb(r)::text,to_jsonb(t)::text,to_jsonb(c)::text FROM task_dispatch_cycles c INNER JOIN tasks t ON t.chat_id=c.chat_id AND t.active_operation_id IS NULL INNER JOIN task_planning_rounds r ON r.id=c.operation_id AND r.chat_id=c.chat_id WHERE c.chat_id=$1 ORDER BY c.created_at DESC,c.id DESC LIMIT 1", &[&chat]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let round: Value = serde_json::from_str(&row.get::<String>(0)?)?;
        let task: Value = serde_json::from_str(&row.get::<String>(1)?)?;
        let cycle: Value = serde_json::from_str(&row.get::<String>(2)?)?;
        let state = cycle["goal_input"].clone();
        if task["plan_goal_enabled"] != true
            || task["implementation_started_at"].is_null()
            || round["kind"] != "finalize"
            || task["planning_round"] != round["ordinal"]
            || round["relay_result"]["goal"].is_null()
            || cycle["operation_kind"] != "finalize"
            || state["receipt"]["kind"] != "goal"
        {
            return Ok(None);
        }
        let message = state["receipt"]["clientMessageId"]
            .as_str()
            .context("Goal input message")?;
        if tx.query("SELECT id FROM chat_messages WHERE id=$1 AND chat_id=$2 AND mode='goal' AND role IN ('system','user') AND task_protected_content IS NOT NULL", &[&message,&chat]).await?.is_empty() {return Ok(None);}
        (round, task, state, true)
    };
    if (!goal_source && round["status"] != "running")
        || matches!(task["state"].as_str(), Some("complete" | "failed"))
        || state["accepted"] != true
        || state["dispatched"] != true
        || state["deferred"] == true
        || state["failedBeforeDispatch"] == true
        || !state["terminal"].is_null()
        || state["nativeExecution"].is_null()
        || state["nativeOwner"].is_null()
        || (state["receipt"]["kind"] == "goal") != goal_source
    {
        return Ok(None);
    }
    let receipt = parse_response("taskInferenceInputReceiptSchema", Some(&state["receipt"]))?;
    let physical = crate::tasks::resumption::checkpoint_execution(&state);
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
        || (!goal_source && receipt["clientMessageId"] != round["user_message_id"])
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
        current_receipt: crate::tasks::resumption::physical(&state)["receipt"].clone(),
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
