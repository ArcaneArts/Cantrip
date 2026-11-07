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
                    if source.receipt != original
                        || !crate::native_commands::task_suspension::matches_source(
                            &state, &row, &source,
                        )
                    {
                        return stale();
                    }
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
            if input["receipt"] != original || input["publication"].is_null() || !input["terminal"].is_null() ||
                saved["controlId"] != restore["controlId"] || saved["phase"] != "resuming" || saved["action"] != "resume" ||
                saved["checkpoint"] != restore["checkpoint"] || source.receipt != original ||
                !crate::native_commands::task_suspension::matches_source(&saved, &current, &source) { return stale(); }
            let m = &row["message"];
            let message = parse("taskMessageOpaqueContentSchema", &json!({"id":m["id"],
                "classification":json!({"role":m["role"],"mode":m["mode"],"attachmentIds":m["task_attachment_ids"]}),
                "protectedContent":m["task_protected_content"],"reasoningEffort":m["reasoning_effort"],"idempotencyKey":m["idempotency_key"]}))?;
            Ok(json!({"message":message,"publication":input["publication"]}))
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
