//! A Resume receives fresh physical authority; its original encrypted input and
//! native checkpoint source remain immutable on the canonical round.
use super::*;
use crate::native_commands::suspension;

pub(crate) fn physical(state: &Value) -> &Value {
    if state["resumption"].is_null() {
        state
    } else {
        &state["resumption"]
    }
}
pub(crate) fn checkpoint_execution(state: &Value) -> &Value {
    let resumed = &state["resumption"];
    if !resumed["nativeExecution"].is_null() && !resumed["nativeOwner"].is_null() {
        resumed
    } else if !resumed["checkpointOwner"].is_null() {
        &resumed["checkpointOwner"]
    } else {
        state
    }
}
fn stale<T>() -> Result<T> {
    Err(crate::task_dispatch::Conflict::stale().into())
}

pub(crate) fn goal_receipt(cycle: &Value, operation: Option<&Value>) -> Value {
    let restored = &cycle["goal_cycle_recovery"]["suspension"]["restoration"]["receipt"];
    if !restored.is_null()
        && operation.is_none_or(|operation| restored["operationId"] == *operation)
    {
        restored.clone()
    } else {
        physical(&cycle["goal_input"])["receipt"].clone()
    }
}

/// A view of a real restoration command, never another persisted logical input.
pub(crate) fn goal_execution(cycle: &Value, receipt: &Value) -> Value {
    let source = &cycle["goal_cycle_recovery"]["suspension"];
    if receipt["operationId"].is_null()
        || source["restoration"]["receipt"]["operationId"] != receipt["operationId"]
    {
        return cycle["goal_input"].clone();
    }
    if source["source"]["parent"] != cycle["goal_input"]["receipt"] {
        return Value::Null;
    }
    let mut state = cycle["goal_input"].clone();
    state["publication"] = source["source"]["publication"].clone();
    state["nativeExecution"] = json!({"threadId":source["source"]["threadId"],"turnId":source["source"]["turnId"],"scopeId":source["source"]["cycle"]["scopeId"]});
    state["nativeOwner"] = json!({"workerGeneration":source["source"]["workerGeneration"],"runtimeGeneration":source["source"]["runtimeGeneration"]});
    state["resumption"] = source["restoration"].clone();
    state["terminal"] = source["terminal"].clone();
    state["routeChange"] = Value::Null;
    state
}

pub(crate) async fn save_goal_execution(
    tx: &Transaction<'_>,
    cycle: &Value,
    receipt: &Value,
    state: &Value,
) -> Result<()> {
    if cycle["goal_cycle_recovery"]["suspension"]["restoration"]["receipt"]["operationId"]
        != receipt["operationId"]
    {
        return goal_inference_inputs::write(tx, &text(&cycle["id"])?, state).await;
    }
    let mut marker = cycle["goal_cycle_recovery"].clone();
    if marker["suspension"]["source"]["parent"] != cycle["goal_input"]["receipt"]
        || state["resumption"].is_null()
    {
        return stale();
    }
    marker["suspension"]["restoration"] = state["resumption"].clone();
    if !state["terminal"].is_null() {
        marker["suspension"]["terminal"] = state["terminal"].clone();
    }
    tx.query(
        "UPDATE task_dispatch_cycles SET goal_cycle_recovery=$2::text::jsonb WHERE id=$1",
        &[&text(&cycle["id"])?, &marker.stringify()],
    )
    .await?;
    Ok(())
}

impl Repository {
    pub async fn restored_execution_context(
        &self,
        owner: &str,
        restore: &Value,
        lease: &Value,
    ) -> Result<Value> {
        let (owner, restore, lease) = (owner.to_owned(), restore.clone(), lease.clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let original = parse("taskInferenceInputReceiptSchema", &restore["source"])?;
                    let chat = text(&original["chatId"])?;
                    dispatch_fence::assert(
                        tx,
                        &owner,
                        &chat,
                        &text(&original["dispatch"]["operationId"])?,
                        &json!({"kind":"leased","lease":lease}),
                        false,
                    )
                    .await?;
                    if original["kind"] == "goal" {
                        goal_inference_inputs::context(tx, &owner, &original, true, false).await?;
                    } else {
                        inference_inputs::context(tx, &owner, &original).await?;
                    }
                    let row = suspension::chat(tx, &owner, &chat).await?;
                    let state = suspension::read(&row)?.context("Task suspension missing")?;
                    if state["controlId"] != restore["controlId"]
                        || state["phase"] != "resuming"
                        || state["action"] != "resume"
                        || state["checkpoint"] != restore["checkpoint"]
                    {
                        return stale();
                    }
                    let context = crate::native_commands::context::execution(tx, &owner, &chat)
                        .await?
                        .context("Task source missing")?;
                    let source = crate::chats::native_task_suspension::source(tx, &context)
                        .await?
                        .context("Task source missing")?;
                    if source.receipt != original || source.goal_cycle != restore["goalCycle"]
                        || !crate::native_commands::task_suspension::matches_source(
                            &state, &row, &source,
                        )
                    {
                        return stale();
                    }
                    if !source.goal_cycle.is_null()
                        && tx.query("UPDATE chat_execution_lanes SET state='active',updated_at=now() WHERE id=$1 AND chat_id=$2 AND worker_id=$3 AND worktree_id=$4 AND activated_at=$5::text::timestamptz AND state IN ('idle','suspended','active') RETURNING id",
                            &[&text(&original["executionLaneId"])?,&chat,&text(&original["workerId"])?,&text(&original["worktreeId"])?,&text(&original["executionLaneActivatedAt"])?]).await?.is_empty() { return stale(); }
                    Ok(source.context)
                })
            })
            .await
    }
    pub async fn goal_restoration_source(
        &self,
        owner: &str,
        restore: &Value,
        lease: &Value,
    ) -> Result<Value> {
        let (owner, restore, lease) = (owner.to_owned(), restore.clone(), lease.clone());
        self.database.transaction(|tx| Box::pin(async move {
            let original = parse("taskInferenceInputReceiptSchema", &restore["source"])?;
            if original["kind"] != "goal" { return stale(); }
            let chat = text(&original["chatId"])?;
            dispatch_fence::assert(tx, &owner, &chat, &text(&original["dispatch"]["operationId"])?,
                &json!({"kind":"leased","lease":lease}), false).await?;
            let row = goal_inference_inputs::context(tx, &owner, &original, true, false).await?;
            let cycle = goal_inference_inputs::cycle(tx, &owner, &chat, Some(&text(&lease["cycleId"])?)).await?
                .ok_or_else(crate::task_dispatch::Conflict::stale)?;
            let input = &cycle["goal_input"];
            let current = suspension::chat(tx, &owner, &chat).await?;
            let saved = suspension::read(&current)?.context("Task suspension missing")?;
            let context = crate::native_commands::context::execution(tx, &owner, &chat).await?.context("Task source missing")?;
            let source = crate::chats::native_task_suspension::source(tx, &context).await?.context("Task source missing")?;
            let cycle_restore = !restore["goalCycle"].is_null();
            if input["receipt"] != original || (if cycle_restore { source.goal_cycle != restore["goalCycle"] || !cycle["goal_cycle_recovery"]["suspension"]["terminal"].is_null() }
                else { input["publication"].is_null() || !input["terminal"].is_null() }) ||
                saved["controlId"] != restore["controlId"] || saved["phase"] != "resuming" || saved["action"] != "resume" ||
                saved["checkpoint"] != restore["checkpoint"] || source.receipt != original ||
                !crate::native_commands::task_suspension::matches_source(&saved, &current, &source) { return stale(); }
            let message = goal_inference_inputs::opaque_prompt(&row["message"])?;
            Ok(json!({"message":message,"publication":if cycle_restore {source.goal_cycle["publication"].clone()} else {input["publication"].clone()}}))
        })).await
    }
    pub async fn prepare_resumption_input(&self, owner: &str, input: &Value) -> Result<Value> {
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database.transaction(|tx| Box::pin(async move {
            let original = parse("taskInferenceInputReceiptSchema", &input["resumption"]["source"])?;
            let goal = original["kind"] == "goal";
            if !original["kind"].is_null() && !goal {return stale();}
            let (chat, operation) = (text(&original["chatId"])?, text(&original["dispatch"]["operationId"])?);
            dispatch_fence::assert(tx, &owner, &chat, &operation,
                &json!({"kind":"leased","lease":input["lease"]}), false).await?;
            let row = if goal {goal_inference_inputs::context(tx, &owner, &original, true, false).await?}
                else {inference_inputs::context(tx, &owner, &original).await?};
            let cycle = if goal {goal_inference_inputs::cycle(tx, &owner, &chat, Some(&text(&input["lease"]["cycleId"])?)).await?} else {None};
            let state = if goal {&cycle.as_ref().ok_or_else(crate::task_dispatch::Conflict::stale)?["goal_input"]}
                else {&row["round"]["inference_input"]};
            let checkpoint_owner = checkpoint_execution(state);
            let current = suspension::chat(tx, &owner, &chat).await?;
            let Some(saved) = suspension::read(&current)? else {return stale();};
            if goal && !input["resumption"]["goalCycle"].is_null() {
                let cycle = cycle.as_ref().ok_or_else(crate::task_dispatch::Conflict::stale)?;
                let context = crate::native_commands::context::execution(tx, &owner, &chat).await?.context("Goal source missing")?;
                let source = crate::chats::native_task_suspension::source(tx, &context).await?.context("Goal source missing")?;
                let actor = json!({"operationId":source.execution_receipt["operationId"],"operationGeneration":source.execution_receipt["operationId"],
                    "workerGeneration":source.native_owner["workerGeneration"],"runtimeGeneration":source.native_owner["runtimeGeneration"]});
                if source.receipt != original || source.goal_cycle != input["resumption"]["goalCycle"] || source.goal_cycle.is_null() ||
                    !crate::native_commands::task_suspension::matches_source(&saved,&current,&source) ||
                    saved["phase"] != "resuming" || saved["action"] != "resume" || saved["controlId"] != input["resumption"]["controlId"] ||
                    saved["checkpoint"] != input["resumption"]["checkpoint"] || saved["actor"] != actor ||
                    saved["active"]["threadId"] != source.native_execution["threadId"] || saved["active"]["turnId"] != source.native_execution["turnId"] ||
                    row["project"]["task_scheduling_paused"] == true || input.get("expectedInputRevision").is_some_and(|revision| !revision.is_null() && row["chat"]["managed_input_revision"] != *revision) { return stale(); }
                let dispatch = Value::object(["cycleId","operationId","leaseOwner","fencingToken"].map(|key|(key,input["lease"][key].clone())));
                let mut marker = cycle["goal_cycle_recovery"].clone();
                if marker["suspension"]["restoration"]["controlId"] == saved["controlId"] && marker["suspension"]["restoration"]["receipt"]["dispatch"] == dispatch {
                    return Ok(marker["suspension"]["restoration"]["receipt"].clone());
                }
                let mut receipt = original; receipt["operationId"] = json!(uuid::Uuid::new_v4().to_string()); receipt["dispatch"] = dispatch;
                receipt["modelRouteId"] = source.goal_cycle["cycle"]["modelRouteId"].clone(); receipt["providerAccountId"] = source.goal_cycle["cycle"]["providerAccountId"].clone(); receipt["providerId"] = marker["providerId"].clone();
                let receipt = parse("taskInferenceInputReceiptSchema", &receipt)?;
                marker["suspension"]["restoration"] = json!({"controlId":saved["controlId"],"receipt":receipt,"accepted":false,"dispatched":false,
                    "checkpointActor":actor,"checkpointExecution":source.native_execution});
                tx.query("UPDATE task_dispatch_cycles SET goal_cycle_recovery=$2::text::jsonb WHERE id=$1", &[&text(&cycle["id"])?,&marker.stringify()]).await?;
                return Ok(receipt);
            }
            if state.is_null() || state["receipt"] != original || state["nativeExecution"].is_null() || state["nativeOwner"].is_null() ||
                checkpoint_owner["nativeExecution"].is_null() || checkpoint_owner["nativeOwner"].is_null() || !state["terminal"].is_null() ||
                state["accepted"] != true || state["dispatched"] != true || (goal && state["publication"].is_null()) || row["project"]["task_scheduling_paused"] == true ||
                input.get("expectedInputRevision").is_some_and(|revision| !revision.is_null() && row["chat"]["managed_input_revision"] != *revision) ||
                saved["phase"] != "resuming" || saved["action"] != "resume" || saved["controlId"] != input["resumption"]["controlId"] ||
                saved["checkpoint"] != input["resumption"]["checkpoint"] ||
                saved["target"]["taskRound"]["inputOperationId"] != original["operationId"] ||
                saved["target"]["taskRound"]["operationId"] != original["dispatch"]["operationId"] ||
                saved["target"]["taskRound"]["cycleId"] != input["lease"]["cycleId"] ||
                saved["active"]["threadId"] != state["nativeExecution"]["threadId"] || saved["active"]["turnId"] != state["nativeExecution"]["turnId"] ||
                saved["actor"]["operationId"] != checkpoint_owner["receipt"]["operationId"] ||
                saved["actor"]["operationGeneration"] != checkpoint_owner["receipt"]["operationId"] ||
                saved["actor"]["workerGeneration"] != checkpoint_owner["nativeOwner"]["workerGeneration"] ||
                saved["actor"]["runtimeGeneration"] != checkpoint_owner["nativeOwner"]["runtimeGeneration"] {return stale();}
            let dispatch = Value::object(["cycleId","operationId","leaseOwner","fencingToken"].map(|key|(key,input["lease"][key].clone())));
            if state["resumption"]["controlId"] == saved["controlId"] && state["resumption"]["receipt"]["dispatch"] == dispatch {
                return Ok(state["resumption"]["receipt"].clone());
            }
            let mut receipt = original;
            receipt["operationId"] = json!(uuid::Uuid::new_v4().to_string()); receipt["dispatch"] = dispatch;
            let receipt = parse("taskInferenceInputReceiptSchema", &receipt)?;
            let mut state = state.clone();
            state["resumption"] = json!({"controlId":saved["controlId"],"receipt":receipt,"accepted":false,"dispatched":false,
                "checkpointOwner":json!({"receipt":checkpoint_owner["receipt"],"nativeExecution":checkpoint_owner["nativeExecution"],"nativeOwner":checkpoint_owner["nativeOwner"]})});
            if goal {goal_inference_inputs::write(tx, &text(&input["lease"]["cycleId"])?, &state).await?;}
            else {update(tx, Table::Round, &operation, &json!({"inference_input":state}), None).await?;}
            Ok(receipt)
        })).await
    }
}
