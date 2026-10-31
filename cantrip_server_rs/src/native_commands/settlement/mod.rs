//! Receipts, queue claims and exact activation retirement commit together.
mod deferred;
mod evidence;
mod persist;
use super::{
    Repository,
    admit::{raw_one, reject, text},
    context, queue, receipt, settings_persistence, turns,
};
use crate::{
    database::{Executor, Transaction},
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::Result;
use futures::FutureExt;
struct Settlement<'a> {
    owner: &'a str,
    input: &'a Value,
    row: Value,
    current: Value,
    terminal: Value,
    missing: bool,
}
fn terminal(input: &Value) -> Value {
    if truthy(input.get("deferred")) {
        return json!({"kind":"deferred","reason":input["deferred"]["reason"],"inputConsumed":false,"threadId":input["deferred"]["threadId"],"runtimeGeneration":input["deferred"]["runtimeGeneration"]});
    }
    for (field, kind) in [("decline", "declined"), ("reconciliation", "terminal")] {
        if let Some(value) = input.get(field).filter(|v| truthy(Some(v))) {
            let mut result = Value::object([("kind", json!(kind))]);
            if let (Value::Object(to), Value::Object(from)) = (&mut result, value) {
                for (key, value) in from {
                    to.insert(key.clone(), value.clone());
                }
            }
            return result;
        }
    }
    Value::Null
}
async fn response(
    tx: &Transaction<'_>,
    owner: &str,
    input: &Value,
    row: &Value,
    chat: &str,
) -> Result<Value> {
    let mut value = receipt::from_row(row)?;
    if truthy(input.get("deferred")) {
        let state = settings_persistence::get(Executor::Transaction(tx), owner, chat).await?;
        let ready = state.as_ref().is_some_and(|s| {
            let pending = s["pending"].as_array().is_some_and(|items| {
                items
                    .iter()
                    .any(|entry| truthy(entry["intent"].get("permissionTransition")))
            });
            let uncertain = truthy(s["desired"].get("permissionTransition"))
                && s["desiredStatus"] == "uncertain";
            !(pending || uncertain)
        });
        value["resumeQueue"] = json!(ready);
    }
    Ok(value)
}
async fn settle(tx: &Transaction<'_>, owner: &str, input: &Value) -> Result<Value> {
    let worker = text(&input["workerId"])?;
    let operation = text(&input["operationId"])?;
    let generation = text(&input["operationGeneration"])?;
    let row = context::read(
        Executor::Transaction(tx),
        owner,
        &worker,
        &operation,
        &generation,
    )
    .await?;
    let chat = text(&row["chat_id"])?;
    context::lock_chat(tx, owner, &chat).await?;
    let current = context::read(
        Executor::Transaction(tx),
        owner,
        &worker,
        &operation,
        &generation,
    )
    .await?;
    if truthy(input.get("terminalResult")) && !truthy(input.get("executionComplete")) {
        return reject("terminal-result-requires-completion");
    }
    let missing = current["status"] == "uncertain"
        && current["rejection_code"] == "missing-native-receipt"
        && [
            "result_digest",
            "protected_result",
            "terminal_result_digest",
            "protected_terminal_result",
            "terminal_evidence",
        ]
        .iter()
        .all(|field| !truthy(current.get(field)));
    let state = Settlement {
        owner,
        input,
        row,
        current,
        terminal: terminal(input),
        missing,
    };
    if truthy(state.current.get("execution_completed_at"))
        && truthy(input.get("executionComplete"))
        && !(truthy(input.get("deferred")) && missing)
    {
        if state.current.get("status") != input.get("status")
            || (truthy(input.get("resultDigest"))
                && state.current.get("result_digest") != input.get("resultDigest"))
            || (truthy(input["terminalResult"].get("resultDigest"))
                && state.current.get("terminal_result_digest")
                    != input["terminalResult"].get("resultDigest"))
            || (truthy(Some(&state.terminal))
                && state.current.get("terminal_evidence") != Some(&state.terminal))
        {
            return reject("receipt-conflict");
        }
        return response(tx, owner, input, &state.current, &chat).await;
    }
    state.deferred(tx).boxed().await?;
    state.evidence(tx).await?;
    let goal = if truthy(input.get("goalEpoch"))
        && input["status"] == "applied"
        && truthy(input.get("protectedResult"))
        && truthy(input.get("resultDigest"))
        && state.row["method"] == "thread/goal/set"
    {
        raw_one(tx,"SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE operation_id=$1 AND operation_generation=$2 AND awaiting_goal=true",&[&operation,&generation]).await?.is_some_and(|claim|!truthy(claim.get("goal_epoch"))||claim.get("goal_epoch")==input.get("goalEpoch"))
    } else {
        false
    };
    state.transition(goal)?;
    if truthy(input.get("reconciliation")) {
        turns::remember(tx, &state.current, &input["reconciliation"]).await?;
    }
    let updated = state.persist(tx).await?;
    settings_persistence::settle_transport(tx, &updated).await?;
    state.finish(tx).boxed().await?;
    let turn = input["reconciliation"]
        .get("nativeTurnId")
        .filter(|v| !v.is_null())
        .map(text)
        .transpose()?;
    queue::settle(tx, &updated, turn.as_deref(), input.get("goalEpoch")).await?;
    response(tx, owner, input, &updated, &chat).await
}
impl Repository {
    pub async fn settle(&self, owner: &str, input: &Value) -> Result<Value> {
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database
            .transaction(|tx| Box::pin(async move { settle(tx, &owner, &input).await }))
            .await
    }
}
