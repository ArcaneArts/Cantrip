//! Publication of captured physical facts is separate from Task/control authority.
use super::*;
fn stale<T>() -> Result<T> {
    Err(crate::task_dispatch::Conflict::stale().into())
}
impl Repository {
    pub async fn deliver_round_outcome(
        &self,
        owner: &str,
        worker: &str,
        n: &Value,
    ) -> Result<Option<Value>> {
        match self.recover_round_outcome(owner, worker, n).await {
            Ok(Some(result)) if !result["terminal"]["projectedAt"].is_null() => {
                return Ok(Some(result));
            }
            Ok(_) => {}
            Err(error)
                if error.is::<crate::task_dispatch::Conflict>()
                    || error.is::<super::Conflict>() => {}
            Err(error) => return Err(error),
        }
        self.historical_round_outcome(owner, worker, n).await
    }
    async fn historical_round_outcome(
        &self,
        owner: &str,
        worker: &str,
        n: &Value,
    ) -> Result<Option<Value>> {
        let (owner, worker, n) = (owner.to_owned(), worker.to_owned(), n.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let f=&n["taskDispatchFence"]; if f.is_null() || n["taskInferenceInputOperationId"].is_null() {return Ok(None);}
            let chat=text(&n["chatId"])?;let operation=text(&f["operationId"])?;
            if !lock_user(tx,&owner).await? {return Ok(None);}
            let Some(round)=locked_round(tx,&chat,&operation).await? else{return Ok(None);};
            tx.query("WITH p AS MATERIALIZED (SELECT projects.id FROM projects JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM p JOIN chats ON chats.project_id=p.id WHERE chats.id=$2 FOR UPDATE OF chats",&[&owner,&chat]).await?;
            let row=one(Executor::Transaction(tx),"SELECT jsonb_build_object('chat',to_jsonb(c),'projectId',p.id,'task',to_jsonb(t),'message',to_jsonb(m))::text FROM chats c JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 JOIN tasks t ON t.chat_id=c.id JOIN chat_messages m ON m.chat_id=c.id AND m.id=$3 WHERE c.id=$2 LIMIT 1 FOR UPDATE OF c,p,t,m",&[&owner,&chat,&text(&n["clientMessageId"])?]).await?;
            let Some(row)=row else{return Ok(None);};
            let input=&round["inference_input"];
            let Ok(r)=parse("taskInferenceInputReceiptSchema",&input["receipt"]) else{return Ok(None);};
            if r["kind"]=="goal" || input["deferred"]==true || row["chat"]["experience"]!="task" || r["operationId"]!=n["taskInferenceInputOperationId"] ||
                r["chatId"]!=n["chatId"] || r["workerId"]!=worker.as_str() || r["clientMessageId"]!=n["clientMessageId"] ||
                r["executionLaneId"]!=n["executionLaneId"] || r["worktreeId"]!=n["worktreeId"] || r["dispatch"]["cycleId"]!=f["cycleId"] ||
                r["dispatch"]["operationId"]!=f["operationId"] || r["dispatch"]["fencingToken"]!=f["fencingToken"] || r["dispatch"]["leaseOwner"]!=f["leaseOwner"] ||
                round["relay_request"]["userMessage"]["id"]!=r["clientMessageId"] || row["message"]["role"]!="user" || row["message"]["mode"]!=if round["kind"]=="direct" {"default"}else{"plan"} || row["message"]["task_protected_content"].is_null() || truthy(row["message"].get("content")) ||
                (n["outcome"]["ok"]==true && (input["accepted"]!=true || input["dispatched"]!=true || input["failedBeforeDispatch"]==true)) {return stale();}
            let normalized=parse("workerChatTurnOutcomeNotificationSchema",&n)?;
            let digest=crate::native_history::payload_digest(&normalized["outcome"]);
            let routing=json!({"projectId":row["projectId"],"experience":"task"});
            if !input["terminal"]["projectedAt"].is_null() {
                if input["terminal"]["outcomeDigest"]!=digest.as_str() {return stale();}
                return Ok(Some(json!({"state":"owned","message":Value::Null,"chat":routing,"terminal":input["terminal"]})));
            }
            let cycle=one(Executor::Transaction(tx),"SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.id=$1 AND c.owner_id=$2 AND c.chat_id=$3 LIMIT 1 FOR UPDATE",&[&text(&f["cycleId"])?,&owner,&chat]).await?;
            let latest=one(Executor::Transaction(tx),"SELECT jsonb_build_object('id',id)::text FROM task_dispatch_cycles WHERE owner_id=$1 AND chat_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",&[&owner,&chat]).await?;
            let lane=one(Executor::Transaction(tx),"SELECT to_jsonb(l)::text FROM chat_execution_lanes l WHERE l.chat_id=$1 AND l.id=$2 LIMIT 1",&[&chat,&text(&r["executionLaneId"])?]).await?;
            let historical= !row["chat"]["archived_at"].is_null() || row["task"]["planning_round"]!=round["ordinal"] || row["task"]["active_operation_id"]!=round["id"] ||
                row["chat"]["active_worker_id"]!=r["workerId"] || row["chat"]["active_worktree_id"]!=r["worktreeId"] || cycle.is_none() ||
                cycle.as_ref().is_some_and(|c|latest.as_ref().is_none_or(|l|l["id"]!=c["id"]) || matches!(c["state"].as_str(),Some("succeeded"|"failed"|"cancelled")) || !c["goal_input"].is_null()) ||
                lane.as_ref().is_none_or(|l|l["activated_at"].as_js_string().and_then(crate::wire::date_milliseconds)!=r["executionLaneActivatedAt"].as_js_string().and_then(crate::wire::date_milliseconds));
            if !historical {return Ok(None);}
            let result=if n["outcome"]["ok"]==true {relay::parse_result(&round["relay_request"],&n["outcome"]["result"]["structuredResult"]).ok()}else{None};
            let failure=if result.is_some(){Value::Null}else{let e=if n["outcome"]["ok"]==true{json!({"message":"Recovered Task result was invalid."})}else{json!({"message":n["outcome"]["error"]})};json!(failure_kind::classify(&e))};
            let terminal=json!({"ok":result.is_some(),"failureKind":failure,"outcomeDigest":digest,"historyOnly":true,"observedAt":now(),"projectedAt":now(),
                "threadId":if n["outcome"]["ok"]==true {n["outcome"]["result"]["threadId"].clone()}else{Value::Null},
                "turnId":if n["outcome"]["ok"]==true {n["outcome"]["result"]["turnId"].clone()}else{n["outcome"]["inference"]["turnId"].clone()}});
            let root=one(Executor::Transaction(tx),"SELECT jsonb_build_object('id',w.id)::text FROM project_worktrees w JOIN project_sources s ON s.id=w.project_source_id JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 WHERE w.id=$2 LIMIT 1",&[&owner,&text(&r["worktreeId"])?]).await?;
            let root=root.as_ref().map(|w|w["id"].clone()).unwrap_or_else(||row["message"]["worktree_id"].clone());
            if root.is_null() {return stale();}
            let saved=if let Some(result)=&result {
                crate::chats::message_writes::append_task_history_with(Executor::Transaction(tx),&owner,&chat,&result["assistantMessage"],&json!({"executionLaneId":r["executionLaneId"],"worktreeId":root})).await?.ok_or_else(crate::task_dispatch::Conflict::stale)?
            } else {Value::Null};
            let mut recorded=input.clone();recorded["terminal"]=terminal.clone();
            let recorded=postgres_types::Json(recorded);
            tx.query("UPDATE task_planning_rounds SET inference_input=$2 WHERE id=$1",&[&operation,&recorded]).await?;
            Ok(Some(json!({"state":"owned","message":saved,"chat":routing,"terminal":terminal})))
        })).await
    }
    pub async fn round_outcome_retirement(
        &self,
        owner: &str,
        worker: &str,
        n: &Value,
    ) -> Result<Option<&'static str>> {
        let (owner, worker, n) = (owner.to_owned(), worker.to_owned(), n.clone());
        self.database.transaction(|tx|Box::pin(async move {
            let f=&n["taskDispatchFence"];if f.is_null() || n["taskInferenceInputOperationId"].is_null(){return Ok(None);}
            let chat=text(&n["chatId"])?;
            tx.query("WITH p AS MATERIALIZED (SELECT projects.id FROM projects JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM p JOIN chats ON chats.project_id=p.id WHERE chats.id=$2 FOR UPDATE OF chats",&[&owner,&chat]).await?;
            let row=one(Executor::Transaction(tx),"SELECT jsonb_build_object('input',r.inference_input,'messageId',m.id)::text FROM task_planning_rounds r JOIN chats c ON c.id=r.chat_id JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 LEFT JOIN chat_messages m ON m.chat_id=c.id AND m.id=$3 WHERE r.id=$4 AND r.chat_id=$2 LIMIT 1",&[&owner,&chat,&text(&n["clientMessageId"])?,&text(&f["operationId"])?]).await?;
            let Some(row)=row else{return Ok(Some("canonical-input-deleted"));};
            if row["messageId"].is_null(){return Ok(Some("canonical-input-deleted"));}
            let Ok(r)=parse("taskInferenceInputReceiptSchema",&row["input"]["receipt"]) else{return Ok(None);};
            if r["chatId"]!=n["chatId"] || r["dispatch"]["operationId"]!=f["operationId"] {return Ok(None);}
            if r["operationId"]!=n["taskInferenceInputOperationId"] {return Ok(Some("canonical-input-replaced"));}
            if n["outcome"]["ok"]==false && row["input"]["deferred"]==true && row["input"]["accepted"]==true && row["input"]["allAttemptsEnforced"]==true && row["input"].get("firstDispatchedOperationId").is_some_and(Value::is_null)
                && (row["input"]["failedBeforeDispatch"]==true || (n["outcome"]["inference"]["disposition"]=="input-not-dispatched" && n["outcome"]["inference"]["operationId"]==r["operationId"] && n["outcome"]["inference"]["providerId"]==r["providerId"] && n["outcome"]["inference"]["chatId"]==r["chatId"] && n["outcome"]["inference"]["messageId"]==r["clientMessageId"])) && r["workerId"]==worker.as_str() && r["clientMessageId"]==n["clientMessageId"] {return Ok(Some("canonical-input-deferred"));}
            Ok(None)
        })).await
    }
}
