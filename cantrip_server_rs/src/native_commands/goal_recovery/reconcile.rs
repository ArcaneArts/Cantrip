use super::*;
use sha2::{Digest, Sha256};

async fn reconcile(
    tx: &Transaction<'_>,
    owner: &str,
    input: &Value,
    mut result: Value,
) -> Result<Value> {
    let record = &input["record"];
    let identity = &record["identity"]["recovery"];
    let worker = text(&input["workerId"])?;
    let operation = text(&identity["commandId"])?;
    let generation = text(&identity["commandGeneration"])?;
    let captured = context::read(
        Executor::Transaction(tx),
        owner,
        &worker,
        &operation,
        &generation,
    )
    .await?;
    let chat = text(&captured["chat_id"])?;
    context::lock_chat(tx, owner, &chat).await?;
    let row = context::read(
        Executor::Transaction(tx),
        owner,
        &worker,
        &operation,
        &generation,
    )
    .await?;
    let session = &row["identity"];
    let attempt = crate::native_handoffs::autonomous_attempt(&row)?;
    let Some(_attempt) = attempt.filter(|a| {
        row.get("chat_id") == record["identity"].get("chatId")
            && session.get("threadId") == identity.get("threadId")
            && session.get("projectId") == record["identity"].get("projectId")
            && a.get("turnId") == identity.get("turnId")
            && a.get("goalEpoch") == identity["autonomousGoal"].get("goalEpoch")
    }) else {
        return Ok(result);
    };
    let mut marker = read(tx, &chat).await?;
    let inherited = row["intent"].get("goalRecovery").filter(|v| !v.is_null());
    let source = inherited.cloned().unwrap_or_else(|| json!({"operationId":row["operation_id"],
        "operationGeneration":row["operation_generation"],"threadId":identity["threadId"],"goalEpoch":identity["autonomousGoal"]["goalEpoch"]}));
    if (inherited.is_some()
        && marker
            .as_ref()
            .is_none_or(|m| !deep_equal(&m["source"], &source)))
        || marker
            .as_ref()
            .is_some_and(|m| !deep_equal(&m["source"], &source))
    {
        result["disposition"] = json!("retired");
        return Ok(result);
    }
    let prior = recovered(&row);
    if prior.is_some_and(|s| !deep_equal(s, &source)) {
        return Ok(result);
    }
    if prior.is_some() && marker.is_none() {
        result["disposition"] = json!("retired");
        return Ok(result);
    }
    if truthy(row.get("logical_completed_at"))
        && prior.is_none()
        && !super::super::transport_evidence::is_transport_closure(row.get("terminal_evidence"))
    {
        result["disposition"] = json!("retired");
        return Ok(result);
    }
    let current = context::execution(tx, owner, &chat).await?;
    let chat_row = raw_one(
        tx,
        "SELECT to_jsonb(c)::text FROM chats c WHERE id=$1 AND owner_id=$2",
        &[&chat, &owner],
    )
    .await?;
    let unblocked = !tx
        .query(
            &format!(
                "SELECT c.id FROM chats c WHERE c.id=$1 AND {} AND {}",
                super::super::managed_queue::NO_PERMISSION,
                super::super::managed_queue::NO_HANDOFF
            ),
            &[&chat],
        )
        .await?
        .is_empty();
    // A pending transfer still owns its exact withdrawal proof; permission
    // changes own their quiescent boundary. Neither is a restored FIFO head.
    if !unblocked {
        return Ok(result);
    }
    if !context::same_placement(current.as_ref(), &input["workerId"], Some(session))?
        || !context::same_runtime_route(current.as_ref(), Some(session))?
        || current.as_ref().and_then(|c| c.get("threadId")) != source.get("threadId")
        || chat_row.as_ref().is_none_or(|c| {
            truthy(c.get("archived_at")) || truthy(c.get("managed_autonomy_stopped"))
        })
    {
        result["disposition"] = json!("retired");
        return Ok(result);
    }
    let route = if truthy(session.get("modelRouteId")) {
        raw_one(
            tx,
            "SELECT to_jsonb(r)::text FROM model_routes r WHERE id=$1",
            &[&text(&session["modelRouteId"])?],
        )
        .await?
    } else {
        None
    };
    if route.as_ref().and_then(|r| r.get("provider_id")) != record["identity"].get("providerId") {
        result["disposition"] = json!("retired");
        return Ok(result);
    }
    if prior.is_none() && row["status"] != "accepted" && record["everGranted"] == true {
        return Ok(result);
    }
    if (prior.is_none() || !truthy(row.get("execution_completed_at"))) && !retire::unused(tx, &row, &source, json!({"kind":"not-started","source":"worker-inference-journal",
        "key":record["key"],"workerGeneration":record["workerGeneration"],"runtimeGeneration":record["identity"]["runtimeGeneration"],"revision":record["revision"]})).await? { return Ok(result); }
    if marker.is_none() {
        marker = Some(json!({"source":source,"admission":Value::Null}));
    }
    let marker = marker.as_mut().unwrap();
    if truthy(marker.get("admission"))
        && marker["admission"].get("workerGeneration") != input.get("workerGeneration")
    {
        let admitted = marker["admission"].clone();
        if !input
            .get("expectedGoalAdmission")
            .is_some_and(|a| deep_equal(a, &admitted))
        {
            result["goalOwnershipChallenge"] = admitted;
            return Ok(result);
        }
        let row = context::read(
            Executor::Transaction(tx),
            owner,
            &worker,
            &text(&admitted["operationId"])?,
            &text(&admitted["operationGeneration"])?,
        )
        .await?;
        if row["intent"].get("workerGeneration") != admitted.get("workerGeneration") ||
            !deep_equal(&row["intent"]["goalRecovery"], &source) || !retire::unused(tx, &row, &source,
            json!({"kind":"not-dispatched","source":"canonical-goal-recovery","admission":admitted,"fencedByWorkerGeneration":input["workerGeneration"]})).await? { return Ok(result); }
        marker["admission"] = Value::Null;
    }
    if !read(tx, &chat)
        .await?
        .is_some_and(|m| deep_equal(&m, marker))
    {
        tx.query("INSERT INTO managed_queue_states(chat_id,goal_recovery) VALUES($1,$2::text::jsonb) ON CONFLICT(chat_id) DO UPDATE SET goal_recovery=EXCLUDED.goal_recovery", &[&chat,&marker.stringify()]).await?;
        queue::changed(tx, &chat).await?;
    }
    result["disposition"] = json!(
        if chat_row.is_some_and(|c| truthy(c.get("automation_paused"))) {
            "retired"
        } else {
            "requeued"
        }
    );
    result["goalInputNotDispatched"] = json!(true);
    Ok(result)
}

impl Repository {
    pub(in crate::native_commands) async fn reconcile_goal(
        &self,
        owner: &str,
        input: &Value,
    ) -> Result<Value> {
        let record = &input["record"];
        let identity = &record["identity"]["recovery"];
        let result = json!({"key":record["key"],"chatId":record["identity"]["chatId"],"disposition":"unresolved"});
        let parts = [
            text(&record["workerGeneration"])?,
            text(&record["identity"]["runtimeGeneration"])?,
            text(&record["identity"]["operationId"])?,
        ];
        let key = format!("{:x}", Sha256::digest(serde_json::to_vec(&parts)?));
        let local_settled = record["state"] == "released"
            && matches!(
                record["outcome"].as_str(),
                Some("never-started" | "runtime-exited")
            );
        if (record.get("workerGeneration") == input.get("workerGeneration") && !local_settled)
            || record["key"].as_str() != Some(key.as_str())
            || truthy(record.get("nativeExecution"))
            || !truthy(identity.get("autonomousGoal"))
            || truthy(identity.get("messageId"))
            || truthy(identity.get("taskInput"))
            || !["commandId", "commandGeneration", "threadId", "turnId"]
                .iter()
                .all(|k| truthy(identity.get(k)))
            || record["identity"].get("operationId") != identity.get("commandGeneration")
        {
            return Ok(result);
        }
        let (owner, input, base) = (owner.to_owned(), input.clone(), result.clone());
        let outcome = self
            .database
            .transaction(|tx| Box::pin(async move { reconcile(tx, &owner, &input, base).await }))
            .await;
        match outcome {
            Err(error)
                if error
                    .downcast_ref::<super::super::CommandError>()
                    .is_some_and(|e| {
                        matches!(e.code.as_str(), "operation-not-found" | "chat-not-found")
                    }) =>
            {
                let mut result = result;
                result["disposition"] = json!("retired");
                Ok(result)
            }
            result => result,
        }
    }
}
