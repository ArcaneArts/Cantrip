//! Canonical Task input receipts. Provider admission remains worker-owned.
use super::*;

fn stale<T>() -> Result<T> {
    Err(crate::task_dispatch::Conflict::stale().into())
}

pub(super) async fn context(tx: &Transaction<'_>, owner: &str, receipt: &Value) -> Result<Value> {
    let (operation, chat, lane, activated) = (
        text(&receipt["dispatch"]["operationId"])?,
        text(&receipt["chatId"])?,
        text(&receipt["executionLaneId"])?,
        text(&receipt["executionLaneActivatedAt"])?,
    );
    tx.query("WITH locked_project AS MATERIALIZED (SELECT projects.id FROM projects INNER JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM locked_project INNER JOIN chats ON chats.project_id=locked_project.id WHERE chats.id=$2 FOR UPDATE OF chats",&[&owner,&chat]).await?;
    let row = one(Executor::Transaction(tx),
        "SELECT jsonb_build_object('round',to_jsonb(r),'task',to_jsonb(t),'chat',to_jsonb(c),'project',to_jsonb(p),'lane',to_jsonb(l))::text FROM task_planning_rounds r JOIN tasks t ON t.chat_id=r.chat_id JOIN chats c ON c.id=t.chat_id JOIN projects p ON p.id=c.project_id JOIN chat_execution_lanes l ON l.chat_id=c.id WHERE r.id=$1 AND c.id=$2 AND p.owner_id=$3 AND l.id=$4 AND l.activated_at=$5::text::timestamptz LIMIT 1 FOR UPDATE",
        &[&operation,&chat,&owner,&lane,&activated]).await?;
    let Some(row) = row else {
        return stale();
    };
    let (round, task, chat, lane) = (&row["round"], &row["task"], &row["chat"], &row["lane"]);
    if task["active_operation_id"] != round["id"]
        || round["status"] != "running"
        || round["relay_request"]["userMessage"]["id"] != receipt["clientMessageId"]
        || (!round["user_message_id"].is_null()
            && round["user_message_id"] != receipt["clientMessageId"])
        || !round["relay_result"].is_null()
        || !round["assistant_message_id"].is_null()
        || !round["turn_id"].is_null()
        || lane["worker_id"] != receipt["workerId"]
        || lane["worktree_id"] != receipt["worktreeId"]
        || !chat["archived_at"].is_null()
        || matches!(task["state"].as_str(), Some("complete" | "failed"))
    {
        return stale();
    }
    Ok(row)
}

pub(super) async fn defer_locked(tx: &Transaction<'_>, row: &Value, state: &Value) -> Result<()> {
    if state["failedBeforeDispatch"] == true {
        return stale();
    }
    let receipt = &state["receipt"];
    let (chat, lane, operation, cycle) = (
        text(&receipt["chatId"])?,
        text(&receipt["executionLaneId"])?,
        text(&receipt["dispatch"]["operationId"])?,
        text(&receipt["dispatch"]["cycleId"])?,
    );
    let transferred = state["routeChange"]["inputOperationId"] == receipt["operationId"];
    let paused = !transferred
        && (row["chat"]["automation_paused"] == true
            || row["project"]["task_scheduling_paused"] == true
            || row["task"]["state"] == "paused");
    crate::chats::execution_lanes::finish_in_transaction(tx,&chat,&lane,"idle",&json!({"expectedActivatedAt":receipt["executionLaneActivatedAt"],"markUnreadCompletion":false})).await?;
    let now = now();
    let at = text(&now)?;
    // A prior observer can have suspended this same activation already. Never
    // change the visible state of another active lane.
    tx.query("UPDATE chats SET status='idle',updated_at=$2::text::timestamptz WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM chat_execution_lanes WHERE chat_id=$1 AND state='active')",&[&chat,&at]).await?;
    let mut state = state.clone();
    state["deferred"] = json!(true);
    update(
        tx,
        Table::Round,
        &operation,
        &json!({"inference_input":state}),
        None,
    )
    .await?;
    let attempts = state["attemptCountBefore"]
        .as_i64()
        .context("Task input attempt count")?
        .to_string();
    let placement = if paused {
        ""
    } else {
        ",selected_task_worker_id=NULL,task_worker_revision=NULL,continuity_family=NULL,model_configuration=NULL,model_route_id=NULL,provider_account_id=NULL,physical_worker_id=NULL,worktree_id=NULL,codex_thread_id=NULL"
    };
    tx.query(&format!("UPDATE task_dispatch_cycles SET state=$2{placement},turn_id=NULL,lease_owner=NULL,lease_expires_at=NULL,last_heartbeat_at=NULL,fencing_token=fencing_token+1,attempt_count=$3::text::integer,eligibility_code='capacity-unavailable',claimed_at=NULL,started_at=NULL,completed_at=NULL,paused_at=CASE WHEN $2='paused' THEN $4::text::timestamptz ELSE NULL END,updated_at=$4::text::timestamptz WHERE id=$1"),
        &[&cycle,&if paused {"paused"}else{"queued"},&attempts,&at]).await?;
    Ok(())
}

impl Repository {
    /// Stop holds the owner/cycle/chat locks. Revoke only an enforced receipt
    /// whose input was never dispatched, including a not-yet-claimed command.
    pub(crate) async fn defer_round_input_for_interrupt(
        tx: &Transaction<'_>,
        owner: &str,
        cycle: &Value,
    ) -> Result<()> {
        let Some(round) = locked_round(
            tx,
            &text(&cycle["chat_id"])?,
            &text(&cycle["operation_id"])?,
        )
        .await?
        else {
            return Ok(());
        };
        let state = &round["inference_input"];
        let receipt = &state["receipt"];
        let fence = &receipt["dispatch"];
        if state.is_null()
            || state["allAttemptsEnforced"] != true
            || !receipt["kind"].is_null()
            || state["deferred"] == true
            || state["failedBeforeDispatch"] == true
            || state["dispatched"] == true
            || !state["firstDispatchedOperationId"].is_null()
            || fence["cycleId"] != cycle["id"]
            || fence["operationId"] != cycle["operation_id"]
            || fence["fencingToken"] != cycle["fencing_token"]
            || fence["leaseOwner"] != cycle["lease_owner"]
            || !matches!(cycle["state"].as_str(), Some("claimed" | "running"))
        {
            return Ok(());
        }
        let result = async {
            let row = context(tx, owner, receipt).await?;
            defer_locked(tx, &row, state).await
        }
        .await;
        match result {
            Err(error) if error.is::<crate::task_dispatch::Conflict>() => Ok(()),
            result => result,
        }
    }

    pub async fn prepare_inference_input(&self, owner: &str, input: &Value) -> Result<Value> {
        self.prepare_inference_input_at_revision(owner, input, None, None)
            .await
    }

    pub async fn prepare_inference_input_at_revision(
        &self,
        owner: &str,
        input: &Value,
        expected_revision: Option<i64>,
        publication: Option<&Value>,
    ) -> Result<Value> {
        if input["kind"] == "goal" {
            return self
                .prepare_goal_inference_input_at_revision(
                    owner,
                    input,
                    expected_revision,
                    publication,
                )
                .await;
        }
        let mut receipt = input.clone();
        receipt["operationId"] = json!(uuid::Uuid::new_v4().to_string());
        let mut receipt = parse("taskInferenceInputReceiptSchema", &receipt)?;
        let owner = owner.to_owned();
        let prepared = self.database.transaction(|tx|Box::pin(async move {
            let chat=text(&receipt["chatId"])?;let operation=text(&receipt["dispatch"]["operationId"])?;
            dispatch_fence::assert(tx,&owner,&chat,&operation,&json!({"kind":"leased","lease":receipt["dispatch"]}),false).await?;
            let row=context(tx,&owner,&receipt).await?;
            let control_changed=expected_revision.is_some_and(|revision|row["chat"]["managed_input_revision"].as_i64()!=Some(revision));
            if row["lane"]["state"]!="active" || (!control_changed && (row["chat"]["automation_paused"]==true || row["project"]["task_scheduling_paused"]==true || row["task"]["state"]=="paused")) {return stale();}
            let cycle=text(&receipt["dispatch"]["cycleId"])?;
            let cycle=one(Executor::Transaction(tx),"SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE id=$1",&[&cycle]).await?.context("Task input dispatch")?;
            if cycle["physical_worker_id"]!=receipt["workerId"] || cycle["worktree_id"]!=receipt["worktreeId"] {return stale();}
            receipt["queueOrderEpoch"] = cycle["goal_order_epoch"].clone();
            let previous=&row["round"]["inference_input"];
            if previous["failedBeforeDispatch"]==true && previous["receipt"]["dispatch"]["cycleId"]==receipt["dispatch"]["cycleId"] && previous["receipt"]["dispatch"]["fencingToken"]==receipt["dispatch"]["fencingToken"] {return stale();}
            let attempts=if previous["deferred"]==true {previous["attemptCountBefore"].clone()}else{json!((cycle["attempt_count"].as_i64().context("Task attempts")?-1).max(0))};
            let mut state=json!({"receipt":receipt,"deferred":false,"failedBeforeDispatch":false,"accepted":false,"dispatched":false,"allAttemptsEnforced":previous.is_null() || (previous["allAttemptsEnforced"]==true && (previous["accepted"]==true || previous["deferred"]==true)),"firstDispatchedOperationId":previous["firstDispatchedOperationId"],"multipleDispatched":previous["multipleDispatched"]==true,"attemptCountBefore":attempts});
            if let Some(change)=previous.get("routeChange") { state["routeChange"]=change.clone(); }
            if control_changed && (state["allAttemptsEnforced"]!=true || !state["firstDispatchedOperationId"].is_null()) {return stale();}
            update(tx,Table::Round,&operation,&json!({"inference_input":state,"user_message_id":receipt["clientMessageId"],"execution_lane_id":receipt["executionLaneId"]}),None).await?;
            let route=text(&receipt["modelRouteId"])?;let account=receipt["providerAccountId"].as_str();let cycle_id=text(&cycle["id"])?;
            tx.query("UPDATE task_dispatch_cycles SET model_route_id=$2,provider_account_id=$3 WHERE id=$1",&[&cycle_id,&route,&account]).await?;
            if control_changed {
                defer_locked(tx,&row,&state).await?;
                return Ok(Value::Null);
            }
            Ok(receipt)
        })).await?;
        if prepared.is_null() {
            return stale();
        }
        Ok(prepared)
    }

    /// Acknowledge actual input authority before native turn/start. This never
    /// grants or releases provider capacity.
    pub async fn dispatch_inference_input(
        &self,
        owner: &str,
        worker: &str,
        receipt: &Value,
        phase: &str,
    ) -> Result<Value> {
        self.dispatch_inference_input_with_owner(owner, worker, receipt, phase, None)
            .await
    }

    pub async fn dispatch_inference_input_with_owner(
        &self,
        owner: &str,
        worker: &str,
        receipt: &Value,
        phase: &str,
        metadata: Option<&Value>,
    ) -> Result<Value> {
        if !matches!(phase, "accepted" | "claim" | "dispatch" | "native") {
            return stale();
        }
        if receipt["kind"] == "goal" {
            return self
                .dispatch_goal_inference_input(owner, worker, receipt, phase, metadata)
                .await;
        }
        if receipt["workerId"] != worker {
            return stale();
        }
        let (owner, receipt, phase) = (owner.to_owned(), receipt.clone(), phase.to_owned());
        let metadata = metadata.cloned().unwrap_or(Value::Null);
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let chat = text(&receipt["chatId"])?;
                    let operation = text(&receipt["dispatch"]["operationId"])?;
                    dispatch_fence::assert(
                        tx,
                        &owner,
                        &chat,
                        &operation,
                        &json!({"kind":"leased","lease":receipt["dispatch"]}),
                        false,
                    )
                    .await?;
                    let row = context(tx, &owner, &receipt).await?;
                    let mut state = row["round"]["inference_input"].clone();
                    let mut physical = super::resumption::physical(&state).clone();
                    let resumed = !state["resumption"].is_null();
                    if !physical.is_null() && physical["receipt"] != receipt {
                        return stale();
                    }
                    if resumed {
                        let current =
                            crate::native_commands::suspension::chat(tx, &owner, &chat).await?;
                        let saved = crate::native_commands::suspension::read(&current)?
                            .unwrap_or(Value::Null);
                        if saved["controlId"] != state["resumption"]["controlId"]
                            || saved["action"] != "resume"
                            || !(saved["phase"] == "resuming"
                                || (phase == "native" && saved["phase"] == "running"))
                        {
                            return stale();
                        }
                    }
                    if phase == "native" {
                        return super::native_input_binding::bind(
                            tx, &owner, &receipt, &row, &metadata,
                        )
                        .await;
                    }
                    if state.is_null()
                        || state["deferred"] == true
                        || state["failedBeforeDispatch"] == true
                        || physical["dispatched"] == true
                        || physical["receipt"] != receipt
                        || row["lane"]["state"] != "active"
                        || (row["chat"]["automation_paused"] == true && !resumed)
                        || row["project"]["task_scheduling_paused"] == true
                        || row["task"]["state"] == "paused"
                    {
                        return stale();
                    }
                    if !physical["claimWorkerGeneration"].is_null()
                        && physical["claimWorkerGeneration"] != metadata["workerGeneration"]
                    {
                        return stale();
                    }
                    if phase == "accepted" || phase == "claim" {
                        if phase == "claim" && physical["accepted"] == true {
                            return stale();
                        }
                        physical["accepted"] = json!(true);
                        if phase == "claim" && !metadata["workerGeneration"].is_null() {
                            physical["claimWorkerGeneration"] =
                                metadata["workerGeneration"].clone();
                        }
                    } else {
                        if physical["accepted"] != true {
                            return stale();
                        }
                        physical["dispatched"] = json!(true);
                        if !resumed {
                            physical["multipleDispatched"] = json!(
                                physical["multipleDispatched"] == true
                                    || (!physical["firstDispatchedOperationId"].is_null()
                                        && physical["firstDispatchedOperationId"]
                                            != receipt["operationId"])
                            );
                            if physical["firstDispatchedOperationId"].is_null() {
                                physical["firstDispatchedOperationId"] =
                                    receipt["operationId"].clone();
                            }
                        }
                    }
                    if resumed {
                        state["resumption"] = physical;
                    } else {
                        state = physical;
                    }
                    update(
                        tx,
                        Table::Round,
                        &operation,
                        &json!({"inference_input":state}),
                        None,
                    )
                    .await?;
                    Ok(json!({"receipt":receipt}))
                })
            })
            .await
    }

    /// Record terminal no-input evidence separately from lease-sensitive failure
    /// settlement. A stale lease must not roll back this canonical observation.
    pub async fn record_inference_failure(
        &self,
        owner: &str,
        worker: &str,
        proof: &Value,
    ) -> Result<()> {
        self.record_goal_inference_failure(owner, worker, proof)
            .await?;
        if proof["disposition"] != "input-not-dispatched" {
            return Ok(());
        }
        let (owner, worker, proof) = (owner.to_owned(), worker.to_owned(), proof.clone());
        self.database.transaction(|tx|Box::pin(async move {
            if !lock_user(tx, &owner).await? { return Ok(()); }
            let chat = text(&proof["chatId"])?;
            let round = one(Executor::Transaction(tx),
                "SELECT to_jsonb(r)::text FROM task_planning_rounds r JOIN tasks t ON t.chat_id=r.chat_id AND t.active_operation_id=r.id WHERE r.chat_id=$1 LIMIT 1",
                &[&chat]).await?;
            let Some(round) = round else { return Ok(()); };
            let state = &round["inference_input"];
            if state.is_null() || state["deferred"] == true { return Ok(()); }
            let receipt = &state["receipt"];
            if receipt["operationId"] != proof["operationId"] || receipt["chatId"] != proof["chatId"] ||
                receipt["clientMessageId"] != proof["messageId"] || receipt["providerId"] != proof["providerId"] ||
                receipt["workerId"] != worker.as_str() { return Ok(()); }
            let fence = &receipt["dispatch"];
            let (cycle_id, operation) = (text(&fence["cycleId"])?, text(&fence["operationId"])?);
            let cycle = one(Executor::Transaction(tx),
                "SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.id=$1 AND c.owner_id=$2 AND c.chat_id=$3 AND c.operation_id=$4 LIMIT 1 FOR UPDATE",
                &[&cycle_id,&owner,&chat,&operation]).await?;
            let latest = one(Executor::Transaction(tx),
                "SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.owner_id=$1 AND c.chat_id=$2 ORDER BY c.created_at DESC,c.id DESC LIMIT 1",
                &[&owner,&chat]).await?;
            let Some(cycle) = cycle else { return Ok(()); };
            if latest.as_ref().and_then(|v|v.get("id")) != cycle.get("id") { return Ok(()); }
            let current = (cycle["fencing_token"] == fence["fencingToken"] && cycle["lease_owner"] == fence["leaseOwner"] &&
                matches!(cycle["state"].as_str(),Some("claimed"|"running"))) ||
                (cycle["state"] == "expired" && cycle["fencing_token"].as_i64().context("Task dispatch fence")? == fence["fencingToken"].as_i64().context("Task input fence")? + 1);
            if !current { return Ok(()); }
            let row = match context(tx,&owner,receipt).await {
                Ok(row) => row,
                Err(error) if error.is::<crate::task_dispatch::Conflict>() => return Ok(()),
                Err(error) => return Err(error),
            };
            if row["round"]["inference_input"]["failedBeforeDispatch"] != true {
                let mut state = state.clone();
                state["failedBeforeDispatch"] = json!(true);
                update(tx,Table::Round,&operation,&json!({"inference_input":state}),None).await?;
            }
            Ok(())
        })).await
    }

    pub async fn defer_inference_input(
        &self,
        owner: &str,
        chat: &str,
        guard: &Value,
    ) -> Result<bool> {
        if let Some(result) = self.defer_goal_inference_input(owner, chat, guard).await? {
            return Ok(result);
        }
        let (owner, chat, guard) = (owner.to_owned(), chat.to_owned(), guard.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let leased=guard["kind"]=="leased";let fence=if leased{&guard["lease"]}else{&guard};let operation=text(&fence["operationId"])?;
            dispatch_fence::assert(tx,&owner,&chat,&operation,&guard,false).await?;
            let round=one(Executor::Transaction(tx),"SELECT to_jsonb(r)::text FROM task_planning_rounds r WHERE id=$1 AND chat_id=$2 LIMIT 1 FOR UPDATE",&[&operation,&chat]).await?;
            let Some(round)=round else{return Ok(false);};let state=&round["inference_input"];
            if state.is_null() || state["accepted"]!=true || state["allAttemptsEnforced"]!=true || state["deferred"]==true || state["failedBeforeDispatch"]==true || !state["firstDispatchedOperationId"].is_null(){return Ok(false);}
            let receipt=&state["receipt"];let previous=&receipt["dispatch"];
            if previous["cycleId"]!=fence["cycleId"] || previous["operationId"]!=fence["operationId"] || previous["fencingToken"].as_i64().context("Task receipt fence")?+if leased{0}else{1}!=fence["fencingToken"].as_i64().context("Task dispatch fence")? || (leased && previous["leaseOwner"]!=fence["leaseOwner"]){return Ok(false);}
            let row=context(tx,&owner,receipt).await?;
            defer_locked(tx,&row,state).await?;
            Ok(true)
        })).await
    }

    pub async fn reconcile_inference_input(&self, owner: &str, input: &Value) -> Result<Value> {
        if input["record"]["identity"]["recovery"]["taskInput"]["kind"] == "goal" {
            return self.reconcile_goal_inference_input(owner, input).await;
        }
        let record = &input["record"];
        let receipt = &record["identity"]["recovery"]["taskInput"];
        let result = |disposition: &str, no_input: bool| {
            let mut result =
                json!({"key":record["key"],"disposition":disposition,"chatId":receipt["chatId"]});
            if no_input {
                result["taskInputNotDispatched"] = json!(true);
            }
            result
        };
        if receipt.is_null()
            || receipt["workerId"] != input["workerId"]
            || receipt["operationId"] != record["identity"]["operationId"]
            || receipt["chatId"] != record["identity"]["chatId"]
            || receipt["clientMessageId"] != record["identity"]["recovery"]["messageId"]
            || receipt["providerId"] != record["identity"]["providerId"]
            || record["workerGeneration"] == input["workerGeneration"]
        {
            return Ok(result("unresolved", false));
        }
        let (owner, input) = (owner.to_owned(), input.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let record=&input["record"];let receipt=&record["identity"]["recovery"]["taskInput"];
            let result=|disposition:&str,no_input:bool| {
                let mut result=json!({"key":record["key"],"disposition":disposition,"chatId":receipt["chatId"]});
                if no_input{result["taskInputNotDispatched"]=json!(true);}result
            };
            if !lock_user(tx,&owner).await?{return Ok(result("retired",false));}
            let (cycle,chat,operation)=(text(&receipt["dispatch"]["cycleId"])?,text(&receipt["chatId"])?,text(&receipt["dispatch"]["operationId"]) ?);
            let ex=Executor::Transaction(tx);
            let cycle=one(ex,"SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE id=$1 AND owner_id=$2 AND chat_id=$3 LIMIT 1 FOR UPDATE",&[&cycle,&owner,&chat]).await?;
            let latest=one(ex,"SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE owner_id=$1 AND chat_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",&[&owner,&chat]).await?;
            let round=locked_round(tx,&chat,&operation).await?;
            let (Some(cycle),Some(round))=(cycle,round) else{return Ok(result("retired",false));};
            if latest.as_ref().and_then(|v|v.get("id"))!=cycle.get("id") || cycle["operation_id"]!=receipt["dispatch"]["operationId"] || round["relay_request"]["userMessage"]["id"]!=receipt["clientMessageId"]{return Ok(result("retired",false));}
            let mut state=round["inference_input"].clone();
            if state["failedBeforeDispatch"]==true{return Ok(result("retired",false));}
            if state.is_null() || state["accepted"]!=true || state["allAttemptsEnforced"]!=true{return Ok(result("unresolved",false));}
            if !round["relay_result"].is_null() || round["status"]!="running" || !matches!(cycle["state"].as_str(),Some("claimed"|"running"|"queued"|"paused"|"expired")){return Ok(result("retired",false));}
            if state["receipt"]["workerId"]!=input["workerId"] || state["receipt"]["providerId"]!=receipt["providerId"]{return Ok(result("retired",false));}
            if !state["firstDispatchedOperationId"].is_null(){
                let never_started=(record["everGranted"]==false && record["state"]!="granted") || (record["state"]=="released" && record["outcome"]=="never-started");
                if state["firstDispatchedOperationId"]!=receipt["operationId"] || state["multipleDispatched"]==true || !never_started{return Ok(result("unresolved",false));}
                state["firstDispatchedOperationId"]=Value::Null;
                update(tx,Table::Round,&operation,&json!({"inference_input":state}),None).await?;
            }
            let row=match context(tx,&owner,&state["receipt"]).await {
                Ok(row)=>row,
                Err(error) if error.is::<crate::task_dispatch::Conflict>()=>return Ok(result("retired",false)),
                Err(error)=>return Err(error),
            };
            let paused=row["chat"]["automation_paused"]==true || row["project"]["task_scheduling_paused"]==true || row["task"]["state"]=="paused";
            if state["deferred"]==true || state["receipt"]["operationId"]!=receipt["operationId"]{return Ok(result(if paused || cycle["state"]=="paused"{"retired"}else{"requeued"},true));}
            let expected=&state["receipt"]["dispatch"];
            let valid=(cycle["fencing_token"]==expected["fencingToken"] && cycle["lease_owner"]==expected["leaseOwner"] && matches!(cycle["state"].as_str(),Some("claimed"|"running"))) || (cycle["state"]=="expired" && cycle["fencing_token"].as_i64().context("Task dispatch fence")?==expected["fencingToken"].as_i64().context("Task receipt fence")?+1);
            if !valid{return Ok(result("retired",false));}
            defer_locked(tx,&row,&state).await?;
            Ok(result(if paused{"retired"}else{"requeued"},true))
        })).await
    }
}
