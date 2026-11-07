//! Task controls bind the real canonical input, without a GUI activation.
use super::{
    admit::{reject, text},
    context, suspension,
};
use crate::{
    chats::native_task_suspension::{self, Source},
    database::Transaction,
    settings::parse_response,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};

pub(crate) fn matches_source(state: &Value, chat: &Value, source: &Source) -> bool {
    suspension::same_source(state, chat, &source.context)
        && state["target"]["taskRound"] == source.task_round
        && state["target"]["executionLaneId"] == source.receipt["executionLaneId"]
}

pub(crate) async fn bind_running(
    tx: &Transaction<'_>,
    owner: &str,
    receipt: &Value,
    physical: &Value,
) -> Result<()> {
    let id = text(&receipt["chatId"])?;
    let row = suspension::chat(tx, owner, &id).await?;
    let mut state = suspension::read(&row)?.context("Task suspension missing")?;
    if state["controlId"] != physical["controlId"] || state["action"] != "resume" {
        return reject("suspension-control-stale");
    }
    let context = context::execution(tx, owner, &id)
        .await?
        .context("Task source missing")?;
    let source = native_task_suspension::source(tx, &context)
        .await?
        .context("Task source missing")?;
    let actor = json!({"workerGeneration":physical["nativeOwner"]["workerGeneration"],"runtimeGeneration":physical["nativeOwner"]["runtimeGeneration"],
        "operationId":receipt["operationId"],"operationGeneration":receipt["operationId"]});
    let active = json!({"threadId":physical["nativeExecution"]["threadId"],"turnId":physical["nativeExecution"]["turnId"]});
    if !matches_source(&state, &row, &source)
        || !native_task_suspension::matches_actor(&source, &state["target"], &actor, &active)
    {
        return reject("suspension-authority-changed");
    }
    if state["phase"] == "running" {
        if state["actor"] != actor || state["active"] != active {
            return reject("suspension-actor-stale");
        }
        return Ok(());
    }
    if state["phase"] != "resuming" || state["active"] != active {
        return reject("suspension-control-stale");
    }
    state["actor"] = actor;
    state["active"] = active;
    state["actorControlId"] = state["controlId"].clone();
    suspension::save(tx, owner, &id, state.clone(), true).await?;
    suspension::finish_time(&mut state)?;
    state["phase"] = json!("running");
    suspension::save(tx, owner, &id, state, false).await
}

pub(crate) async fn retire_locked(
    tx: &Transaction<'_>,
    owner: &str,
    original: &Value,
    physical: &Value,
    active: &Value,
    outcome: &str,
) -> Result<()> {
    if physical["nativeOwner"].is_null() {
        return Ok(());
    }
    let id = text(&original["chatId"])?;
    let row = suspension::chat(tx, owner, &id).await?;
    let Some(mut state) = suspension::read(&row)? else {
        return Ok(());
    };
    let receipt = &physical["receipt"];
    let actor = json!({"workerGeneration":physical["nativeOwner"]["workerGeneration"],"runtimeGeneration":physical["nativeOwner"]["runtimeGeneration"],
        "operationId":receipt["operationId"],"operationGeneration":receipt["operationId"]});
    if state["target"]["taskRound"].is_null()
        || suspension::terminal(&state)
        || state["target"]["taskRound"]["inputOperationId"] != original["operationId"]
        || state["target"]["taskRound"]["operationId"] != receipt["dispatch"]["operationId"]
        || state["target"]["taskRound"]["cycleId"] != receipt["dispatch"]["cycleId"]
        || state["target"]["workerId"] != receipt["workerId"]
        || state["target"]["executionLaneId"] != receipt["executionLaneId"]
        || state["actor"] != actor
        || state["active"] != *active
    {
        return Ok(());
    }
    suspension::finish_time(&mut state)?;
    state["phase"] = json!(outcome);
    state["checkpoint"] = Value::Null;
    state["error"] = Value::Null;
    suspension::save(tx, owner, &id, state, row["automation_paused"] == true).await
}

pub(crate) async fn request_locked(
    tx: &Transaction<'_>,
    owner: &str,
    id: &str,
    action: &str,
    revision: Option<&Value>,
) -> Result<Value> {
    let chat = suspension::chat(tx, owner, id).await?;
    if revision.is_some_and(|revision| chat["managed_input_revision"] != *revision) {
        return reject("suspension-control-stale");
    }
    let context = context::execution(tx, owner, id)
        .await?
        .context("Task suspension source unavailable")?;
    let source = native_task_suspension::source(tx, &context)
        .await?
        .context("Task suspension source unavailable")?;
    let previous = suspension::read(&chat)?;
    let previous = previous.filter(|state| !suspension::terminal(state));
    if let Some(state) = &previous {
        if !matches_source(state, &chat, &source) {
            return reject("suspension-authority-changed");
        }
        if state["action"] == "stop" && action != "stop" {
            return reject("suspension-stop-pending");
        }
        if (action == "pause" && matches!(state["phase"].as_str(), Some("pausing" | "paused")))
            || (action == "resume" && state["phase"] == "resuming")
            || (action == "stop" && state["phase"] == "stopping")
        {
            return Ok(state.clone());
        }
    }
    if action == "resume"
        && previous.as_ref().is_none_or(|state| {
            state["checkpoint"].is_null()
                || !(state["phase"] == "paused"
                    || (state["phase"] == "error" && state["action"] == "resume"))
        })
    {
        return reject("suspension-not-resumable");
    }
    let now = crate::auth::iso(crate::auth::now());
    let mut state = previous.unwrap_or_else(|| json!({"version":1,"controlId":uuid::Uuid::new_v4().to_string(),"action":action,"phase":"pausing",
        "target":json!({"workerId":source.context["workerId"],"contextKind":"project","projectId":source.context["projectId"],
            "placementId":source.context["worktreeId"],"placementRevision":chat["placement_revision"],"cantripOsBindingId":chat["cantrip_os_binding_id"],
            "executionLaneId":source.context["executionLaneId"],"modelRouteId":source.context["modelRouteId"],"providerAccountId":source.context["providerAccountId"],
            "threadId":source.context["threadId"],"originalOperationId":source.receipt["operationId"],"taskRound":source.task_round}),
        "active":Value::Null,"checkpoint":Value::Null,"actor":Value::Null,"actorControlId":Value::Null,"error":Value::Null,
        "requestedAt":now,"updatedAt":now,"pausedAt":Value::Null,"pausedMilliseconds":0}));
    state["controlId"] = json!(uuid::Uuid::new_v4().to_string());
    state["actorControlId"] = Value::Null;
    state["action"] = json!(action);
    state["phase"] = json!(match action {
        "pause" => "pausing",
        "stop" => "stopping",
        _ => "resuming",
    });
    if action == "stop" && state["active"].is_null() {
        state["active"] = json!({"threadId":source.native_execution["threadId"],"turnId":source.native_execution["turnId"]});
    }
    state["error"] = Value::Null;
    state["requestedAt"] = json!(now);
    suspension::save(tx, owner, id, state, true).await?;
    suspension::read(&suspension::chat(tx, owner, id).await?)?
        .context("Task suspension disappeared")
}

impl super::Repository {
    pub async fn cancelled_task_execution(
        &self,
        owner: &str,
        worker: &str,
        chat: &str,
        lease: &Value,
        lane: &Value,
        message: &Value,
    ) -> Result<bool> {
        let (owner, worker, chat, lease, lane, message) = (
            owner.to_owned(),
            worker.to_owned(),
            chat.to_owned(),
            lease.clone(),
            lane.clone(),
            message.clone(),
        );
        self.database.transaction(|tx| Box::pin(async move {
            context::lock_chat(tx, &owner, &chat).await?;
            let rows = tx.query("SELECT CASE WHEN c.goal_input IS NOT NULL THEN c.goal_input ELSE r.inference_input END::text FROM task_dispatch_cycles c JOIN task_planning_rounds r ON r.id=c.operation_id AND r.chat_id=c.chat_id WHERE c.id=$1 AND c.chat_id=$2 AND c.owner_id=$3", &[&text(&lease["cycleId"])?,&chat,&owner]).await?;
            let Some(row) = rows.first() else {return Ok(false);};
            let Some(raw) = row.get::<Option<String>>(0)? else {return Ok(false);};
            let input: Value = serde_json::from_str(&raw)?;
            let receipt = &crate::tasks::resumption::physical(&input)["receipt"];
            if receipt["executionLaneId"] != lane || receipt["clientMessageId"] != message ||
                ["cycleId","operationId","leaseOwner","fencingToken"].iter().any(|key|receipt["dispatch"][*key] != lease[*key]) {return Ok(false);}
            Ok(stopped_input_locked(tx, &owner, &worker, receipt, &input).await?.is_some())
        })).await
    }
    pub async fn prepare_task_stop(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database.transaction(|tx| Box::pin(async move {
            context::lock_chat(tx, &owner, &chat).await?;
            let row = suspension::chat(tx, &owner, &chat).await?;
            let previous = suspension::read(&row)?;
            let context = context::execution(tx, &owner, &chat).await?;
            let source = if let Some(context) = context {native_task_suspension::source(tx, &context).await?} else {None};
            let task = tx.query("SELECT active_operation_id FROM tasks WHERE chat_id=$1", &[&chat]).await?;
            let task = task.first().map(|row|row.get::<Option<String>>(0)).transpose()?.flatten();
            if let Some(previous) = &previous {
                if !previous["target"]["taskRound"].is_null() && suspension::terminal(previous) &&
                    source.as_ref().map(|source| previous["target"]["taskRound"] == source.task_round &&
                        previous["active"]["threadId"] == source.native_execution["threadId"] && previous["active"]["turnId"] == source.native_execution["turnId"])
                        .unwrap_or_else(||task.as_ref().is_none_or(|task|previous["target"]["taskRound"]["operationId"] == task.as_str())) {
                    return Ok(Some(json!({"state":previous,"context":Value::Null,"stop":Value::Null})));
                }
            }
            let Some(source) = source else {return Ok(None);};
            if previous.as_ref().is_some_and(|state| !suspension::terminal(state) && !matches_source(state, &row, &source)) {
                return reject("suspension-authority-changed");
            }
            let mut state = request_locked(tx, &owner, &chat, "stop", None).await?;
            // Keep the actual bound execution's terminal proof valid while the
            // separate native Stop operation awaits its acknowledgement.
            let actor = json!({"workerGeneration":source.native_owner["workerGeneration"],"runtimeGeneration":source.native_owner["runtimeGeneration"],
                "operationId":source.execution_receipt["operationId"],"operationGeneration":source.execution_receipt["operationId"]});
            if state["actor"] != actor || state["actorControlId"] != state["controlId"] {
                state["actor"] = actor;
                state["actorControlId"] = state["controlId"].clone();
                suspension::save(tx, &owner, &chat, state.clone(), true).await?;
                state = suspension::read(&suspension::chat(tx, &owner, &chat).await?)?.context("Task Stop disappeared")?;
            }
            Ok(Some(json!({"context":source.context,"state":state,
                "stop":json!({"controlId":state["controlId"],"source":source.receipt,"checkpoint":state["checkpoint"],
                    "active":json!({"threadId":source.native_execution["threadId"],"turnId":source.native_execution["turnId"]})})})))
        })).await
    }
    pub async fn acknowledge_task_stop(
        &self,
        owner: &str,
        chat: &str,
        stop: &Value,
        scope: &Value,
        input: &Value,
    ) -> Result<Value> {
        let (owner, chat, stop, scope, proof) = (
            owner.to_owned(),
            chat.to_owned(),
            stop.clone(),
            scope.clone(),
            parse_response("taskTurnStopResultSchema", Some(input))?,
        );
        self.database.transaction(|tx| Box::pin(async move {
            context::lock_chat(tx, &owner, &chat).await?;
            let row = suspension::chat(tx, &owner, &chat).await?;
            let mut state = suspension::read(&row)?.context("Task suspension missing")?;
            if state["controlId"] != stop["controlId"] || proof["controlId"] != stop["controlId"] {return reject("suspension-control-stale");}
            if suspension::terminal(&state) {return Ok(state);}
            if state["action"] != "stop" || state["phase"] != "stopping" {return reject("suspension-control-settled");}
            if row["managed_input_revision"] != scope["revision"] {return reject("suspension-control-stale");}
            let context = context::execution(tx, &owner, &chat).await?.context("Task source missing")?;
            let source = native_task_suspension::source(tx, &context).await?.context("Task source missing")?;
            if state["target"]["taskRound"] != scope["taskRound"] || state["active"] != stop["active"] || proof["active"] != stop["active"] {
                return reject("suspension-turn-mismatch");
            }
            if !matches_source(&state, &row, &source) || source.receipt != stop["source"] {return reject("suspension-authority-changed");}
            if proof["actor"]["operationId"] != stop["controlId"] || proof["actor"]["operationGeneration"] != stop["controlId"] {return reject("suspension-actor-stale");}
            let lane = text(&source.receipt["executionLaneId"])?;
            crate::chats::execution_lanes::finish_in_transaction(tx, &chat, &lane, if proof["outcome"] == "failed" {"failed"} else {"idle"},
                &json!({"expectedActivatedAt":source.receipt["executionLaneActivatedAt"],"markUnreadCompletion":false})).await?;
            tx.query("UPDATE agent_interaction_requests SET status='interrupted',resolved_at=now(),updated_at=now() WHERE chat_id=$1 AND execution_lane_id=$2 AND status='pending'", &[&chat,&lane]).await?;
            suspension::finish_time(&mut state)?;
            state["actor"] = proof["actor"].clone(); state["actorControlId"] = state["controlId"].clone();
            state["phase"] = proof["outcome"].clone(); state["checkpoint"] = Value::Null; state["error"] = Value::Null;
            suspension::save(tx, &owner, &chat, state.clone(), true).await?;
            Ok(state)
        })).await
    }
    pub async fn task_resumption(&self, owner: &str, chat: &str, control: &str) -> Result<Value> {
        let (owner, chat, control) = (owner.to_owned(), chat.to_owned(), control.to_owned());
        self.database.transaction(|tx| Box::pin(async move {
            context::lock_chat(tx, &owner, &chat).await?;
            let row = suspension::chat(tx, &owner, &chat).await?;
            let state = suspension::read(&row)?.context("Task suspension missing")?;
            if state["controlId"] != control || state["phase"] != "resuming" || state["checkpoint"].is_null() || state["target"]["taskRound"].is_null() {
                return reject("suspension-control-stale");
            }
            let context = context::execution(tx, &owner, &chat).await?.context("Task source missing")?;
            let source = native_task_suspension::source(tx, &context).await?.context("Task source missing")?;
            if !matches_source(&state, &row, &source) {return reject("suspension-source-unavailable");}
            Ok(json!({"controlId":control,"checkpoint":state["checkpoint"],"source":source.receipt}))
        })).await
    }
    pub async fn request_task_suspension(
        &self,
        owner: &str,
        chat: &str,
        intent: &Value,
    ) -> Result<Value> {
        let (owner, chat, intent) = (owner.to_owned(), chat.to_owned(), intent.clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    context::lock_chat(tx, &owner, &chat).await?;
                    request_locked(
                        tx,
                        &owner,
                        &chat,
                        if intent["paused"] == true {
                            "pause"
                        } else {
                            "resume"
                        },
                        Some(&intent["scope"]["revision"]),
                    )
                    .await
                })
            })
            .await
    }

    pub async fn acknowledge_task_suspension(
        &self,
        owner: &str,
        chat: &str,
        intent: &Value,
        expected: &Value,
        response: &Value,
    ) -> Result<Value> {
        let (owner, chat, intent, expected, response) = (
            owner.to_owned(),
            chat.to_owned(),
            intent.clone(),
            expected.clone(),
            response.clone(),
        );
        self.database.transaction(|tx| Box::pin(async move {
            context::lock_chat(tx, &owner, &chat).await?;
            let row = suspension::chat(tx, &owner, &chat).await?;
            let mut state = suspension::read(&row)?.context("Task suspension missing")?;
            if state["controlId"] != expected["controlId"] || row["managed_input_revision"] != intent["scope"]["revision"] {
                return reject("suspension-control-stale");
            }
            let context = context::execution(tx, &owner, &chat).await?.context("Task source missing")?;
            let source = native_task_suspension::source(tx, &context).await?.context("Task source missing")?;
            let actor = &response["execution"]["actor"];
            let active = &response["active"];
            if active.is_null() || actor.is_null() {anyhow::bail!("The saved Task continuation has no live native owner. It remains paused for recovery.");}
            if !matches_source(&state, &row, &source) || !native_task_suspension::matches_actor(&source, &state["target"], actor, active) {
                return reject("suspension-authority-changed");
            }
            if (!state["active"].is_null() && state["active"] != *active) || active["threadId"] != state["target"]["threadId"] {
                return reject("suspension-turn-mismatch");
            }
            let paused = intent["paused"] == true;
            if !paused && state["phase"] == "running" {
                if state["actor"] != *actor || state["active"] != *active {return reject("suspension-actor-stale");}
                return Ok(state);
            }
            if paused && state["phase"] == "paused" {
                if state["checkpoint"] != response["execution"]["checkpoint"] {return reject("suspension-turn-mismatch");}
                return Ok(state);
            }
            if state["phase"] != if paused {"pausing"} else {"resuming"} {return reject("suspension-control-settled");}
            if state["actor"] != expected["actor"] {return reject("suspension-actor-stale");}
            state["actor"] = actor.clone();
            state["active"] = active.clone();
            state["actorControlId"] = state["controlId"].clone();
            suspension::save(tx, &owner, &chat, state.clone(), true).await?;
            if paused {
                let checkpoint = parse_response("nativeSuspensionEvidenceSchema", Some(&response["execution"]["checkpoint"]))?;
                if checkpoint["suspension"]["threadId"] != active["threadId"] || checkpoint["suspension"]["turnId"] != active["turnId"] {
                    return reject("suspension-turn-mismatch");
                }
                state["checkpoint"] = checkpoint;
                state["phase"] = json!("paused");
                if state["pausedAt"].is_null() {state["pausedAt"] = json!(crate::auth::iso(crate::auth::now()));}
            } else {
                if !response["execution"]["checkpoint"].is_null() {return reject("unexpected-suspension-evidence");}
                suspension::finish_time(&mut state)?;
                state["phase"] = json!("running");
            }
            suspension::save(tx, &owner, &chat, state, paused).await?;
            suspension::read(&suspension::chat(tx, &owner, &chat).await?)?.context("Task suspension disappeared")
        })).await
    }

    pub async fn retain_task_suspension(
        &self,
        owner: &str,
        worker: &str,
        chat: &str,
        lease: &Value,
        lane: &Value,
        message: &Value,
    ) -> Result<Option<Value>> {
        let (owner, worker, chat, lease, lane, message) = (
            owner.to_owned(),
            worker.to_owned(),
            chat.to_owned(),
            lease.clone(),
            lane.clone(),
            message.clone(),
        );
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    retain_locked(tx, &owner, &worker, &chat, &lease, &lane, &message).await
                })
            })
            .await
    }
}

pub(crate) async fn retain_locked(
    tx: &Transaction<'_>,
    owner: &str,
    worker: &str,
    chat: &str,
    lease: &Value,
    lane: &Value,
    message: &Value,
) -> Result<Option<Value>> {
    context::lock_chat(tx, owner, chat).await?;
    let row = suspension::chat(tx, owner, chat).await?;
    let Some(state) = suspension::read(&row)?.filter(|state| {
        !state["checkpoint"].is_null()
            && !state["active"].is_null()
            && !state["actor"].is_null()
            && state["action"] != "stop"
            && matches!(
                state["phase"].as_str(),
                Some("pausing" | "paused" | "resuming" | "error")
            )
    }) else {
        return Ok(None);
    };
    let Some(context) = context::execution(tx, owner, chat).await? else {
        return Ok(None);
    };
    let Some(source) = native_task_suspension::source(tx, &context).await? else {
        return Ok(None);
    };
    let receipt = &source.current_receipt;
    if receipt["workerId"] != worker
        || ["cycleId", "operationId", "leaseOwner", "fencingToken"]
            .iter()
            .any(|key| receipt["dispatch"][*key] != lease[*key])
        || receipt["executionLaneId"] != *lane
        || receipt["clientMessageId"] != *message
        || !matches_source(&state, &row, &source)
        || !native_task_suspension::matches_actor(
            &source,
            &state["target"],
            &state["actor"],
            &state["active"],
        )
    {
        return Ok(None);
    }
    let (cycle, operation, thread, turn) = (
        text(&lease["cycleId"])?,
        text(&lease["operationId"])?,
        text(&state["active"]["threadId"])?,
        text(&state["active"]["turnId"])?,
    );
    tx.query("UPDATE task_dispatch_cycles SET state='paused',codex_thread_id=$3,turn_id=$4,paused_at=now(),last_heartbeat_at=now(),updated_at=now() WHERE id=$1 AND operation_id=$2", &[&cycle,&operation,&thread,&turn]).await?;
    Ok(Some(state))
}
pub(crate) async fn fail_restore_locked(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    mut state: Value,
) -> Result<()> {
    if state["action"] != "resume" || !matches!(state["phase"].as_str(), Some("resuming" | "error"))
    {
        return Ok(());
    }
    state["phase"] = json!("error");
    state["error"] = json!({"code":"restore-failed","protectedDetails":Value::Null});
    suspension::save(tx, owner, chat, state, true).await
}

/// Ignore a revoked physical failure only under the exact persisted Task Stop.
/// This supplies cancellation ownership, not proof that native Stop completed.
pub(crate) async fn stopped_input_locked(
    tx: &Transaction<'_>,
    owner: &str,
    worker: &str,
    receipt: &Value,
    input: &Value,
) -> Result<Option<Value>> {
    let chat = text(&receipt["chatId"])?;
    context::lock_chat(tx, owner, &chat).await?;
    let row = suspension::chat(tx, owner, &chat).await?;
    let Some(saved) = suspension::read(&row)? else {
        return Ok(None);
    };
    let native = &crate::tasks::resumption::checkpoint_execution(input)["nativeExecution"];
    if saved["target"]["taskRound"].is_null()
        || saved["action"] != "stop"
        || !matches!(
            saved["phase"].as_str(),
            Some("stopping" | "stopped" | "error")
        )
        || receipt["workerId"] != worker
        || crate::tasks::resumption::physical(input)["receipt"] != *receipt
        || saved["target"]["workerId"] != receipt["workerId"]
        || saved["target"]["executionLaneId"] != receipt["executionLaneId"]
        || saved["target"]["taskRound"]["inputOperationId"] != input["receipt"]["operationId"]
        || saved["target"]["taskRound"]["operationId"] != receipt["dispatch"]["operationId"]
        || saved["target"]["taskRound"]["cycleId"] != receipt["dispatch"]["cycleId"]
        || native.is_null()
        || saved["active"]["threadId"] != native["threadId"]
        || saved["active"]["turnId"] != native["turnId"]
    {
        return Ok(None);
    }
    Ok(Some(saved))
}
