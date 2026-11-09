//! Explicit recovery observes the exact retained native Task turn. Expiry alone
//! grants neither terminal failure nor a new inference attempt.
use super::*;

async fn capture(tx: &Transaction<'_>, owner: &str, chat: &str) -> Result<Option<(Value, Value)>> {
    if !lock_user(tx, owner).await? {
        return Ok(None);
    }
    let Some(cycle) = one(
        Executor::Transaction(tx),
        "SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.owner_id=$1 AND c.chat_id=$2 ORDER BY c.created_at DESC,c.id DESC LIMIT 1 FOR UPDATE",
        &[&owner, &chat],
    ).await? else { return Ok(None); };
    if cycle["state"] != "expired"
        || cycle["operation_kind"] == "finalize"
        || !cycle["goal_input"].is_null()
        || !truthy(cycle.get("codex_thread_id"))
        || !truthy(cycle.get("turn_id"))
    {
        return Ok(None);
    }
    let operation = text(&cycle["operation_id"])?;
    let guard = json!({"kind":"expired","cycleId":cycle["id"],"operationId":cycle["operation_id"],"fencingToken":cycle["fencing_token"]});
    dispatch_fence::assert(tx, owner, chat, &operation, &guard, false).await?;
    let Some(round) = locked_round(tx, chat, &operation).await? else {
        return Ok(None);
    };
    let input = &round["inference_input"];
    if round["status"] != "running"
        || round["kind"] != cycle["operation_kind"]
        || !round["relay_result"].is_null()
        || input.is_null()
        || !input["terminal"].is_null()
        || !input["resumption"].is_null()
        || input["deferred"] == true
        || input["failedBeforeDispatch"] == true
        || input["accepted"] != true
        || input["dispatched"] != true
        || input["allAttemptsEnforced"] != true
        || input["firstDispatchedOperationId"] != input["receipt"]["operationId"]
        || input["multipleDispatched"] == true
        || input["receipt"]["dispatch"]["fencingToken"]
            .as_i64()
            .and_then(|n| n.checked_add(1))
            != cycle["fencing_token"].as_i64()
    {
        return Ok(None);
    }
    tx.query("WITH p AS MATERIALIZED (SELECT projects.id FROM projects JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM p JOIN chats ON chats.project_id=p.id WHERE chats.id=$2 FOR UPDATE OF chats", &[&owner,&chat]).await?;
    let Some(context) = crate::native_commands::context::execution(tx, owner, chat).await? else {
        return Ok(None);
    };
    let Some(source) = crate::chats::native_task_suspension::source(tx, &context).await? else {
        return Ok(None);
    };
    let Some(placement) = one(Executor::Transaction(tx),
        "SELECT jsonb_build_object('chat',to_jsonb(c),'task',to_jsonb(t))::text FROM chats c JOIN tasks t ON t.chat_id=c.id WHERE c.id=$1 AND c.owner_id=$2 LIMIT 1 FOR UPDATE OF c,t",
        &[&chat,&owner]).await? else { return Ok(None); };
    if source.task_round.is_null()
        || !placement["chat"]["archived_at"].is_null()
        || placement["task"]["active_operation_id"] != round["id"]
        || placement["task"]["planning_round"] != round["ordinal"]
        || source.receipt["dispatch"]["cycleId"] != cycle["id"]
        || source.receipt["dispatch"]["operationId"] != cycle["operation_id"]
        || source.receipt["workerId"] != cycle["physical_worker_id"]
        || source.receipt["worktreeId"] != cycle["worktree_id"]
        || source.receipt["modelRouteId"] != cycle["model_route_id"]
        || source.receipt["providerAccountId"] != cycle["provider_account_id"]
        || source.native_execution["threadId"] != cycle["codex_thread_id"]
        || source.native_execution["turnId"] != cycle["turn_id"]
        || (!placement["chat"]["native_suspension_state"].is_null()
            && !matches!(
                placement["chat"]["native_suspension_state"]["phase"].as_str(),
                Some("stopped" | "completed" | "failed" | "idle")
            ))
    {
        return Ok(None);
    }
    let lane_id = text(&source.receipt["executionLaneId"])?;
    let Some(lane) = one(Executor::Transaction(tx),
        "SELECT to_jsonb(l)::text FROM chat_execution_lanes l WHERE l.chat_id=$1 AND l.id=$2 LIMIT 1 FOR UPDATE",
        &[&chat,&lane_id]).await? else { return Ok(None); };
    if lane["state"] != "active"
        || lane["worker_id"] != source.receipt["workerId"]
        || lane["worktree_id"] != source.receipt["worktreeId"]
        || lane["activated_at"]
            .as_js_string()
            .and_then(crate::wire::date_milliseconds)
            != source.receipt["executionLaneActivatedAt"]
                .as_js_string()
                .and_then(crate::wire::date_milliseconds)
    {
        return Ok(None);
    }
    let source = json!({"context":source.context,"taskRound":source.task_round,
        "receipt":source.receipt,"currentReceipt":source.current_receipt,
        "executionReceipt":source.execution_receipt,"nativeExecution":source.native_execution,
        "nativeOwner":source.native_owner});
    Ok(Some((
        json!({"inputSnapshot":input,"source":source,"guard":guard,"taskRowVersion":placement["task"]["row_version"],
        "placementRevision":placement["chat"]["placement_revision"],"managedInputRevision":placement["chat"]["managed_input_revision"],
        "nativeSuspension":placement["chat"]["native_suspension_state"]}),
        input.clone(),
    )))
}

impl Repository {
    pub async fn capture_native_turn_recovery(
        &self,
        owner: &str,
        chat: &str,
    ) -> Result<Option<Value>> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    Ok(capture(tx, &owner, &chat)
                        .await?
                        .map(|(snapshot, _)| snapshot))
                })
            })
            .await
    }

    pub async fn fail_observed_native_turn(
        &self,
        owner: &str,
        chat: &str,
        expected: &Value,
        evidence: &Value,
    ) -> Result<bool> {
        let observed = parse("nativeTurnRecoveryObservationSchema", evidence)?;
        if !matches!(observed["status"].as_str(), Some("failed" | "interrupted"))
            || observed["threadId"] != expected["source"]["nativeExecution"]["threadId"]
            || observed["turnId"] != expected["source"]["nativeExecution"]["turnId"]
            || observed["runtimeGeneration"]
                == expected["source"]["nativeOwner"]["runtimeGeneration"]
        {
            return Ok(false);
        }
        let (owner, chat, expected) = (owner.to_owned(), chat.to_owned(), expected.clone());
        self.database.transaction(|tx| Box::pin(async move {
            let Some((snapshot, mut input)) = capture(tx, &owner, &chat).await? else { return Ok(false); };
            if snapshot != expected { return Ok(false); }
            let source = &snapshot["source"];
            let guard = &snapshot["guard"];
            let operation = text(&guard["operationId"])?;
            super::finish::fail_operation_in(tx, &owner, &chat, &operation, None, Some(guard)).await?;
            let lane = text(&source["receipt"]["executionLaneId"])?;
            crate::chats::execution_lanes::finish_in_transaction(tx, &chat, &lane, "failed",
                &json!({"expectedActivatedAt":source["receipt"]["executionLaneActivatedAt"],"markUnreadCompletion":true})).await?;
            let now = crate::auth::now();
                let retry = postgres_types::Json(json!({"status":"idle","failureKind":"runtime",
                    "failureKey":format!("native-terminal:{}:{}",text(&guard["cycleId"])?,guard["fencingToken"].stringify()),
                    "dueAt":Value::Null,"attempts":Value::Array(Vec::new()),"claim":Value::Null}));
                tx.query("UPDATE tasks SET automatic_retry=$2 WHERE chat_id=$1", &[&chat,&retry]).await?;
            let at = crate::auth::iso(now);
            let mut digest = observed.clone();
            digest["type"] = json!("task-native-terminal-recovery");
            input["terminal"] = json!({"ok":false,"failureKind":"runtime",
                "outcomeDigest":crate::native_history::payload_digest(&digest),"observedAt":at,"projectedAt":at,
                "threadId":observed["threadId"],"turnId":observed["turnId"]});
            let input = postgres_types::Json(input);
            tx.query("UPDATE task_planning_rounds SET inference_input=$2 WHERE id=$1", &[&operation, &input]).await?;
            let cycle = text(&guard["cycleId"])?;
            tx.query("UPDATE task_dispatch_cycles SET state='failed',eligibility_code=NULL,completed_at=$2,updated_at=$2 WHERE id=$1", &[&cycle,&now]).await?;
            tx.query("UPDATE agent_interaction_requests SET status='interrupted',resolved_at=$1,updated_at=$1 WHERE chat_id=$2 AND execution_lane_id=$3 AND status='pending'", &[&now,&chat,&lane]).await?;
                // The idle retry marker fences legacy failure adoption on every
                // peer. Explicit recovery grants no inference or new lease.
            Ok(true)
        })).await
    }
}
