//! Goal input authority lives on its dispatch cycle, separate from finalization.
use super::*;

fn stale<T>() -> Result<T> {
    Err(crate::task_dispatch::Conflict::stale().into())
}
async fn cycle(
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
async fn context(
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
async fn write(tx: &Transaction<'_>, id: &str, state: &Value) -> Result<()> {
    let data = state.stringify();
    tx.query(
        "UPDATE task_dispatch_cycles SET goal_input=$2::text::jsonb WHERE id=$1",
        &[&id, &data],
    )
    .await?;
    Ok(())
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
    pub async fn apply_goal_input_outcome(
        &self,
        owner: &str,
        worker: &str,
        n: &Value,
    ) -> Result<Option<Value>> {
        if !truthy(n.get("taskDispatchFence")) || !truthy(n.get("taskInferenceInputOperationId")) {
            return Ok(None);
        }
        let (owner, worker, n) = (owner.to_owned(), worker.to_owned(), n.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let f=&n["taskDispatchFence"];
            let chat=text(&n["chatId"])?;
            let c=cycle(tx,&owner,&chat,Some(&text(&f["cycleId"])?)).await?;
            let Some(c)=c else{return Ok(None);};
            let s=&c["goal_input"];let r=&s["receipt"];
            if s.is_null() || r["operationId"]!=n["taskInferenceInputOperationId"] {return Ok(None);}
            if s["deferred"]==true || r["workerId"]!=worker.as_str()
                || r["clientMessageId"]!=n["clientMessageId"] || r["executionLaneId"]!=n["executionLaneId"]
                || r["worktreeId"]!=n["worktreeId"] || r["dispatch"]["operationId"]!=f["operationId"]
                || r["dispatch"]["fencingToken"]!=f["fencingToken"] || r["dispatch"]["leaseOwner"]!=f["leaseOwner"] {return stale();}
            dispatch_fence::assert(tx,&owner,&chat,&text(&f["operationId"])?,
                &json!({"kind":"leased","lease":f,"goalInferenceInputOperationId":r["operationId"]}),true).await?;
            let row=context(tx,&owner,r,true,true).await?;
            let ok=n["outcome"]["ok"]==true;
            let saved=if ok {
                let result=parse("taskMessageRelayResultSchema",&n["outcome"]["result"]["structuredResult"])?;
                let m=&result["message"];
                anyhow::ensure!(m["classification"]["role"]=="assistant" && m["idempotencyKey"]==format!("assistant:{}",text(&r["clientMessageId"])?),"Task Goal outcome does not match its canonical response.");
                Some(crate::chats::message_writes::append_task_with(Executor::Transaction(tx),&owner,&chat,m,
                    Some(&json!({"executionLaneId":r["executionLaneId"],"worktreeId":r["worktreeId"]}))).await?.ok_or_else(crate::task_dispatch::Conflict::stale)?)
            }else{None};
            let lane=text(&r["executionLaneId"])?;
            if ok {crate::chats::execution_lanes::update_runtime_in_transaction(tx,&chat,&lane,n["outcome"]["result"]["threadId"].as_str(),"ready").await?;}
            let finished=crate::chats::execution_lanes::finish_in_transaction(tx,&chat,&lane,if ok{"idle"}else{"failed"},
                &json!({"expectedActivatedAt":r["executionLaneActivatedAt"]})).await?;
            Ok(Some(json!({"receipt":r,"message":saved,"finished":finished,"chat":json!({"projectId":row["chat"]["project_id"],"experience":row["chat"]["experience"]})})))
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
        self.database.transaction(|tx|Box::pin(async move {
            let c=cycle(tx,&owner,&chat,Some(&text(&lease["cycleId"])?)).await?;
            let Some(c)=c else{return Ok(None);};let s=&c["goal_input"];let r=&s["receipt"];
            if s.is_null() || s["deferred"]==true || r["clientMessageId"]!=turn["clientMessageId"]
                || r["executionLaneId"]!=turn["executionLaneId"] || r["executionLaneActivatedAt"]!=turn["executionLaneActivatedAt"]
                || r["dispatch"]["operationId"]!=lease["operationId"] || r["dispatch"]["fencingToken"]!=lease["fencingToken"]
                || r["dispatch"]["leaseOwner"]!=lease["leaseOwner"] {return Ok(None);}
            if let Err(error)=dispatch_fence::assert(tx,&owner,&chat,&text(&lease["operationId"])?,
                &json!({"kind":"leased","lease":lease,"goalInferenceInputOperationId":r["operationId"]}),true).await {
                if error.is::<crate::task_dispatch::Conflict>() {return Ok(None);}
                return Err(error);
            }
            Ok(Some(r.clone()))
        })).await
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
        let mut r = input.clone();
        r["kind"] = json!("goal");
        r["operationId"] = json!(uuid::Uuid::new_v4().to_string());
        let r = parse("taskInferenceInputReceiptSchema", &r)?;
        let owner = owner.to_owned();
        self.database.transaction(|tx|Box::pin(async move {
            let (chat,id,operation)=(text(&r["chatId"])?,text(&r["dispatch"]["cycleId"])?,text(&r["dispatch"]["operationId"])?);
            dispatch_fence::assert(tx,&owner,&chat,&operation,&json!({"kind":"leased","lease":r["dispatch"]}),false).await?;
            let c=cycle(tx,&owner,&chat,Some(&id)).await?.ok_or_else(crate::task_dispatch::Conflict::stale)?;
            if c["operation_kind"]!="finalize" || c["physical_worker_id"]!=r["workerId"] || c["worktree_id"]!=r["worktreeId"] {return stale();}
            let row=context(tx,&owner,&r,true,false).await?;
            if row["chat"]["automation_paused"]==true || row["project"]["task_scheduling_paused"]==true || row["task"]["state"]=="paused" || row["lane"]["state"]!="active" {return stale();}
            let old=&c["goal_input"];
            if old["failedBeforeDispatch"]==true && old["receipt"]["dispatch"]["fencingToken"]==r["dispatch"]["fencingToken"] {return stale();}
            let same=old["receipt"]["clientMessageId"]==r["clientMessageId"];
            let state=json!({"receipt":r,"deferred":false,"failedBeforeDispatch":false,"accepted":false,"dispatched":false,"allAttemptsEnforced":!same || (old["accepted"]==true && old["allAttemptsEnforced"]==true),"firstDispatchedOperationId":if same{old["firstDispatchedOperationId"].clone()}else{Value::Null},"multipleDispatched":same && old["multipleDispatched"]==true,"attemptCountBefore":c["attempt_count"]});
            write(tx,&id,&state).await?;
            tx.query("UPDATE task_dispatch_cycles SET model_route_id=$2,provider_account_id=$3 WHERE id=$1",&[&id,&text(&r["modelRouteId"])?,&r["providerAccountId"].as_str()]).await?;
            Ok(r)
        })).await
    }
    pub async fn dispatch_goal_inference_input(
        &self,
        owner: &str,
        worker: &str,
        r: &Value,
        phase: &str,
    ) -> Result<Value> {
        if r["workerId"] != worker {
            return stale();
        }
        let (owner, r, phase) = (owner.to_owned(), r.clone(), phase.to_owned());
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
                    let mut s = c["goal_input"].clone();
                    if s.is_null()
                        || s["deferred"] == true
                        || s["failedBeforeDispatch"] == true
                        || s["dispatched"] == true
                        || s["receipt"] != r
                    {
                        return stale();
                    }
                    let row = context(tx, &owner, &r, true, false).await?;
                    if row["chat"]["automation_paused"] == true
                        || row["project"]["task_scheduling_paused"] == true
                        || row["task"]["state"] == "paused"
                        || row["lane"]["state"] != "active"
                    {
                        return stale();
                    }
                    if phase == "accepted" {
                        s["accepted"] = json!(true);
                    } else {
                        if s["accepted"] != true {
                            return stale();
                        }
                        s["dispatched"] = json!(true);
                        s["multipleDispatched"] = json!(
                            s["multipleDispatched"] == true
                                || (!s["firstDispatchedOperationId"].is_null()
                                    && s["firstDispatchedOperationId"] != r["operationId"])
                        );
                        if s["firstDispatchedOperationId"].is_null() {
                            s["firstDispatchedOperationId"] = r["operationId"].clone();
                        }
                    }
                    write(tx, &id, &s).await?;
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
            || record["workerGeneration"] == input["workerGeneration"]
        {
            return Ok(result("unresolved", false));
        }
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let record=&input["record"];let r=&record["identity"]["recovery"]["taskInput"];
            let result=|disposition:&str,no_input:bool|{let mut v=json!({"key":record["key"],"disposition":disposition,"chatId":r["chatId"]});if no_input{v["taskInputNotDispatched"]=json!(true);}v};
            let c=cycle(tx,&owner,&text(&r["chatId"])?,Some(&text(&r["dispatch"]["cycleId"])?)).await?;
            let Some(c)=c else{return Ok(result("retired",false));};let mut s=c["goal_input"].clone();
            if s.is_null() || !matches!(c["state"].as_str(),Some("claimed"|"running"|"queued"|"paused"|"expired")) || s["failedBeforeDispatch"]==true || s["receipt"]["clientMessageId"]!=r["clientMessageId"] || s["receipt"]["workerId"]!=input["workerId"] || s["receipt"]["providerId"]!=r["providerId"]{return Ok(result("retired",false));}
            if s["accepted"]!=true || s["allAttemptsEnforced"]!=true{return Ok(result("unresolved",false));}
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
