//! Canonical input-fence revocation followed by worker-confirmed settlement.
//! The original encrypted round stays the sole input; no tickets are granted here.
use super::*;

fn stale<T>() -> Result<T> {
    Err(crate::task_dispatch::Conflict::stale().into())
}

impl Repository {
    pub async fn change_inference_route(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
    ) -> Result<Value> {
        let input = parse("taskInferenceRouteChangeRequestSchema", input)?;
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            if !lock_user(tx,&owner).await? { return stale(); }
            crate::chats::guard::lock_chat(tx,&owner,&chat).await?;
            let item=one(Executor::Transaction(tx),"SELECT jsonb_build_object('round',to_jsonb(r),'task',to_jsonb(t))::text FROM task_planning_rounds r JOIN tasks t ON t.chat_id=r.chat_id AND t.active_operation_id=r.id JOIN chats c ON c.id=t.chat_id WHERE c.owner_id=$1 AND r.chat_id=$2 LIMIT 1", &[&owner,&chat]).await?;
            let Some(item)=item else { return stale() };
            let state=&item["round"]["inference_input"];
            if state.is_null() { return stale(); }
            let prior=&state["routeChange"];
            if prior["operationId"]==input["operationId"] {
                for field in ["inputOperationId","expectedRevision","targetModelRouteId","targetProviderAccountId"] {
                    if prior.get(field)!=input.get(field) { return conflict("idempotency-conflict","The route-change request changed identity."); }
                }
                return Ok(prior.clone());
            }
            if item["task"]["row_version"]!=input["expectedRevision"] { return conflict("stale-version","The Task changed in another client."); }
            if prior["phase"]=="draining" || state["receipt"]["operationId"]!=input["inputOperationId"] || truthy(state["receipt"].get("kind")) || state["accepted"]!=true || state["allAttemptsEnforced"]!=true || state["failedBeforeDispatch"]==true || !state["firstDispatchedOperationId"].is_null() { return stale(); }
            let source=&state["receipt"];
            let settled=state["deferred"]==true && prior["phase"]=="completed" && prior["source"]["operationId"]==source["operationId"];
            let (current_route,current_account)=if settled {(&prior["targetModelRouteId"],&prior["targetProviderAccountId"])}else{(&source["modelRouteId"],&source["providerAccountId"])};
            if current_route==&input["targetModelRouteId"] && current_account==&input["targetProviderAccountId"] { return conflict("stale-version","The queued Task already uses that route and account."); }
            let cycle_id=text(&source["dispatch"]["cycleId"])?;
            let operation=text(&source["dispatch"]["operationId"])?;
            let cycle=one(Executor::Transaction(tx),"SELECT to_jsonb(d)::text FROM task_dispatch_cycles d WHERE id=$1 AND owner_id=$2 AND chat_id=$3 AND operation_id=$4 FOR UPDATE", &[&cycle_id,&owner,&chat,&operation]).await?;
            let Some(cycle)=cycle else { return stale() };
            let revoked=matches!(cycle["state"].as_str(),Some("queued"|"paused")) && cycle["fencing_token"].as_i64().context("Task dispatch fence")?>source["dispatch"]["fencingToken"].as_i64().context("Task input fence")?;
            if !revoked { dispatch_fence::assert(tx,&owner,&chat,&operation,&json!({"kind":"leased","lease":source["dispatch"]}),false).await?; }
            let context=inference_inputs::context(tx,&owner,source).await?;
            let route=text(&input["targetModelRouteId"])?;
            let target=one(Executor::Transaction(tx),"SELECT jsonb_build_object('modelId',r.model_id,'providerId',r.provider_id,'kind',p.kind)::text FROM model_routes r JOIN model_profiles m ON m.id=r.model_id JOIN model_providers p ON p.id=r.provider_id WHERE r.id=$1 AND r.enabled=true AND m.owner_id=$2 AND p.owner_id=$2", &[&route,&owner]).await?;
            let Some(target)=target else { return conflict("stale-version","The configured destination no longer exists.") };
            let account=input["targetProviderAccountId"].as_str();
            if matches!(target["kind"].as_str(),Some("chatgpt"|"grok"))!=account.is_some() { return conflict("stale-version","Select an account belonging to the destination provider."); }
            if let Some(account)=account && tx.query("SELECT id FROM model_provider_accounts WHERE id=$1 AND provider_id=$2 AND enabled=true", &[&account,&text(&target["providerId"])?]).await?.is_empty() { return conflict("stale-version","The destination account no longer exists."); }
            let at=now();
            let mut change=input.clone();
            change["source"]=source.clone(); change["phase"]=json!(if settled {"completed"}else{"draining"});
            change["queuedFencingToken"]=increment(&cycle["fencing_token"]);
            change["createdAt"]=at.clone(); change["completedAt"]=if settled {at.clone()}else{Value::Null};
            let change=parse("taskInferenceRouteChangeSchema",&change)?;
            let mut state=state.clone(); state["routeChange"]=change.clone();
            inference_inputs::defer_locked(tx,&context,&state).await?;
            let mut configuration=item["task"]["model_configuration"].clone();
            configuration["modelId"]=target["modelId"].clone(); configuration["reasoningEffort"]=Value::Null;
            let configuration=parse("modelConfigurationSchema",&configuration)?;
            update(tx,Table::Task,&chat,&json!({"model_configuration":configuration,"scheduler_revision":increment(&item["task"]["scheduler_revision"]),"row_version":increment(&item["task"]["row_version"]),"updated_at":at}),None).await?;
            let code=if settled {None}else{Some("provider-transfer-pending")};
            tx.query("UPDATE task_dispatch_cycles SET eligibility_code=$2 WHERE id=$1", &[&cycle_id,&code]).await?;
            Ok(change)
        })).await
    }

    pub async fn inference_route_view(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        // Settlement changes the round and Task revision together. Read both
        // from one snapshot so a client can use the returned revision to write.
        let Some(snapshot) = one(
            Executor::Database(&self.database),
            "SELECT jsonb_build_object(
                'revision', t.row_version,
                'state', t.state,
                'archived', c.owner_id IS DISTINCT FROM $1 OR c.archived_at IS NOT NULL,
                'current', (
                    SELECT r.inference_input FROM task_planning_rounds r
                    WHERE r.chat_id=t.chat_id AND r.id=t.active_operation_id
                        AND r.status='running' AND r.inference_input IS NOT NULL
                ),
                'latest', (
                    SELECT r.inference_input->'routeChange' FROM task_planning_rounds r
                    WHERE r.chat_id=t.chat_id AND r.inference_input ? 'routeChange'
                    ORDER BY r.ordinal DESC LIMIT 1
                )
            )::text
            FROM tasks t JOIN chats c ON c.id=t.chat_id JOIN projects p ON p.id=c.project_id
            WHERE p.owner_id=$1 AND t.chat_id=$2 LIMIT 1",
            &[&owner, &chat],
        )
        .await?
        else {
            return Ok(None);
        };
        let current = &snapshot["current"];
        let source = (!current.is_null()
            && snapshot["archived"] == false
            && !matches!(snapshot["state"].as_str(), Some("complete" | "failed"))
            && current["accepted"] == true
            && current["allAttemptsEnforced"] == true
            && !truthy(current["receipt"].get("kind"))
            && current["failedBeforeDispatch"] != true
            && current["firstDispatchedOperationId"].is_null())
        .then(|| current["receipt"].clone());
        let inventory = crate::native_handoffs::Repository::new(self.database.clone())
            .inventory(owner, chat)
            .await?;
        parse(
            "taskInferenceRouteViewSchema",
            &json!({
                "chatId":chat,
                "revision":snapshot["revision"],
                "source":source,
                "latest":snapshot["latest"],
                "providers":inventory.as_ref().map(|i|i["providers"].clone()).unwrap_or_else(||Value::Array(Vec::new()))
            }),
        )
        .map(Some)
    }

    pub async fn pending_inference_routes(
        &self,
        owner: &str,
        worker: &str,
        after: Option<&str>,
    ) -> Result<Vec<Value>> {
        let rows=self.database.query("SELECT (r.inference_input->'routeChange')::text FROM task_planning_rounds r JOIN chats c ON c.id=r.chat_id JOIN workers w ON w.id=$2 AND w.owner_id=$1 WHERE c.owner_id=$1 AND r.inference_input->'routeChange'->>'phase'='draining' AND r.inference_input->'routeChange'->'source'->>'workerId'=$2 AND ($3::text IS NULL OR r.id>$3) ORDER BY r.id LIMIT 100", &[&owner,&worker,&after]).await?;
        rows.iter()
            .map(|row| {
                parse(
                    "taskInferenceRouteChangeSchema",
                    &serde_json::from_str::<Value>(&row.get::<String>(0)?)?,
                )
            })
            .collect()
    }

    /// Transient scheduler configuration, restricted to draining intents and
    /// current deferred destinations. Historical completed receipts stay in SQL.
    pub async fn inference_route_scheduling(
        &self,
        owner: &str,
    ) -> Result<(
        std::collections::HashSet<String>,
        std::collections::HashMap<String, Value>,
    )> {
        let rows=self.database.query("SELECT jsonb_build_object('chatId',c.id,'cycleId',NULL,'change',r.inference_input->'routeChange')::text FROM task_planning_rounds r JOIN chats c ON c.id=r.chat_id WHERE c.owner_id=$1 AND r.inference_input->'routeChange'->>'phase'='draining'
        UNION ALL SELECT jsonb_build_object('chatId',d.chat_id,'cycleId',d.id,'change',r.inference_input->'routeChange')::text FROM task_dispatch_cycles d JOIN task_planning_rounds r ON r.id=d.operation_id AND r.chat_id=d.chat_id WHERE d.owner_id=$1 AND d.state IN ('queued','paused') AND r.inference_input->'routeChange'->>'phase'='completed' AND r.inference_input->>'deferred'='true' AND r.inference_input->'receipt'->>'operationId'=r.inference_input->'routeChange'->>'inputOperationId'", &[&owner]).await?;
        let mut pending = std::collections::HashSet::new();
        let mut routes = std::collections::HashMap::new();
        for row in rows {
            let item: Value = serde_json::from_str(&row.get::<String>(0)?)?;
            let change = parse("taskInferenceRouteChangeSchema", &item["change"])?;
            if change["phase"] == "draining" {
                pending.insert(text(&item["chatId"])?);
            } else {
                routes.insert(text(&item["cycleId"])?, change);
            }
        }
        Ok((pending, routes))
    }

    pub async fn complete_inference_route(
        &self,
        owner: &str,
        worker: &str,
        change: &Value,
    ) -> Result<()> {
        let (owner, worker, change) = (owner.to_owned(), worker.to_owned(), change.clone());
        self.database.transaction(|tx|Box::pin(async move {
            lock_user(tx,&owner).await?;
            let source=&change["source"];
            let chat=text(&source["chatId"])?;
            // A deleted Task cannot be resurrected by a late acknowledgement.
            if tx.query("SELECT id FROM chats WHERE id=$1 AND owner_id=$2", &[&chat,&owner]).await?.is_empty() { return Ok(()); }
            crate::chats::guard::lock_chat(tx,&owner,&chat).await?;
            let cycle_id=text(&source["dispatch"]["cycleId"])?;
            let operation=text(&source["dispatch"]["operationId"])?;
            let cycle=one(Executor::Transaction(tx),"SELECT to_jsonb(d)::text FROM task_dispatch_cycles d WHERE id=$1 AND owner_id=$2 FOR UPDATE", &[&cycle_id,&owner]).await?;
            let item=one(Executor::Transaction(tx),"SELECT jsonb_build_object('round',to_jsonb(r),'task',to_jsonb(t),'archivedAt',c.archived_at)::text FROM task_planning_rounds r JOIN chats c ON c.id=r.chat_id JOIN tasks t ON t.chat_id=r.chat_id WHERE r.id=$1 AND c.owner_id=$2 FOR UPDATE", &[&operation,&owner]).await?;
            let Some(item)=item else { return Ok(()) };
            let mut state=item["round"]["inference_input"].clone();
            if state["routeChange"].is_null() { return Ok(()); }
            if state["routeChange"]["operationId"]!=change["operationId"] || source["workerId"]!=worker || parse("taskInferenceInputReceiptSchema",&state["routeChange"]["source"])?!=parse("taskInferenceInputReceiptSchema",source)? { return stale(); }
            if state["routeChange"]["phase"]!="draining" { return Ok(()); }
            let current=item["task"]["active_operation_id"]==source["dispatch"]["operationId"] && item["archivedAt"].is_null() && !matches!(item["task"]["state"].as_str(),Some("complete"|"failed")) && cycle.as_ref().is_some_and(|c|c["chat_id"]==source["chatId"] && c["operation_id"]==source["dispatch"]["operationId"] && state["deferred"]==true && state["receipt"]["operationId"]==change["inputOperationId"] && matches!(c["state"].as_str(),Some("queued"|"paused")));
            let at=now();
            state["routeChange"]["phase"]=json!(if current {"completed"}else{"cancelled"});
            state["routeChange"]["completedAt"]=at.clone();
            if current { state["routeChange"]["queuedFencingToken"]=cycle.as_ref().unwrap()["fencing_token"].clone(); }
            update(tx,Table::Round,&operation,&json!({"inference_input":state}),None).await?;
            if current && cycle.as_ref().is_some_and(|c|c["state"]=="paused") {
                tx.query("UPDATE task_dispatch_cycles SET state='queued',paused_at=NULL,lease_owner=NULL,lease_expires_at=NULL,selected_task_worker_id=NULL,task_worker_revision=NULL,continuity_family=NULL,model_configuration=NULL,model_route_id=NULL,provider_account_id=NULL,physical_worker_id=NULL,worktree_id=NULL,codex_thread_id=NULL,eligibility_code=NULL,updated_at=$2::text::timestamptz WHERE id=$1", &[&cycle_id,&text(&at)?]).await?;
            } else {
                tx.query("UPDATE task_dispatch_cycles SET eligibility_code=NULL,updated_at=$2::text::timestamptz WHERE id=$1 AND eligibility_code='provider-transfer-pending'", &[&cycle_id,&text(&at)?]).await?;
            }
            tx.query("UPDATE tasks SET scheduler_revision=scheduler_revision+1,row_version=row_version+1,updated_at=$2::text::timestamptz WHERE chat_id=$1", &[&chat,&text(&at)?]).await?;
            Ok(())
        })).await
    }
}
