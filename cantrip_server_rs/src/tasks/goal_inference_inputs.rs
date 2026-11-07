//! Goal input authority lives on its dispatch cycle, separate from finalization.
use super::*;

fn stale<T>() -> Result<T> {
    Err(crate::task_dispatch::Conflict::stale().into())
}
fn outcome_guard(r: &Value) -> Value {
    let mut guard = r["dispatch"].clone();
    guard["kind"] = json!("outcome");
    guard["goalInferenceInputOperationId"] = r["operationId"].clone();
    guard
}
// Original physical input ownership never becomes a newer control lease.
fn physical_input(c: &Value, r: &Value) -> Result<()> {
    let state = super::resumption::goal_execution(c, r);
    let input = &state;
    if c.is_null()
        || input.is_null()
        || input["deferred"] == true
        || r["kind"] != "goal"
        || c["id"] != r["dispatch"]["cycleId"]
        || c["chat_id"] != r["chatId"]
        || c["operation_id"] != r["dispatch"]["operationId"]
        || parse(
            "taskInferenceInputReceiptSchema",
            &super::resumption::physical(input)["receipt"],
        )? != parse("taskInferenceInputReceiptSchema", r)?
    {
        return stale();
    }
    Ok(())
}
fn original_control(c: &Value, r: &Value) -> bool {
    (c["fencing_token"] == r["dispatch"]["fencingToken"]
        && c["lease_owner"] == r["dispatch"]["leaseOwner"]
        && matches!(
            c["state"].as_str(),
            Some("claimed" | "running" | "paused" | "succeeded" | "failed")
        ))
        || (c["state"] == "expired"
            && c["fencing_token"].as_i64()
                == r["dispatch"]["fencingToken"]
                    .as_i64()
                    .and_then(|n| n.checked_add(1)))
}
pub(super) async fn cycle(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    id: Option<&str>,
) -> Result<Option<Value>> {
    if !lock_user(tx, owner).await? {
        return Ok(None);
    }
    let row=one(Executor::Transaction(tx),"SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.owner_id=$1 AND c.chat_id=$2 ORDER BY c.created_at DESC,c.id DESC LIMIT 1 FOR UPDATE",&[&owner,&chat]).await?;
    Ok(row.filter(|r| id.is_none_or(|id| r["id"] == id)))
}
pub(super) async fn context(
    tx: &Transaction<'_>,
    owner: &str,
    r: &Value,
    execution: bool,
    settled: bool,
) -> Result<Value> {
    let (chat, operation, message, lane) = (
        text(&r["chatId"])?,
        text(&r["dispatch"]["operationId"])?,
        text(&r["clientMessageId"])?,
        text(&r["executionLaneId"])?,
    );
    tx.query("WITH p AS MATERIALIZED (SELECT projects.id FROM projects JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM p JOIN chats ON chats.project_id=p.id WHERE chats.id=$2 FOR UPDATE OF chats",&[&owner,&chat]).await?;
    let row=one(Executor::Transaction(tx),"SELECT jsonb_build_object('chat',to_jsonb(c),'project',to_jsonb(p),'task',to_jsonb(t),'round',to_jsonb(r),'message',to_jsonb(m))::text FROM chats c JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 JOIN tasks t ON t.chat_id=c.id JOIN task_planning_rounds r ON r.chat_id=c.id AND r.id=$3 JOIN chat_messages m ON m.chat_id=c.id AND m.id=$4 WHERE c.id=$2 LIMIT 1 FOR UPDATE OF c,t,r",&[&owner,&chat,&operation,&message]).await?;
    let Some(mut row) = row else {
        return stale();
    };
    row["lane"] = one(Executor::Transaction(tx),
        "SELECT to_jsonb(l)::text FROM chat_execution_lanes l WHERE l.chat_id=$1 AND l.id=$2 LIMIT 1 FOR UPDATE", &[&chat,&lane]).await?.unwrap_or(Value::Null);
    let (c, t, round, m, l) = (
        &row["chat"],
        &row["task"],
        &row["round"],
        &row["message"],
        &row["lane"],
    );
    if c["experience"] != "task"
        || !c["archived_at"].is_null()
        || t["plan_goal_enabled"] != true
        || t["implementation_started_at"].is_null()
        || !t["active_operation_id"].is_null()
        || (!settled && matches!(t["state"].as_str(), Some("complete" | "failed")))
        || round["kind"] != "finalize"
        || !truthy(round["relay_result"].get("goal"))
        || t["planning_round"] != round["ordinal"]
        || m["mode"] != "goal"
        || !matches!(m["role"].as_str(), Some("user" | "system"))
        || m["task_protected_content"].is_null()
        || truthy(m.get("content"))
        || (execution
            && (c["active_worker_id"] != r["workerId"]
                || c["active_worktree_id"] != r["worktreeId"]
                || l.is_null()
                || l["worker_id"] != r["workerId"]
                || l["worktree_id"] != r["worktreeId"]
                || l["activated_at"]
                    .as_js_string()
                    .and_then(crate::wire::date_milliseconds)
                    != r["executionLaneActivatedAt"]
                        .as_js_string()
                        .and_then(crate::wire::date_milliseconds)))
    {
        return stale();
    }
    Ok(row)
}
pub(super) async fn write(tx: &Transaction<'_>, id: &str, state: &Value) -> Result<()> {
    let data = state.stringify();
    tx.query(
        "UPDATE task_dispatch_cycles SET goal_input=$2::text::jsonb WHERE id=$1",
        &[&id, &data],
    )
    .await?;
    Ok(())
}
async fn handoff(tx: &Transaction<'_>, owner: &str, chat: &str) -> Result<Option<Value>> {
    one(Executor::Transaction(tx),
        "SELECT jsonb_build_object('phase',h.phase,'source',h.queued_source)::text FROM native_runtime_handoffs h WHERE owner_id=$1 AND chat_id=$2 AND phase IN ('preparing','prepared','committed') LIMIT 1",
        &[&owner,&chat]).await
}
// Reserving a transfer does not seal its source. Only that exact accepted
// input can still win dispatch until the worker confirms its withdrawal.
async fn assert_handoff_input(
    tx: &Transaction<'_>,
    owner: &str,
    receipt: &Value,
    source: bool,
) -> Result<()> {
    let Some(active) = handoff(tx, owner, &text(&receipt["chatId"])?).await? else {
        return Ok(());
    };
    if source
        && active["phase"] == "preparing"
        && truthy(active["source"].get("taskGoalInput"))
        && active["source"]["withdrawn"] != true
        && crate::native_commands::managed_queue::deep_equal(
            &active["source"]["taskGoal"]["identity"]["recovery"]["taskInput"],
            receipt,
        )
    {
        return Ok(());
    }
    stale()
}
async fn defer_locked(tx: &Transaction<'_>, owner: &str, c: &Value, state: &Value) -> Result<()> {
    if state["failedBeforeDispatch"] == true {
        return stale();
    }
    let r = &state["receipt"];
    let row = context(tx, owner, r, false, false).await?;
    let paused = row["chat"]["automation_paused"] == true
        || row["project"]["task_scheduling_paused"] == true
        || row["task"]["state"] == "paused";
    let (chat, lane, id) = (
        text(&r["chatId"])?,
        text(&r["executionLaneId"])?,
        text(&c["id"])?,
    );
    crate::chats::execution_lanes::finish_in_transaction(
        tx,
        &chat,
        &lane,
        "idle",
        &json!({"expectedActivatedAt":r["executionLaneActivatedAt"],"markUnreadCompletion":false}),
    )
    .await?;
    let now = now();
    let at = text(&now)?;
    tx.query("UPDATE chats SET status='idle',updated_at=$2::text::timestamptz WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM chat_execution_lanes WHERE chat_id=$1 AND state='active')",&[&chat,&at]).await?;
    let mut state = state.clone();
    state["deferred"] = json!(true);
    let data = state.stringify();
    tx.query("UPDATE task_dispatch_cycles SET goal_input=$2::text::jsonb,state=$3,lease_owner=NULL,lease_expires_at=NULL,last_heartbeat_at=NULL,fencing_token=fencing_token+1,claimed_at=NULL,started_at=NULL,completed_at=NULL,paused_at=CASE WHEN $3='paused' THEN $4::text::timestamptz ELSE NULL END,eligibility_code='capacity-unavailable',updated_at=$4::text::timestamptz WHERE id=$1",&[&id,&data,&if paused{"paused"}else{"queued"},&at]).await?;
    Ok(())
}
impl Repository {
    /// The Stop transaction already holds the owner/cycle/chat locks. Revoking
    /// an enforced unused input fences its before-send dispatch, not its slot.
    pub(crate) async fn defer_goal_input_for_interrupt(
        tx: &Transaction<'_>,
        owner: &str,
        cycle: &Value,
    ) -> Result<()> {
        let state = &cycle["goal_input"];
        if state.is_null()
            || state["accepted"] != true
            || state["allAttemptsEnforced"] != true
            || state["deferred"] == true
            || state["failedBeforeDispatch"] == true
            || !state["firstDispatchedOperationId"].is_null()
        {
            return Ok(());
        }
        match defer_locked(tx, owner, cycle, state).await {
            // A completed/archived/replaced Task has no reusable input. Stop
            // must still reach its actual native owner to perform cleanup.
            Err(error) if error.is::<crate::task_dispatch::Conflict>() => Ok(()),
            result => result,
        }
    }

    pub async fn goal_launch_guard(&self, owner: &str, chat: &str, lease: &Value) -> Result<Value> {
        let (owner, chat, lease) = (owner.to_owned(), chat.to_owned(), lease.clone());
        self.database.transaction(|tx|Box::pin(async move {
            dispatch_fence::assert(tx,&owner,&chat,&text(&lease["operationId"])?,&json!({"kind":"leased","lease":lease}),false).await?;
            let c=cycle(tx,&owner,&chat,Some(&text(&lease["cycleId"])?)).await?.ok_or_else(crate::task_dispatch::Conflict::stale)?;
            let placement=one(Executor::Transaction(tx),"SELECT to_jsonb(c)::text FROM chats c WHERE c.id=$1 LIMIT 1 FOR UPDATE",&[&chat]).await?.ok_or_else(crate::task_dispatch::Conflict::stale)?;
            Ok(json!({"kind":"leased","lease":lease,"goalLaunch":json!({"inputOperationId":c["goal_input"].get("receipt").and_then(|r|r.get("operationId")).unwrap_or(&Value::Null),"placementRevision":placement["placement_revision"]})}))
        })).await
    }
    /// Read-only setup can fail before Goal launch. Capture the cached
    /// finalizer and prior input, so that failure cannot retire newer execution.
    pub async fn goal_preparation_guard(
        &self,
        owner: &str,
        chat: &str,
        lease: &Value,
    ) -> Result<Option<Value>> {
        let (owner, chat, lease) = (owner.to_owned(), chat.to_owned(), lease.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let operation=text(&lease["operationId"])?;
            dispatch_fence::assert(tx,&owner,&chat,&operation,&json!({"kind":"leased","lease":lease}),false).await?;
            let c=cycle(tx,&owner,&chat,Some(&text(&lease["cycleId"])?)).await?.ok_or_else(crate::task_dispatch::Conflict::stale)?;
            let Some(round)=locked_round(tx,&chat,&operation).await? else{return Ok(None);};
            if round["kind"]!="finalize" || round["relay_result"].is_null() {return Ok(None);}
            if !c["goal_input"].is_null() && c["goal_input"]["deferred"]!=true {return stale();}
            tx.query("WITH p AS MATERIALIZED (SELECT projects.id FROM projects JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM p JOIN chats ON chats.project_id=p.id WHERE chats.id=$2 FOR UPDATE OF chats",&[&owner,&chat]).await?;
            let placement=one(Executor::Transaction(tx),"SELECT jsonb_build_object('chat',to_jsonb(c),'task',to_jsonb(t))::text FROM chats c JOIN tasks t ON t.chat_id=c.id WHERE c.id=$1 LIMIT 1 FOR UPDATE OF c,t",&[&chat]).await?.ok_or_else(crate::task_dispatch::Conflict::stale)?;
            let guard=json!({"kind":"leased","lease":lease,"goalLaunch":json!({
                "inputOperationId":c["goal_input"].get("receipt").and_then(|r|r.get("operationId")).unwrap_or(&Value::Null),
                "placementRevision":placement["chat"]["placement_revision"],
                "preparation":json!({"implementationStartedAt":placement["task"]["implementation_started_at"]})
            })});
            dispatch_fence::assert(tx,&owner,&chat,&operation,&guard,false).await?;
            Ok(Some(guard))
        })).await
    }
    pub async fn settle_goal_launch_failure(
        &self,
        owner: &str,
        chat: &str,
        guard: &Value,
    ) -> Result<Value> {
        let (owner, chat, guard) = (owner.to_owned(), chat.to_owned(), guard.clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    dispatch_fence::assert(
                        tx,
                        &owner,
                        &chat,
                        &text(&guard["lease"]["operationId"])?,
                        &guard,
                        false,
                    )
                    .await?;
                    crate::task_dispatch::Repository::settle_in(
                        Executor::Transaction(tx),
                        &guard["lease"],
                        "failed",
                        &Value::Null,
                    )
                    .await
                })
            })
            .await
    }
    /// Retires delivery on deletion/replacement or a proven no-forward deferred
    /// failure. Archive, timeout and missing notifications are not evidence.
    pub async fn goal_outcome_retirement(
        &self,
        owner: &str,
        n: &Value,
        worker: &str,
    ) -> Result<Option<&'static str>> {
        let (owner, n, worker) = (owner.to_owned(), n.clone(), worker.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            let chat=text(&n["chatId"])?;
            tx.query("WITH p AS MATERIALIZED (SELECT projects.id FROM projects JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM p JOIN chats ON chats.project_id=p.id WHERE chats.id=$2 FOR UPDATE OF chats",&[&owner,&chat]).await?;
            let row=one(Executor::Transaction(tx),"SELECT jsonb_build_object('state',m.task_goal_input)::text FROM chat_messages m JOIN chats c ON c.id=m.chat_id JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE m.id=$2 AND m.chat_id=$3 LIMIT 1 FOR UPDATE OF m,c,p",&[&owner,&text(&n["clientMessageId"])?,&chat]).await?;
            let Some(row)=row else{return Ok(Some("canonical-input-deleted"));};
            let current=cycle(tx,&owner,&chat,None).await?;
            let canonical=current.as_ref().map(|c|&c["goal_input"]).filter(|s| !s.is_null() && s["receipt"]==row["state"]["receipt"]).unwrap_or(&row["state"]);
            let physical=super::resumption::physical(canonical);
            if let Ok(receipt)=parse("taskInferenceInputReceiptSchema",&physical["receipt"])
                && receipt["kind"]=="goal" && receipt["chatId"]==n["chatId"] && receipt["clientMessageId"]==n["clientMessageId"]
                && receipt["operationId"]!=n["taskInferenceInputOperationId"] {
                return Ok(Some("canonical-input-replaced"));
            }
            if let Ok(receipt)=parse("taskInferenceInputReceiptSchema",&physical["receipt"])
                && n["outcome"]["ok"]==false && row["state"]["deferred"]==true && row["state"]["accepted"]==true && row["state"]["allAttemptsEnforced"]==true && row["state"].get("firstDispatchedOperationId").is_some_and(Value::is_null)
                && (row["state"]["failedBeforeDispatch"]==true || (n["outcome"]["inference"]["disposition"]=="input-not-dispatched" && n["outcome"]["inference"]["operationId"]==receipt["operationId"] && n["outcome"]["inference"]["providerId"]==receipt["providerId"] && n["outcome"]["inference"]["chatId"]==receipt["chatId"] && n["outcome"]["inference"]["messageId"]==receipt["clientMessageId"]))
                && receipt["operationId"]==n["taskInferenceInputOperationId"] && receipt["workerId"]==worker.as_str() && receipt["clientMessageId"]==n["clientMessageId"] {
                return Ok(Some("canonical-input-deferred"));
            }
            Ok(None)
        })).await
    }

    pub async fn apply_goal_input_outcome(
        &self,
        owner: &str,
        worker: &str,
        n: &Value,
        record_only: bool,
    ) -> Result<Option<Value>> {
        if !truthy(n.get("taskDispatchFence")) || !truthy(n.get("taskInferenceInputOperationId")) {
            return Ok(None);
        }
        let (owner, worker, n) = (owner.to_owned(), worker.to_owned(), n.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let f=&n["taskDispatchFence"];
            let chat=text(&n["chatId"])?;
            let c=cycle(tx,&owner,&chat,Some(&text(&f["cycleId"])?)).await?;
            let Some(c)=c else{return super::goal_input_history::recover(tx,&owner,&worker,&n).await;};
            let state=super::resumption::goal_execution(&c,&super::resumption::goal_receipt(&c,Some(&n["taskInferenceInputOperationId"])));
            let s=&state;let physical=super::resumption::physical(s);let r=&physical["receipt"];
            if s.is_null() || r["operationId"]!=n["taskInferenceInputOperationId"] {return super::goal_input_history::recover(tx,&owner,&worker,&n).await;}
            if s["deferred"]==true || (n["outcome"]["ok"]==true && (physical["accepted"]!=true || physical["dispatched"]!=true || s["failedBeforeDispatch"]==true)) || r["workerId"]!=worker.as_str()
                || r["clientMessageId"]!=n["clientMessageId"] || r["executionLaneId"]!=n["executionLaneId"]
                || r["worktreeId"]!=n["worktreeId"] || r["dispatch"]["cycleId"]!=f["cycleId"] || r["dispatch"]["operationId"]!=f["operationId"]
                || r["dispatch"]["fencingToken"]!=f["fencingToken"] || r["dispatch"]["leaseOwner"]!=f["leaseOwner"] {return stale();}
            physical_input(&c,r)?;
            let owns_control=original_control(&c,r);
            let row=match context(tx,&owner,r,true,true).await {
                Ok(row)=>row,
                Err(e) if e.downcast_ref::<crate::task_dispatch::Conflict>().is_some()=>return super::goal_input_history::recover(tx,&owner,&worker,&n).await,
                Err(e)=>return Err(e),
            };
            if n["outcome"]["ok"] != true {
                let retained = if let Some(stopped) = crate::native_commands::task_suspension::stopped_input_locked(tx,&owner,&worker,r,s).await? {Some(stopped)}
                    else {crate::native_commands::task_suspension::retain_locked(tx,&owner,&worker,&chat,&r["dispatch"],&r["executionLaneId"],&r["clientMessageId"]).await?};
                if let Some(saved) = retained {
                    crate::native_commands::task_suspension::fail_restore_locked(tx,&owner,&chat,saved).await?;
                    return Ok(Some(json!({"retained":true,"receipt":r,"terminal":Value::Null,"message":Value::Null,"finished":false,"historyOnly":true,
                        "chat":json!({"projectId":row["chat"]["project_id"],"experience":row["chat"]["experience"]})})));
                }
            }
            let response_key=if s["publication"]["idempotencyKey"].is_null() {format!("assistant:{}",text(&r["clientMessageId"])?)} else {text(&s["publication"]["idempotencyKey"])?};
            let message=if n["outcome"]["ok"]==true {
                parse("taskMessageRelayResultSchema",&n["outcome"]["result"]["structuredResult"]).ok()
                    .filter(|result|result["message"]["idempotencyKey"]==response_key.as_str() && (s["publication"].is_null() || result["message"]["id"]==s["publication"]["id"]))
                    .map(|result|result["message"].clone())
            } else {None};
            let ok=n["outcome"]["ok"]==true && message.is_some();
            let failure=if ok {Value::Null} else {
                let error=if n["outcome"]["ok"]==true {json!({"message":"Task Goal outcome omitted its canonical protected response."})}else{json!({"message":n["outcome"]["error"]})};
                json!(super::failure_kind::classify(&error))
            };
            if !s["terminal"].is_null() && (s["terminal"]["ok"]!=ok || s["terminal"]["failureKind"]!=failure) {return stale();}
            let terminal=if !s["terminal"].is_null() {s["terminal"].clone()} else {json!({"ok":ok,"failureKind":failure,"observedAt":now(),"projectedAt":Value::Null,
                "threadId":if n["outcome"]["ok"]==true{n["outcome"]["result"]["threadId"].clone()}else{row["lane"]["codex_thread_id"].clone()},
                "turnId":if n["outcome"]["ok"]==true{n["outcome"]["result"]["turnId"].clone()}else{n["outcome"]["inference"]["turnId"].clone()}})};
            let saved=if let Some(message)=message {
                Some(crate::chats::message_writes::append_task_with(Executor::Transaction(tx),&owner,&chat,&message,
                    Some(&json!({"executionLaneId":r["executionLaneId"],"worktreeId":r["worktreeId"]}))).await?.ok_or_else(crate::task_dispatch::Conflict::stale)?)
            }else{None};
            if s["terminal"].is_null() {let mut state=s.clone();state["terminal"]=terminal.clone();super::resumption::save_goal_execution(tx,&c,r,&state).await?;}
            if n["outcome"]["ok"] == true && !physical["nativeExecution"].is_null() &&
                n["outcome"]["result"]["threadId"] == physical["nativeExecution"]["threadId"] &&
                n["outcome"]["result"]["turnId"] == physical["nativeExecution"]["turnId"] {
                crate::native_commands::task_suspension::retire_locked(tx,&owner,&s["receipt"],physical,
                    &json!({"threadId":n["outcome"]["result"]["threadId"],"turnId":n["outcome"]["result"]["turnId"]}),if ok {"completed"}else{"failed"}).await?;
            }
            if owns_control && !ok && s["accepted"]==true && s["allAttemptsEnforced"]==true && s["firstDispatchedOperationId"].is_null()
                && s["failedBeforeDispatch"]!=true && (row["chat"]["automation_paused"]==true || row["project"]["task_scheduling_paused"]==true || row["task"]["state"]=="paused") {
                let mut state=s.clone();state["terminal"]=terminal.clone();defer_locked(tx,&owner,&c,&state).await?;
                return Ok(Some(json!({"receipt":r,"terminal":terminal,"message":saved,"finished":true,"historyOnly":false,"chat":json!({"projectId":row["chat"]["project_id"],"experience":row["chat"]["experience"]})})));
            }
            if record_only || !owns_control {return Ok(Some(json!({"receipt":r,"terminal":terminal,"message":saved,"finished":false,"historyOnly":false,"chat":json!({"projectId":row["chat"]["project_id"],"experience":row["chat"]["experience"]})})));}
            let lane=text(&r["executionLaneId"])?;
            if n["outcome"]["ok"]==true {crate::chats::execution_lanes::update_runtime_in_transaction(tx,&chat,&lane,n["outcome"]["result"]["threadId"].as_str(),"ready").await?;}
            let finished=crate::chats::execution_lanes::finish_in_transaction(tx,&chat,&lane,if ok{"idle"}else{"failed"},
                &json!({"expectedActivatedAt":r["executionLaneActivatedAt"]})).await?;
            let at=crate::auth::now();
            tx.query("UPDATE agent_interaction_requests SET status='interrupted',resolved_at=$1,updated_at=$1 WHERE chat_id=$2 AND execution_lane_id=$3 AND status='pending'",&[&at,&chat,&lane]).await?;
            Ok(Some(json!({"receipt":r,"terminal":terminal,"message":saved,"finished":finished,"historyOnly":false,"chat":json!({"projectId":row["chat"]["project_id"],"experience":row["chat"]["experience"]})})))
        })).await
    }
    pub async fn goal_input_terminal(
        &self,
        owner: &str,
        chat: &str,
        expected: Option<&Value>,
    ) -> Result<Option<Value>> {
        let (owner, chat, expected) = (owner.to_owned(), chat.to_owned(), expected.cloned());
        let result=self.database.transaction(|tx|Box::pin(async move {
            let c=cycle(tx,&owner,&chat,expected.as_ref().and_then(|r|r["dispatch"]["cycleId"].as_str())).await?;
            let Some(c)=c else{return Ok(None);};
            let state=super::resumption::goal_execution(&c,&expected.clone().unwrap_or_else(||super::resumption::goal_receipt(&c,None)));
            let s=&state;let r=&super::resumption::physical(s)["receipt"];
            if s["terminal"].is_null() || !s["terminal"]["projectedAt"].is_null() || s["deferred"]==true {return Ok(None);}
            if let Some(expected)=expected
                && parse("taskInferenceInputReceiptSchema",&expected)?!=parse("taskInferenceInputReceiptSchema",r)? {return Ok(None);}
            physical_input(&c,r)?;
            let mut guard=outcome_guard(r);
            let row=context(tx,&owner,r,true,true).await?;
            if !s["terminal"]["threadId"].is_null() && row["lane"]["codex_thread_id"]!=s["terminal"]["threadId"] {return stale();}
            guard["goalProjection"]=json!({"terminalObservedAt":s["terminal"]["observedAt"],"control":json!({"fencingToken":c["fencing_token"],"leaseOwner":c["lease_owner"],"state":c["state"]}),"placementRevision":row["chat"]["placement_revision"],"automationPaused":row["chat"]["automation_paused"],
                "taskSchedulingPaused":row["project"]["task_scheduling_paused"],"threadId":row["lane"]["codex_thread_id"]});
            dispatch_fence::assert(tx,&owner,&chat,&text(&guard["operationId"])?,&guard,false).await?;
            Ok(Some(json!({"receipt":r,"terminal":s["terminal"],"guard":guard,
                "failedBeforeDispatch":s["failedBeforeDispatch"]==true && s["firstDispatchedOperationId"].is_null()})))
        })).await;
        match result {
            Err(e) if e.downcast_ref::<crate::task_dispatch::Conflict>().is_some() => Ok(None),
            other => other,
        }
    }

    pub async fn finish_goal_input_projection(
        &self,
        owner: &str,
        r: &Value,
        version: &Value,
        projection: &Value,
        execution: &Value,
    ) -> Result<Value> {
        let (owner, r, version) = (owner.to_owned(), r.clone(), version.clone());
        let (projection, execution) = (projection.clone(), execution.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let chat=text(&r["chatId"])?;let mut guard=outcome_guard(&r);
            guard["goalProjection"]=projection.clone();
            dispatch_fence::assert(tx,&owner,&chat,&text(&guard["operationId"])?,&guard,false).await?;
            let c=cycle(tx,&owner,&chat,Some(&text(&r["dispatch"]["cycleId"])?)).await?.ok_or_else(crate::task_dispatch::Conflict::stale)?;
            let state=super::resumption::goal_execution(&c,&r);let s=&state;
            if s["terminal"].is_null() || !s["terminal"]["projectedAt"].is_null() || s["deferred"]==true {return stale();}
            let row=context(tx,&owner,&r,true,true).await?;
            let task=&row["task"];
            if (execution.is_null() && !(s["failedBeforeDispatch"]==true && s["firstDispatchedOperationId"].is_null() && task["state"]=="failed")) ||
                (!execution.is_null() && !projection["threadId"].is_null() && execution["threadId"]!=projection["threadId"]) || task["row_version"]!=version || (!s["terminal"]["threadId"].is_null() && row["lane"]["codex_thread_id"]!=s["terminal"]["threadId"]) {return stale();}
            // Keep an unconfirmed paused receipt available for later reconciliation.
            if task["state"]=="paused" && (execution["status"]!="idle" || execution["pausedAndIdleRevision"]!=row["chat"]["managed_input_revision"]) {return stale();}
            if task["state"]=="failed" {
                super::retries::note_failure_in(tx,&owner,&chat,&format!("goal-input:{}",text(&r["operationId"])?),
                    super::failure_kind::classify(&task["last_error"]["code"]),&guard).await?;
            }else if matches!(task["state"].as_str(),Some("complete"|"blocked")) {
                super::retries::clear_pending_in(tx,&owner,&chat,&guard).await?;
            }
            if execution["status"]!="running" && (matches!(task["state"].as_str(),Some("complete"|"blocked"|"failed")) || (task["state"]=="paused" && execution["status"]=="idle")) {
                let mut options=json!({"expectedActivatedAt":r["executionLaneActivatedAt"]});
                if task["state"]=="paused" {options["markUnreadCompletion"]=json!(false);}
                crate::chats::execution_lanes::finish_in_transaction(tx,&chat,&text(&r["executionLaneId"])?,
                    if task["state"]=="failed"{"failed"}else{"idle"},&options).await?;
            }
            let mut state=s.clone();state["terminal"]["projectedAt"]=now();
            let id=text(&c["id"])?;super::resumption::save_goal_execution(tx,&c,&r,&state).await?;
            if matches!(task["state"].as_str(),Some("complete"|"blocked"|"failed")) {
                let at=crate::auth::now();
                tx.query("UPDATE task_dispatch_cycles SET state=$2,completed_at=$3,eligibility_code=NULL,updated_at=$3 WHERE id=$1",&[&id,&if task["state"]=="failed"{"failed"}else{"succeeded"},&at]).await?;
            }
            Ok(task["state"].clone())
        })).await
    }
    pub async fn goal_input_receipt_for_turn(
        &self,
        owner: &str,
        chat: &str,
        lease: &Value,
        turn: &Value,
    ) -> Result<Option<Value>> {
        let (owner, chat, lease, turn) = (
            owner.to_owned(),
            chat.to_owned(),
            lease.clone(),
            turn.clone(),
        );
        let result = self
            .database
            .transaction(|tx| {
                Box::pin(async move {
                    let c = cycle(tx, &owner, &chat, Some(&text(&lease["cycleId"])?)).await?;
                    let Some(c) = c else {
                        return Ok(None);
                    };
                    let state = super::resumption::goal_execution(
                        &c,
                        &super::resumption::goal_receipt(&c, None),
                    );
                    let s = &state;
                    let r = &super::resumption::physical(s)["receipt"];
                    if s.is_null()
                        || s["deferred"] == true
                        || r["clientMessageId"] != turn["clientMessageId"]
                        || r["executionLaneId"] != turn["executionLaneId"]
                        || r["executionLaneActivatedAt"] != turn["executionLaneActivatedAt"]
                        || r["dispatch"]["operationId"] != lease["operationId"]
                        || r["dispatch"]["fencingToken"] != lease["fencingToken"]
                        || r["dispatch"]["leaseOwner"] != lease["leaseOwner"]
                    {
                        return Ok(None);
                    }
                    physical_input(&c, r)?;
                    context(tx, &owner, r, true, true).await?;
                    Ok(Some(r.clone()))
                })
            })
            .await;
        match result {
            Err(e) if e.downcast_ref::<crate::task_dispatch::Conflict>().is_some() => Ok(None),
            other => other,
        }
    }
    pub async fn pause_goal_input(
        &self,
        owner: &str,
        receipt: &Value,
        thread: &Value,
    ) -> Result<Value> {
        let (owner, r, thread) = (owner.to_owned(), receipt.clone(), thread.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let guard=json!({"kind":"leased","lease":r["dispatch"],"goalInferenceInputOperationId":r["operationId"]});
            dispatch_fence::assert(tx,&owner,&text(&r["chatId"])?,&text(&r["dispatch"]["operationId"])?,&guard,true).await?;
            crate::task_dispatch::Repository::pause_in(Executor::Transaction(tx),&r["dispatch"],&json!({"threadId":thread,"turnId":Value::Null}),&Value::Null,false).await
        })).await
    }
    pub async fn prepare_goal_inference_input(&self, owner: &str, input: &Value) -> Result<Value> {
        self.prepare_goal_inference_input_at_revision(owner, input, None, None)
            .await
    }

    pub async fn prepare_goal_inference_input_at_revision(
        &self,
        owner: &str,
        input: &Value,
        expected_revision: Option<i64>,
        publication: Option<&Value>,
    ) -> Result<Value> {
        let mut r = input.clone();
        r["kind"] = json!("goal");
        r["operationId"] = json!(uuid::Uuid::new_v4().to_string());
        let mut r = parse("taskInferenceInputReceiptSchema", &r)?;
        let owner = owner.to_owned();
        let publication = publication.cloned();
        let prepared = self.database.transaction(|tx|Box::pin(async move {
            let (chat,id,operation)=(text(&r["chatId"])?,text(&r["dispatch"]["cycleId"])?,text(&r["dispatch"]["operationId"])?);
            dispatch_fence::assert(tx,&owner,&chat,&operation,&json!({"kind":"leased","lease":r["dispatch"]}),false).await?;
            let c=cycle(tx,&owner,&chat,Some(&id)).await?.ok_or_else(crate::task_dispatch::Conflict::stale)?;
            if c["operation_kind"]!="finalize" || c["physical_worker_id"]!=r["workerId"] || c["worktree_id"]!=r["worktreeId"] {return stale();}
            r["queueOrderEpoch"]=c["goal_order_epoch"].clone();
            let row=context(tx,&owner,&r,true,false).await?;
            assert_handoff_input(tx,&owner,&r,false).await?;
            let control_changed=expected_revision.is_some_and(|revision|row["chat"]["managed_input_revision"].as_i64()!=Some(revision));
            if row["lane"]["state"]!="active" || (!control_changed && (row["chat"]["automation_paused"]==true || row["project"]["task_scheduling_paused"]==true || row["task"]["state"]=="paused")) {return stale();}
            let old=&c["goal_input"];
            if old["failedBeforeDispatch"]==true && old["receipt"]["dispatch"]["fencingToken"]==r["dispatch"]["fencingToken"] {return stale();}
            let same=old["receipt"]["clientMessageId"]==r["clientMessageId"];
            let mut state=json!({"receipt":r,"deferred":false,"failedBeforeDispatch":false,"accepted":false,"dispatched":false,"allAttemptsEnforced":!same || (old["allAttemptsEnforced"]==true && (old["accepted"]==true || old["deferred"]==true)),"firstDispatchedOperationId":if same{old["firstDispatchedOperationId"].clone()}else{Value::Null},"multipleDispatched":same && old["multipleDispatched"]==true,"attemptCountBefore":c["attempt_count"]});
            if let Some(publication) = publication {state["publication"] = publication;}
            if same && let Some(change)=old.get("routeChange") {state["routeChange"]=change.clone();}
            if control_changed && (state["allAttemptsEnforced"]!=true || !state["firstDispatchedOperationId"].is_null()) {return stale();}
            write(tx,&id,&state).await?;
            tx.query("UPDATE task_dispatch_cycles SET model_route_id=$2,provider_account_id=$3 WHERE id=$1",&[&id,&text(&r["modelRouteId"])?,&r["providerAccountId"].as_str()]).await?;
            if control_changed {
                defer_locked(tx,&owner,&c,&state).await?;
                return Ok(Value::Null);
            }
            Ok(r)
        })).await?;
        if prepared.is_null() {
            return stale();
        }
        Ok(prepared)
    }
    pub async fn dispatch_goal_inference_input(
        &self,
        owner: &str,
        worker: &str,
        r: &Value,
        phase: &str,
        metadata: Option<&Value>,
    ) -> Result<Value> {
        if r["workerId"] != worker {
            return stale();
        }
        let (owner, r, phase) = (owner.to_owned(), r.clone(), phase.to_owned());
        let metadata = metadata.cloned().unwrap_or(Value::Null);
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let (chat, id, operation) = (
                        text(&r["chatId"])?,
                        text(&r["dispatch"]["cycleId"])?,
                        text(&r["dispatch"]["operationId"])?,
                    );
                    dispatch_fence::assert(
                        tx,
                        &owner,
                        &chat,
                        &operation,
                        &json!({"kind":"leased","lease":r["dispatch"]}),
                        false,
                    )
                    .await?;
                    let c = cycle(tx, &owner, &chat, Some(&id))
                        .await?
                        .ok_or_else(crate::task_dispatch::Conflict::stale)?;
                    let mut s = super::resumption::goal_execution(&c, &r);
                    if s.is_null()
                        || s["deferred"] == true
                        || s["failedBeforeDispatch"] == true
                        || !s["terminal"].is_null()
                        || super::resumption::physical(&s)["receipt"] != r
                    {
                        return stale();
                    }
                    let mut row = context(tx, &owner, &r, true, false).await?;
                    assert_handoff_input(tx, &owner, &r, true).await?;
                    let resumed = !s["resumption"].is_null();
                    if resumed {
                        let current =
                            crate::native_commands::suspension::chat(tx, &owner, &chat).await?;
                        let saved = crate::native_commands::suspension::read(&current)?
                            .ok_or_else(crate::task_dispatch::Conflict::stale)?;
                        if saved["controlId"] != s["resumption"]["controlId"]
                            || saved["action"] != "resume"
                            || !(saved["phase"] == "resuming"
                                || (phase == "native" && saved["phase"] == "running"))
                        {
                            return stale();
                        }
                    }
                    if phase == "native" {
                        row["goal_input"] = s.clone();
                        return super::native_input_binding::bind(tx, &owner, &r, &row, &metadata)
                            .await;
                    }
                    let mut execution = super::resumption::physical(&s).clone();
                    if execution["dispatched"] == true
                        || (row["chat"]["automation_paused"] == true && !resumed)
                        || row["project"]["task_scheduling_paused"] == true
                        || (row["task"]["state"] == "paused" && !resumed)
                        || row["lane"]["state"] != "active"
                    {
                        return stale();
                    }
                    if phase == "accepted" || phase == "claim" {
                        if phase == "claim" && execution["accepted"] == true {
                            return stale();
                        }
                        execution["accepted"] = json!(true);
                        if phase == "claim" && !metadata["workerGeneration"].is_null() {
                            execution["claimWorkerGeneration"] =
                                metadata["workerGeneration"].clone();
                        }
                    } else {
                        if execution["accepted"] != true {
                            return stale();
                        }
                        execution["dispatched"] = json!(true);
                        if !resumed {
                            s["multipleDispatched"] = json!(
                                s["multipleDispatched"] == true
                                    || (!s["firstDispatchedOperationId"].is_null()
                                        && s["firstDispatchedOperationId"] != r["operationId"])
                            );
                            if s["firstDispatchedOperationId"].is_null() {
                                s["firstDispatchedOperationId"] = r["operationId"].clone();
                            }
                        }
                    }
                    if resumed {
                        s["resumption"] = execution;
                    } else {
                        s["accepted"] = execution["accepted"].clone();
                        s["dispatched"] = execution["dispatched"].clone();
                        s["claimWorkerGeneration"] = execution["claimWorkerGeneration"].clone();
                    }
                    super::resumption::save_goal_execution(tx, &c, &r, &s).await?;
                    Ok(json!({"receipt":r}))
                })
            })
            .await
    }
    pub async fn defer_goal_inference_input(
        &self,
        owner: &str,
        chat: &str,
        guard: &Value,
    ) -> Result<Option<bool>> {
        let (owner, chat, guard) = (owner.to_owned(), chat.to_owned(), guard.clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let leased = guard["kind"] == "leased";
                    let f = if leased { &guard["lease"] } else { &guard };
                    let c = cycle(tx, &owner, &chat, Some(&text(&f["cycleId"])?)).await?;
                    let Some(c) = c else {
                        return Ok(None);
                    };
                    let s = &c["goal_input"];
                    if s.is_null() {
                        return Ok(None);
                    }
                    if leased
                        && !matches!(c["state"].as_str(), Some("claimed" | "running" | "paused"))
                    {
                        return Ok(Some(false));
                    }
                    dispatch_fence::assert(
                        tx,
                        &owner,
                        &chat,
                        &text(&f["operationId"])?,
                        &guard,
                        leased,
                    )
                    .await?;
                    if s["accepted"] != true
                        || s["allAttemptsEnforced"] != true
                        || s["deferred"] == true
                        || s["failedBeforeDispatch"] == true
                        || !s["firstDispatchedOperationId"].is_null()
                    {
                        return Ok(Some(false));
                    }
                    let old = &s["receipt"]["dispatch"];
                    if old["cycleId"] != f["cycleId"]
                        || old["operationId"] != f["operationId"]
                        || old["fencingToken"].as_i64().context("Goal input fence")?
                            + if leased { 0 } else { 1 }
                            != f["fencingToken"].as_i64().context("Goal dispatch fence")?
                        || (leased && old["leaseOwner"] != f["leaseOwner"])
                    {
                        return Ok(Some(false));
                    }
                    defer_locked(tx, &owner, &c, s).await?;
                    Ok(Some(true))
                })
            })
            .await
    }
    pub async fn record_goal_inference_failure(
        &self,
        owner: &str,
        worker: &str,
        proof: &Value,
    ) -> Result<()> {
        if proof["disposition"] != "input-not-dispatched" {
            return Ok(());
        }
        let (owner, worker, proof) = (owner.to_owned(), worker.to_owned(), proof.clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let c = cycle(tx, &owner, &text(&proof["chatId"])?, None).await?;
                    let Some(c) = c else {
                        return Ok(());
                    };
                    let s = &c["goal_input"];
                    let r = &s["receipt"];
                    if s.is_null()
                        || s["deferred"] == true
                        || r["operationId"] != proof["operationId"]
                        || r["clientMessageId"] != proof["messageId"]
                        || r["providerId"] != proof["providerId"]
                        || r["workerId"] != worker.as_str()
                    {
                        return Ok(());
                    }
                    let f = &r["dispatch"];
                    let current = (c["fencing_token"] == f["fencingToken"]
                        && c["lease_owner"] == f["leaseOwner"]
                        && matches!(c["state"].as_str(), Some("claimed" | "running")))
                        || (c["state"] == "expired"
                            && c["fencing_token"].as_i64().context("Goal dispatch fence")?
                                == f["fencingToken"].as_i64().context("Goal input fence")? + 1);
                    if !current {
                        return Ok(());
                    }
                    match context(tx, &owner, r, false, false).await {
                        Ok(_) => {}
                        Err(e) if e.is::<crate::task_dispatch::Conflict>() => return Ok(()),
                        Err(e) => return Err(e),
                    };
                    let mut s = s.clone();
                    s["failedBeforeDispatch"] = json!(true);
                    write(tx, &text(&c["id"])?, &s).await
                })
            })
            .await
    }
    pub async fn reconcile_goal_inference_input(
        &self,
        owner: &str,
        input: &Value,
    ) -> Result<Value> {
        let record = &input["record"];
        let r = &record["identity"]["recovery"]["taskInput"];
        let result = |disposition: &str, no_input: bool| {
            let mut v = json!({"key":record["key"],"disposition":disposition,"chatId":r["chatId"]});
            if no_input {
                v["taskInputNotDispatched"] = json!(true);
            }
            v
        };
        if r["kind"] != "goal"
            || r["workerId"] != input["workerId"]
            || r["operationId"] != record["identity"]["operationId"]
            || r["chatId"] != record["identity"]["chatId"]
            || r["clientMessageId"] != record["identity"]["recovery"]["messageId"]
            || r["providerId"] != record["identity"]["providerId"]
        {
            return Ok(result("unresolved", false));
        }
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let record=&input["record"];let r=&record["identity"]["recovery"]["taskInput"];
            let result=|disposition:&str,no_input:bool|{let mut v=json!({"key":record["key"],"disposition":disposition,"chatId":r["chatId"]});if no_input{v["taskInputNotDispatched"]=json!(true);}v};
            let c=cycle(tx,&owner,&text(&r["chatId"])?,Some(&text(&r["dispatch"]["cycleId"])?)).await?;
            // Retire only an ended old queue episode, never a current live
            // holder. A fresh input still needs its own canonical dispatch.
            if let Some(c)=&c
                && r["queueOrderEpoch"].as_i64().unwrap_or(0)!=c["goal_order_epoch"].as_i64().context("Goal queue order")?
                && (record["workerGeneration"]!=input["workerGeneration"] || record["state"]=="released") {return Ok(result("retired",false));}
            if record["workerGeneration"]==input["workerGeneration"] && !(record["state"]=="released" && record["outcome"]=="never-started") {return Ok(result("unresolved",false));}
            let Some(c)=c else{return Ok(result("retired",false));};
            let mut s=c["goal_input"].clone();
            if s.is_null() || !matches!(c["state"].as_str(),Some("claimed"|"running"|"queued"|"paused"|"expired")) || s["failedBeforeDispatch"]==true || s["receipt"]["clientMessageId"]!=r["clientMessageId"] || s["receipt"]["workerId"]!=input["workerId"] || s["receipt"]["providerId"]!=r["providerId"]{return Ok(result("retired",false));}
            if s["accepted"]!=true || s["allAttemptsEnforced"]!=true{return Ok(result("unresolved",false));}
            if handoff(tx,&owner,&text(&r["chatId"])?).await?.is_some(){return Ok(result("unresolved",false));}
            if s["routeChange"]["phase"]=="completed" {
                let route=one(Executor::Transaction(tx),"SELECT to_jsonb(r)::text FROM model_routes r WHERE id=$1",&[&text(&s["routeChange"]["targetModelRouteId"])?]).await?;
                if route.as_ref().is_none_or(|route|route.get("provider_id")!=record["identity"].get("providerId")){return Ok(result("retired",false));}
            }
            if !s["firstDispatchedOperationId"].is_null(){
                let never_started=(record["everGranted"]==false && record["state"]!="granted") || (record["state"]=="released" && record["outcome"]=="never-started");
                if s["firstDispatchedOperationId"]!=r["operationId"] || s["multipleDispatched"]==true || !never_started{return Ok(result("unresolved",false));}
                s["firstDispatchedOperationId"]=Value::Null;write(tx,&text(&c["id"])?,&s).await?;
            }
            let row=match context(tx,&owner,&s["receipt"],false,false).await{Ok(v)=>v,Err(e) if e.is::<crate::task_dispatch::Conflict>()=>return Ok(result("retired",false)),Err(e)=>return Err(e)};
            let paused=row["chat"]["automation_paused"]==true || row["project"]["task_scheduling_paused"]==true || row["task"]["state"]=="paused";
            if s["deferred"]==true || s["receipt"]["operationId"]!=r["operationId"]{return Ok(result(if paused || c["state"]=="paused"{"retired"}else{"requeued"},true));}
            let f=&s["receipt"]["dispatch"];
            if !((c["fencing_token"]==f["fencingToken"] && c["lease_owner"]==f["leaseOwner"] && matches!(c["state"].as_str(),Some("claimed"|"running"))) || (c["state"]=="expired" && c["fencing_token"].as_i64().context("Goal dispatch fence")?==f["fencingToken"].as_i64().context("Goal input fence")?+1)){return Ok(result("retired",false));}
            defer_locked(tx,&owner,&c,&s).await?;Ok(result(if paused{"retired"}else{"requeued"},true))
        })).await
    }
    pub async fn pending_goal_inference_input(
        &self,
        owner: &str,
        chat: &str,
        id: Option<&str>,
    ) -> Result<Option<Value>> {
        let (owner, chat, id) = (owner.to_owned(), chat.to_owned(), id.map(str::to_owned));
        self.database.transaction(|tx|Box::pin(async move {
            let c=cycle(tx,&owner,&chat,id.as_deref()).await?;let Some(c)=c else{return Ok(None);};let s=&c["goal_input"];
            if s.is_null() || !matches!(c["state"].as_str(),Some("claimed"|"running"|"queued"|"paused"|"expired")) || s["failedBeforeDispatch"]==true || !s["firstDispatchedOperationId"].is_null(){return Ok(None);}
            let row=match context(tx,&owner,&s["receipt"],false,false).await{Ok(v)=>v,Err(e) if e.is::<crate::task_dispatch::Conflict>()=>return Ok(None),Err(e)=>return Err(e)};let m=&row["message"];
            let message=parse("taskMessageOpaqueContentSchema",&json!({"id":m["id"],"classification":json!({"role":m["role"],"mode":m["mode"],"attachmentIds":m["task_attachment_ids"]}),"protectedContent":m["task_protected_content"],"reasoningEffort":m["reasoning_effort"],"idempotencyKey":m["idempotency_key"]}))?;
            Ok(Some(json!({"receipt":s["receipt"],"deferred":s["deferred"],"message":message})))
        })).await
    }
}
