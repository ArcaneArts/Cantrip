//! Exact worker terminal receipts survive lease expiry; finalizers queue Goal startup.
use super::*;

fn stale<T>() -> Result<T> {
    Err(crate::task_dispatch::Conflict::stale().into())
}
impl Repository {
    pub async fn recover_round_outcome(
        &self,
        owner: &str,
        worker: &str,
        n: &Value,
    ) -> Result<Option<Value>> {
        if n["contextKind"] != "project"
            || !truthy(n.get("taskDispatchFence"))
            || !truthy(n.get("taskInferenceInputOperationId"))
        {
            return Ok(None);
        }
        let (owner, worker, n) = (owner.to_owned(), worker.to_owned(), n.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let chat=text(&n["chatId"])?;
            let f=&n["taskDispatchFence"];
            let operation=text(&f["operationId"])?;
            if !lock_user(tx,&owner).await? {return Ok(None);}
            let Some(round)=locked_round(tx,&chat,&operation).await? else{return Ok(None);};
            let result=if n["outcome"]["ok"]==true {
                relay::parse_result(&round["relay_request"],&n["outcome"]["result"]["structuredResult"]).ok()
            } else {None};
            let goal_startup=result.is_some() && round["kind"]=="finalize";
            let guard=json!({"kind":"outcome","cycleId":f["cycleId"],"operationId":f["operationId"],
                "leaseOwner":f["leaseOwner"],"fencingToken":f["fencingToken"],"inferenceInputOperationId":n["taskInferenceInputOperationId"]});
            dispatch_fence::assert(tx,&owner,&chat,&operation,&guard,false).await?;
            let id=text(&f["cycleId"])?;
            let c=one(Executor::Transaction(tx),"SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.id=$1 LIMIT 1 FOR UPDATE",&[&id]).await?.ok_or_else(crate::task_dispatch::Conflict::stale)?;
            let input=&round["inference_input"];let r=&input["receipt"];
            if c["operation_kind"]!=round["kind"] || input.is_null()
                || (n["outcome"]["ok"]==true && (input["accepted"]!=true || input["dispatched"]!=true || input["failedBeforeDispatch"]==true)) || r["kind"]=="goal" || r["operationId"]!=n["taskInferenceInputOperationId"]
                || r["workerId"]!=worker.as_str() || r["clientMessageId"]!=n["clientMessageId"] || r["executionLaneId"]!=n["executionLaneId"]
                || r["worktreeId"]!=n["worktreeId"] || r["dispatch"]["cycleId"]!=f["cycleId"] || r["dispatch"]["operationId"]!=f["operationId"]
                || r["dispatch"]["fencingToken"]!=f["fencingToken"] || r["dispatch"]["leaseOwner"]!=f["leaseOwner"] {return stale();}
            tx.query("WITH p AS MATERIALIZED (SELECT projects.id FROM projects JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM p JOIN chats ON chats.project_id=p.id WHERE chats.id=$2 FOR UPDATE OF chats",&[&owner,&chat]).await?;
            let placement=one(Executor::Transaction(tx),"SELECT jsonb_build_object('chat',to_jsonb(c),'project',to_jsonb(p))::text FROM chats c JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE c.id=$2 LIMIT 1 FOR UPDATE OF c,p",&[&owner,&chat]).await?.ok_or_else(crate::task_dispatch::Conflict::stale)?;
            let task=locked_task(tx,&chat).await?.ok_or_else(crate::task_dispatch::Conflict::stale)?;
            let routing=json!({"experience":placement["chat"]["experience"],"projectId":placement["chat"]["project_id"]});
            if placement["chat"]["experience"]!="task" || !placement["chat"]["archived_at"].is_null()
                || task["planning_round"]!=round["ordinal"] {return stale();}
            if !c["goal_input"].is_null() || (round["kind"]=="finalize" && !task["implementation_started_at"].is_null()) {
                return Ok(Some(json!({"state":"owned","message":Value::Null,"chat":routing})));
            }
            if task["active_operation_id"]!=operation && !(truthy(round.get("relay_result")) && task["active_operation_id"].is_null()) {return stale();}
            if truthy(round.get("relay_result")) && result.is_none() {
                return Ok(Some(json!({"state":"owned","message":Value::Null,"chat":routing})));
            }
            if goal_startup && task["plan_goal_enabled"]!=true {return stale();}
            let lane_id=text(&r["executionLaneId"])?;
            let lane=one(Executor::Transaction(tx),"SELECT to_jsonb(l)::text FROM chat_execution_lanes l WHERE l.chat_id=$1 AND l.id=$2 LIMIT 1 FOR UPDATE",&[&chat,&lane_id]).await?.ok_or_else(crate::task_dispatch::Conflict::stale)?;
            if lane["worker_id"]!=worker.as_str() || lane["worktree_id"]!=r["worktreeId"]
                || lane["activated_at"].as_js_string().and_then(crate::wire::date_milliseconds)!=r["executionLaneActivatedAt"].as_js_string().and_then(crate::wire::date_milliseconds)
                || placement["chat"]["active_worker_id"]!=worker.as_str() || placement["chat"]["active_worktree_id"]!=r["worktreeId"] {return stale();}
            let mut message=Value::Null;
            if let Some(result)=&result {
                super::finish::complete_operation_in(tx,&owner,&chat,&operation,result,n["outcome"]["result"]["turnId"].as_str(),Some(&guard)).await?;
                message=crate::chats::message_writes::append_task_with(Executor::Transaction(tx),&owner,&chat,&result["assistantMessage"],
                    Some(&json!({"executionLaneId":r["executionLaneId"],"worktreeId":r["worktreeId"]}))).await?.ok_or_else(crate::task_dispatch::Conflict::stale)?;
                if !goal_startup {super::retries::clear_pending_in(tx,&owner,&chat,&guard).await?;}
                tx.query("UPDATE task_planning_rounds SET execution_lane_id=$2,user_message_id=$3,assistant_message_id=$4 WHERE id=$1",&[&operation,&lane_id,&text(&r["clientMessageId"])?,&text(&message["id"])?]).await?;
            } else {
                super::finish::fail_operation_in(tx,&owner,&chat,&operation,None,Some(&guard)).await?;
                let key=format!("dispatch:{}:{}",text(&f["cycleId"])?,f["fencingToken"].stringify());
                let error=if n["outcome"]["ok"]==true {json!({"message":"Recovered Task result was invalid."})} else {json!({"message":n["outcome"]["error"]})};
                super::retries::note_failure_in(tx,&owner,&chat,&key,super::failure_kind::classify(&error),&guard).await?;
            }
            tx.query("UPDATE task_planning_rounds SET execution_lane_id=$2,user_message_id=$3 WHERE id=$1",&[&operation,&lane_id,&text(&r["clientMessageId"]) ?]).await?;
            if n["outcome"]["ok"]==true {
                crate::chats::execution_lanes::update_runtime_in_transaction(tx,&chat,&lane_id,n["outcome"]["result"]["threadId"].as_str(),"ready").await?;
            }
            let status=if result.is_some(){"idle"}else{"failed"};
            crate::chats::execution_lanes::finish_in_transaction(tx,&chat,&lane_id,status,&json!({"expectedActivatedAt":r["executionLaneActivatedAt"],"markUnreadCompletion":!goal_startup})).await?;
            let now=crate::auth::now();
            tx.query("UPDATE agent_interaction_requests SET status='interrupted',resolved_at=$1,updated_at=$1 WHERE chat_id=$2 AND execution_lane_id=$3 AND status='pending'",&[&now,&chat,&lane_id]).await?;
            tx.query("UPDATE chats SET status=$3,updated_at=$2 WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM chat_execution_lanes WHERE chat_id=$1 AND state='active')",&[&chat,&now,&status]).await?;
            if !goal_startup {
                let turn=n["outcome"]["result"]["turnId"].as_str().or(c["turn_id"].as_str());
                let thread=n["outcome"]["result"]["threadId"].as_str().or(c["codex_thread_id"].as_str());
                tx.query("UPDATE task_dispatch_cycles SET state=$2,completed_at=$3,eligibility_code=NULL,updated_at=$3,turn_id=$4,codex_thread_id=$5 WHERE id=$1",&[&id,&if result.is_some(){"succeeded"}else{"failed"},&now,&turn,&thread]).await?;
                return Ok(Some(json!({"state":"settled","message":message,"chat":routing,"ok":result.is_some()})));
            }
            let paused=placement["chat"]["automation_paused"]==true || placement["project"]["task_scheduling_paused"]==true || task["state"]=="paused";
            // The next claim continues this finalizer's attempt rather than
            // charging it a second time solely for durable startup queueing.
            let attempts=i32::try_from(c["attempt_count"].as_i64().context("Task attempt count")?.saturating_sub(1).max(0)).context("Task attempt count")?;
            let thread=n["outcome"]["result"]["threadId"].as_str();
            tx.query("UPDATE task_dispatch_cycles SET state=$2,lease_owner=NULL,lease_expires_at=NULL,last_heartbeat_at=NULL,fencing_token=fencing_token+1,attempt_count=$3,claimed_at=NULL,started_at=NULL,completed_at=NULL,paused_at=CASE WHEN $2='paused' THEN $4 ELSE NULL END,turn_id=NULL,codex_thread_id=$5,eligibility_code=NULL,updated_at=$4 WHERE id=$1",&[&id,&if paused{"paused"}else{"queued"},&attempts,&now,&thread]).await?;
            Ok(Some(json!({"state":"queued","message":message,"chat":routing})))
        })).await
    }
    /// An expiry alone is never execution failure. Only an authenticated exact
    /// no-forward terminal marker may use this path.
    pub async fn fail_confirmed_expired_round(
        &self,
        owner: &str,
        chat: &str,
        guard: &Value,
    ) -> Result<bool> {
        let (owner, chat, guard) = (owner.to_owned(), chat.to_owned(), guard.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let operation=text(&guard["operationId"])?;
            dispatch_fence::assert(tx,&owner,&chat,&operation,&guard,false).await?;
            let id=text(&guard["cycleId"])?;
            let c=one(Executor::Transaction(tx),"SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.id=$1 LIMIT 1 FOR UPDATE",&[&id]).await?.ok_or_else(crate::task_dispatch::Conflict::stale)?;
            let Some(round)=locked_round(tx,&chat,&operation).await? else{return Ok(false);};
            let input=&round["inference_input"]; let receipt=&input["receipt"];
            if !c["goal_input"].is_null() || truthy(round.get("relay_result")) || input.is_null()
                || input["deferred"]==true || input["failedBeforeDispatch"]!=true
                || !input["firstDispatchedOperationId"].is_null()
                || receipt["dispatch"]["cycleId"]!=guard["cycleId"]
                || receipt["dispatch"]["operationId"]!=guard["operationId"]
                || receipt["dispatch"]["fencingToken"].as_i64().and_then(|n|n.checked_add(1))!=guard["fencingToken"].as_i64() {return Ok(false);}
            tx.query("WITH p AS MATERIALIZED (SELECT projects.id FROM projects JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM p JOIN chats ON chats.project_id=p.id WHERE chats.id=$2 FOR UPDATE OF chats",&[&owner,&chat]).await?;
            let placement=one(Executor::Transaction(tx),"SELECT jsonb_build_object('chat',to_jsonb(c),'task',to_jsonb(t))::text FROM chats c JOIN tasks t ON t.chat_id=c.id WHERE c.id=$1 AND c.owner_id=$2 LIMIT 1 FOR UPDATE OF c,t",&[&chat,&owner]).await?;
            if !placement.as_ref().is_some_and(|p| p["chat"]["archived_at"].is_null()
                && p["task"]["active_operation_id"]==operation && p["task"]["planning_round"]==round["ordinal"]
                && round["status"]=="running" && !matches!(p["task"]["state"].as_str(),Some("failed"|"complete"))) {return Ok(false);}
            super::finish::fail_operation_in(tx,&owner,&chat,&operation,None,Some(&guard)).await?;
            Ok(true)
        })).await
    }
}
