//! Native command dispatch/receipts and recovery state share one chat lock and
//! database transaction. Saved correlation IDs are never execution grants.
use super::{
    admit::{raw_one, reject, text},
    context, queue,
};
use crate::{
    database::{Executor, Transaction},
    settings::parse_response,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};

/** Committed suspension retains the original unfinished root across transport
 * loss. Administrative closure is not native terminal evidence. */
pub(super) async fn retained_execution(
    tx: &Transaction<'_>,
    owner: &str,
    row: &Value,
) -> Result<Option<Value>> {
    let current = chat(tx, owner, &text(&row["chat_id"])?).await?;
    Ok(read(&current)?.filter(|state| {
        !state["checkpoint"].is_null()
            && !state["active"].is_null()
            && !state["actor"].is_null()
            && !terminal(state)
            && state["phase"] != "running"
            && !(row["terminal_evidence"]["kind"] == "terminal"
                && matches!(
                    row["terminal_evidence"]["terminalStatus"].as_str(),
                    Some("completed" | "failed" | "interrupted")
                )
                && row["terminal_evidence"]["nativeTurnId"] == state["active"]["turnId"]
                && row["terminal_evidence"]["runtimeGeneration"]
                    == row["identity"]["runtimeGeneration"])
            && row["kind"] == "start"
            && state["target"]["workerId"] == row["worker_id"]
            && state["target"]["originalOperationId"] == row["operation_id"]
            && state["target"]["executionLaneId"] == row["execution_lane_id"]
            && state["active"]["threadId"] == row["identity"]["threadId"]
            && state["actor"]["runtimeGeneration"] == row["identity"]["runtimeGeneration"]
    }))
}

impl super::Repository {
    pub async fn suspended_execution(
        &self,
        owner: &str,
        worker: &str,
        operation: &str,
        generation: &str,
    ) -> Result<Option<Value>> {
        let (owner, worker, operation, generation) = (
            owner.to_owned(),
            worker.to_owned(),
            operation.to_owned(),
            generation.to_owned(),
        );
        self.database.transaction(|tx| Box::pin(async move {
            let captured = context::read(Executor::Transaction(tx), &owner, &worker, &operation, &generation).await?;
            let id = text(&captured["chat_id"])?;
            context::lock_chat(tx, &owner, &id).await?;
            let row = context::read(Executor::Transaction(tx), &owner, &worker, &operation, &generation).await?;
            let active = raw_one(tx, "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1", &[&id]).await?.unwrap_or(Value::Null);
            if !truthy(active.get("active")) || active["worker_id"] != worker || active["execution_lane_id"] != row["execution_lane_id"] { return Ok(None); }
            let head = raw_one(tx, "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1", &[&text(&active["operation_id"])?]).await?;
            let Some(head) = head.filter(|head|
                head["owner_id"] == owner && head["worker_id"] == worker && head["chat_id"] == row["chat_id"] &&
                head["activation_generation"] == active["generation"] &&
                head["execution_lane_id"] == row["execution_lane_id"] &&
                (head["operation_id"] == row["operation_id"] ||
                (row["logical_operation_id"] == row["operation_id"] && head["logical_operation_id"] == row["operation_id"]))
            ) else { return Ok(None); };
            retained_execution(tx, &owner, &head).await
        })).await
    }
}

fn terminal(state: &Value) -> bool {
    matches!(
        state["phase"].as_str(),
        Some("stopped" | "completed" | "failed" | "idle")
    )
}
async fn chat(tx: &Transaction<'_>, owner: &str, id: &str) -> Result<Value> {
    raw_one(
        tx,
        "SELECT to_jsonb(c)::text FROM chats c WHERE owner_id=$1 AND id=$2",
        &[&owner, &id],
    )
    .await?
    .context("Suspension chat not found")
}
fn read(chat: &Value) -> Result<Option<Value>> {
    if chat["native_suspension_state"].is_null() {
        return Ok(None);
    }
    parse_response(
        "nativeSuspensionRecordSchema",
        Some(&chat["native_suspension_state"]),
    )
    .map(Some)
    .map_err(|_| super::CommandError::new("suspension-state-unreadable", None, 409).into())
}
fn same_source(state: &Value, chat: &Value, context: &Value) -> bool {
    let target = &state["target"];
    [
        "workerId",
        "contextKind",
        "projectId",
        "threadId",
        "modelRouteId",
        "providerAccountId",
    ]
    .iter()
    .all(|key| target[*key] == context[*key])
        && target["placementId"]
            == if context["worktreeId"].is_null() {
                context["scratchRootId"].clone()
            } else {
                context["worktreeId"].clone()
            }
        && target["placementRevision"] == chat["placement_revision"]
        && target["cantripOsBindingId"] == chat["cantrip_os_binding_id"]
}
async fn save(
    tx: &Transaction<'_>,
    owner: &str,
    id: &str,
    mut state: Value,
    paused: bool,
) -> Result<()> {
    let now = crate::auth::now();
    state["updatedAt"] = json!(crate::auth::iso(now));
    let parsed = parse_response("nativeSuspensionRecordSchema", Some(&state))?;
    let stopping = state["action"] == "stop";
    tx.query("UPDATE chats SET native_suspension_state=$1::text::jsonb,automation_paused=$2,managed_autonomy_stopped=CASE WHEN $3::boolean THEN true ELSE managed_autonomy_stopped END,updated_at=$4 WHERE owner_id=$5 AND id=$6", &[&parsed.stringify(), &paused, &stopping, &now, &owner, &id]).await?;
    queue::changed(tx, id).await
}
fn finish_time(state: &mut Value) -> Result<()> {
    let elapsed = if let Some(at) = state["pausedAt"].as_str() {
        (crate::auth::now().timestamp_millis()
            - chrono::DateTime::parse_from_rfc3339(at)?.timestamp_millis())
        .max(0)
    } else {
        0
    };
    let total = state["pausedMilliseconds"]
        .as_i64()
        .context("Suspension paused time")?;
    state["pausedMilliseconds"] = json!(total.saturating_add(elapsed).min(9_007_199_254_740_991));
    state["pausedAt"] = Value::Null;
    Ok(())
}

pub(super) async fn dispatch(
    tx: &Transaction<'_>,
    owner: &str,
    row: &Value,
    input: &Value,
) -> Result<bool> {
    let intent = &row["intent"];
    if !truthy(intent.get("durableSuspension")) && row["method"] != "turn/interrupt" {
        return Ok(false);
    }
    let id = text(&row["chat_id"])?;
    let chat = chat(tx, owner, &id).await?;
    let previous = read(&chat)?;
    let stopping =
        row["method"] == "turn/interrupt" && previous.as_ref().is_some_and(|s| !terminal(s));
    if !truthy(intent.get("durableSuspension")) {
        if stopping {
            return reject("suspension-durable-control-required");
        }
        return Ok(false);
    }
    if !matches!(
        row["method"].as_str(),
        Some("turn/pause" | "turn/interrupt")
    ) || !truthy(input.get("workerGeneration"))
        || !truthy(input["session"].get("runtimeGeneration"))
        || !truthy(input["session"].get("threadId"))
        || !truthy(intent.get("expectedTurnId"))
    {
        return reject("invalid-suspension-control");
    }
    let action = if row["method"] == "turn/interrupt" {
        "stop"
    } else if intent["paused"] == true {
        "pause"
    } else {
        "resume"
    };
    if previous
        .as_ref()
        .is_some_and(|s| s["action"] == "stop" && !terminal(s))
        && action != "stop"
    {
        return reject("suspension-stop-pending");
    }
    let active = json!({"threadId":input["session"]["threadId"],"turnId":intent["expectedTurnId"]});
    let duplicate = previous.as_ref().is_some_and(|s| match action {
        "pause" => matches!(s["phase"].as_str(), Some("pausing" | "paused")),
        "resume" => s["phase"] == "resuming",
        _ => (terminal(s) && s["active"] == active) || s["phase"] == "stopping",
    });
    if action == "resume"
        && !duplicate
        && !previous.as_ref().is_some_and(|s| {
            !s["checkpoint"].is_null()
                && s["action"] != "stop"
                && (s["phase"] == "paused" || (s["phase"] == "error" && s["action"] == "resume"))
        })
    {
        return reject("suspension-not-resumable");
    }
    let context = context::execution(tx, owner, &id)
        .await?
        .context("Suspension source unavailable")?;
    let now = crate::auth::iso(crate::auth::now());
    let mut state = if let Some(prior) = previous.filter(|s| !terminal(s) || duplicate) {
        if action != "stop" && !same_source(&prior, &chat, &context) {
            return reject("suspension-authority-changed");
        }
        prior
    } else {
        let activation = raw_one(
            tx,
            "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",
            &[&id],
        )
        .await?
        .unwrap_or(Value::Null);
        json!({"version":1,"controlId":uuid::Uuid::new_v4().to_string(),"action":action,"phase":"pausing",
            "target":json!({"workerId":context["workerId"],"contextKind":context["contextKind"],"projectId":context["projectId"],
                "placementId":if context["worktreeId"].is_null(){&context["scratchRootId"]}else{&context["worktreeId"]},
                "placementRevision":chat["placement_revision"],"cantripOsBindingId":chat["cantrip_os_binding_id"],
                "executionLaneId":context["executionLaneId"],"modelRouteId":context["modelRouteId"],"providerAccountId":context["providerAccountId"],
                "threadId":context["threadId"],"originalOperationId":activation["operation_id"]}),
            "active":Value::Null,"checkpoint":Value::Null,"actor":Value::Null,"actorControlId":Value::Null,"error":Value::Null,
            "requestedAt":now,"updatedAt":now,"pausedAt":Value::Null,"pausedMilliseconds":0})
    };
    if !duplicate {
        state["controlId"] = json!(uuid::Uuid::new_v4().to_string());
        state["actorControlId"] = Value::Null;
        state["action"] = json!(action);
        state["phase"] = json!(match action {
            "pause" => "pausing",
            "resume" => "resuming",
            _ => "stopping",
        });
        state["error"] = Value::Null;
        state["requestedAt"] = json!(now);
    }
    if !matches!(
        state["phase"].as_str(),
        Some("pausing" | "resuming" | "stopping")
    ) {
        return reject("suspension-control-settled");
    }
    if (!state["active"].is_null() && state["active"] != active)
        || active["threadId"] != state["target"]["threadId"]
    {
        return reject("suspension-turn-mismatch");
    }
    state["active"] = active;
    state["actor"] = json!({"workerGeneration":input["workerGeneration"],"runtimeGeneration":input["session"]["runtimeGeneration"],
        "operationId":row["operation_id"],"operationGeneration":row["operation_generation"]});
    state["actorControlId"] = state["controlId"].clone();
    save(tx, owner, &id, state, true).await?;
    // Request and claim each advance the shared queue revision in the TS path.
    if !duplicate {
        queue::changed(tx, &id).await?;
    }
    Ok(true)
}

pub(super) async fn settle(
    tx: &Transaction<'_>,
    owner: &str,
    row: &Value,
    input: &Value,
) -> Result<()> {
    if !truthy(row["intent"].get("durableSuspension")) {
        if truthy(input.get("durableSuspension")) || truthy(input.get("suspensionEvidence")) {
            return reject("unexpected-suspension-evidence");
        }
        return Ok(());
    }
    let id = text(&row["chat_id"])?;
    let current = chat(tx, owner, &id).await?;
    let Some(mut state) = read(&current)? else {
        return reject("suspension-actor-stale");
    };
    let actor = &state["actor"];
    if actor["operationId"] != row["operation_id"]
        || actor["operationGeneration"] != row["operation_generation"]
        || actor["runtimeGeneration"] != row["identity"]["runtimeGeneration"]
        || actor["workerGeneration"] != input["workerGeneration"]
        || !truthy(input.get("durableSuspension"))
        || state["actorControlId"] != state["controlId"]
    {
        return reject("suspension-actor-stale");
    }
    if terminal(&state) {
        return Ok(());
    }
    if input["status"] != "applied" {
        if matches!(state["phase"].as_str(), Some("paused" | "running")) {
            return reject("suspension-control-settled");
        }
        state["phase"] = json!("error");
        state["error"] = json!({"code":match state["action"].as_str(){Some("pause")=>"pause-failed",Some("resume")=>"restore-failed",_=>"stop-failed"},"protectedDetails":Value::Null});
    } else {
        let context = context::execution(tx, owner, &id)
            .await?
            .context("Suspension source unavailable")?;
        if state["action"] != "stop" && !same_source(&state, &current, &context) {
            return reject("suspension-authority-changed");
        }
        match state["action"].as_str() {
            Some("pause") => {
                let Some(evidence) = input.get("suspensionEvidence") else {
                    return reject("suspension-evidence-required");
                };
                if state["phase"] == "paused" && state["checkpoint"] == *evidence {
                    return Ok(());
                }
                if state["phase"] != "pausing" {
                    return reject("suspension-control-settled");
                }
                if evidence["suspension"]["threadId"] != state["active"]["threadId"]
                    || evidence["suspension"]["turnId"] != state["active"]["turnId"]
                {
                    return reject("suspension-turn-mismatch");
                }
                state["checkpoint"] = evidence.clone();
                state["phase"] = json!("paused");
                if state["pausedAt"].is_null() {
                    state["pausedAt"] = json!(crate::auth::iso(crate::auth::now()));
                }
            }
            Some("resume") => {
                if truthy(input.get("suspensionEvidence")) {
                    return reject("unexpected-suspension-evidence");
                }
                if state["phase"] == "running" {
                    return Ok(());
                }
                if state["phase"] != "resuming"
                    || state["active"].is_null()
                    || state["checkpoint"].is_null()
                {
                    return reject("suspension-control-settled");
                }
                finish_time(&mut state)?;
                state["phase"] = json!("running");
            }
            _ => {
                if state["phase"] != "stopping" {
                    return reject("suspension-control-settled");
                }
                finish_time(&mut state)?;
                state["phase"] = json!("stopped");
                state["checkpoint"] = Value::Null;
                state["error"] = Value::Null;
            }
        }
    }
    let paused = state["phase"] != "running";
    save(tx, owner, &id, state, paused).await
}

pub(super) async fn finish(
    tx: &Transaction<'_>,
    owner: &str,
    row: &Value,
    input: &Value,
) -> Result<()> {
    if !truthy(input["reconciliation"].get("terminalStatus"))
        || truthy(input.get("deferred"))
        || truthy(input.get("decline"))
        || row["kind"] != "start"
    {
        return Ok(());
    }
    let id = text(&row["chat_id"])?;
    let current = chat(tx, owner, &id).await?;
    let Some(mut state) = read(&current)? else {
        return Ok(());
    };
    if state["actor"].is_null()
        || state["active"].is_null()
        || state["action"] == "stop"
        || state["target"]["originalOperationId"] != row["operation_id"]
        || state["active"]["turnId"] != input["reconciliation"]["nativeTurnId"]
        || state["actor"]["runtimeGeneration"] != input["reconciliation"]["runtimeGeneration"]
        || state["actor"]["runtimeGeneration"] != row["identity"]["runtimeGeneration"]
        || terminal(&state)
    {
        return Ok(());
    }
    finish_time(&mut state)?;
    state["phase"] = json!(if input["reconciliation"]["terminalStatus"] == "failed" {
        "failed"
    } else {
        "completed"
    });
    state["checkpoint"] = Value::Null;
    state["error"] = Value::Null;
    save(
        tx,
        owner,
        &id,
        state,
        truthy(current.get("automation_paused")),
    )
    .await
}

pub(super) async fn assert_terminal_proof(
    tx: &Transaction<'_>,
    owner: &str,
    row: &Value,
    input: &Value,
) -> Result<()> {
    if !truthy(input.get("executionComplete"))
        || row["kind"] != "start"
        || truthy(input.get("deferred"))
        || truthy(input.get("decline"))
        || truthy(input["reconciliation"].get("terminalStatus"))
    {
        return Ok(());
    }
    let id = text(&row["chat_id"])?;
    let current = chat(tx, owner, &id).await?;
    if read(&current)?.is_some_and(|s| {
        !s["active"].is_null()
            && s["target"]["originalOperationId"] == row["operation_id"]
            && s["actor"]["runtimeGeneration"] == row["identity"]["runtimeGeneration"]
            && !terminal(&s)
    }) {
        return reject("suspended-execution-not-terminal");
    }
    Ok(())
}
