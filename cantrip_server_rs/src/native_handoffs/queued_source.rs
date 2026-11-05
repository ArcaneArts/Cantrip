//! Candidate reservation is not no-start proof. Only the owning worker can seal
//! the actual source; canonical deferral and confirmation share the Chat lock.
use super::*;
use sha2::{Digest, Sha256};

async fn rows(tx: &Transaction<'_>, sql: &str, params: Parameters<'_>) -> Result<Vec<Value>> {
    tx.query(sql, params)
        .await?
        .iter()
        .map(|row| Ok(serde_json::from_str(&row.get::<String>(0)?)?))
        .collect()
}

pub(super) async fn reserve(tx: &Transaction<'_>, source: &Value) -> Result<Value> {
    let chat = text(&source["chatId"])?;
    let lanes = rows(
        tx,
        "SELECT to_jsonb(l)::text FROM chat_execution_lanes l WHERE chat_id=$1 AND state='active'",
        &[&chat],
    )
    .await?;
    let commands = rows(tx, "SELECT to_jsonb(c)::text FROM native_commands c WHERE chat_id=$1 AND status IN ('accepted','dispatched','uncertain')", &[&chat]).await?;
    let claims = rows(tx, "SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE chat_id=$1 AND status IN ('claimed','accepted','dispatched','uncertain')", &[&chat]).await?;
    if lanes.is_empty() && commands.is_empty() && claims.is_empty() {
        return Ok(Value::Null);
    }
    if lanes.len() != 1 || commands.len() != 1 {
        return reject("handoff-native-operation-pending");
    }
    let command = &commands[0];
    let autonomous = autonomous_source::attempt(command)?;
    let session = &command["identity"];
    if command["status"] != "accepted"
        || command["kind"] != "start"
        || command["method"] != "turn/start"
        || [
            "previous_operation_id",
            "logical_completed_at",
            "execution_completed_at",
            "result_digest",
            "protected_result",
            "terminal_result_digest",
            "protected_terminal_result",
            "terminal_evidence",
        ]
        .iter()
        .any(|key| truthy(command.get(key)))
        || command.get("worker_id") != source.get("workerId")
        || command.get("execution_lane_id") != lanes[0].get("id")
        || [
            "chatId",
            "threadId",
            "runtimeGeneration",
            "modelRouteId",
            "providerAccountId",
            "contextKind",
            "projectId",
            "placementId",
        ]
        .iter()
        .any(|field| session.get(field) != source.get(field))
        || !tx
            .query(
                "SELECT operation_id FROM native_command_turns WHERE operation_id=$1 LIMIT 1",
                &[&text(&command["operation_id"])?],
            )
            .await?
            .is_empty()
    {
        return reject("handoff-native-operation-pending");
    }
    if autonomous.is_some() {
        if !claims.is_empty() {
            return reject("handoff-native-operation-pending");
        }
    } else if claims.len() != 1
        || command["origin"] != "gui"
        || command.get("logical_operation_id") != command.get("operation_id")
        || claims[0]["status"] != "accepted"
        || truthy(claims[0].get("native_turn_id"))
        || claims[0].get("operation_id") != command.get("operation_id")
        || claims[0].get("operation_generation") != command.get("operation_generation")
    {
        return reject("handoff-native-operation-pending");
    }
    let mut result = json!({"operationId":command["operation_id"],"operationGeneration":command["operation_generation"],"withdrawn":false});
    if let Some(attempt) = autonomous {
        result["autonomousAttempt"] = attempt;
    }
    Ok(result)
}

pub(super) async fn confirm(
    tx: &Transaction<'_>,
    owner: &str,
    worker: &str,
    row: Value,
    record: &Value,
) -> Result<Value> {
    let queued = &row["queued_source"];
    if queued["withdrawn"] == true {
        return Ok(row);
    }
    if row["phase"] != "preparing" || truthy(row.get("prepared")) || !truthy(Some(queued)) {
        return reject("handoff-phase-conflict");
    }
    let source = row
        .get("binding")
        .filter(|v| !v.is_null())
        .unwrap_or(&row["source"]);
    guards::assert_source(tx, owner, source).await?;
    let operation = text(&queued["operationId"])?;
    let generation = text(&queued["operationGeneration"])?;
    let root = context::read(
        Executor::Transaction(tx),
        owner,
        worker,
        &operation,
        &generation,
    )
    .await?;
    if let Some(attempt) = queued.get("autonomousAttempt") {
        autonomous_source::confirm(tx, &row["source"], &root, attempt, record).await?;
        guards::assert_idle(tx, &text(&row["chat_id"])?).await?;
        let mut queued = queued.clone();
        queued["withdrawn"] = json!(true);
        return update(
            tx,
            &row,
            json!({"queuedSource":queued,"errorCode":Value::Null}),
        )
        .await;
    }
    if root.get("chat_id") != row.get("chat_id")
        || root.get("logical_operation_id") != root.get("operation_id")
        || truthy(root.get("previous_operation_id"))
    {
        return reject("handoff-native-operation-pending");
    }
    let evidence = &root["terminal_evidence"];
    let already = root["status"] == "rejected"
        && root["rejection_code"] == "worker-inference-deferred"
        && truthy(root.get("logical_completed_at"))
        && truthy(root.get("execution_completed_at"))
        && evidence["kind"] == "not-started"
        && evidence["source"] == "worker-inference-journal";
    if !tx
        .query(
            "SELECT operation_id FROM native_command_turns WHERE operation_id=$1 LIMIT 1",
            &[&operation],
        )
        .await?
        .is_empty()
    {
        return reject("handoff-native-operation-pending");
    }
    if record.is_null() {
        if !already {
            return reject("handoff-native-operation-pending");
        }
    } else {
        let identity = &record["identity"]["recovery"];
        let key = format!(
            "{:x}",
            Sha256::digest(
                json!([
                    record["workerGeneration"].clone(),
                    record["identity"]["runtimeGeneration"].clone(),
                    record["identity"]["operationId"].clone()
                ])
                .stringify()
                .as_bytes()
            )
        );
        if record["key"] != key
            || record["state"] != "released"
            || record["outcome"] != "never-started"
            || truthy(record.get("nativeExecution"))
            || record["identity"].get("operationId") != queued.get("operationGeneration")
            || record["identity"].get("chatId") != source.get("chatId")
            || (!record["identity"]["projectId"].is_null()
                && record["identity"].get("projectId") != source.get("projectId"))
            || identity.get("commandId") != queued.get("operationId")
            || identity.get("commandGeneration") != queued.get("operationGeneration")
            || !truthy(identity.get("messageId"))
            || identity.get("messageId") != root.get("logical_client_message_id")
            || (truthy(identity.get("threadId"))
                && identity.get("threadId") != source.get("threadId"))
            || (already && evidence.get("key") != record.get("key"))
        {
            return reject("handoff-native-operation-pending");
        }
        // Stop may have settled and removed the original input while this
        // no-start acknowledgement was in flight. Never put that input back.
        let cancelled = truthy(root.get("logical_completed_at"))
            && truthy(root.get("execution_completed_at"))
            && !tx.query("SELECT n.operation_id FROM native_commands n INNER JOIN native_command_activations a ON a.chat_id=n.chat_id AND a.generation=n.activation_generation AND a.logical_cancelled=true AND a.active=false INNER JOIN managed_queue_claims c ON c.operation_id=n.operation_id AND c.operation_generation=n.operation_generation AND c.status='rejected' INNER JOIN queued_prompts p ON p.id=c.prompt_id AND p.state IN ('removed','consumed') WHERE n.operation_id=$1 AND n.status='rejected' LIMIT 1", &[&operation]).await?.is_empty();
        if !cancelled
            && !crate::native_commands::undispatched_gui::defer(
                tx,
                owner,
                worker,
                &operation,
                &generation,
                Some(record),
            )
            .boxed()
            .await?
        {
            return reject("handoff-native-operation-pending");
        }
    }
    guards::assert_idle(tx, &text(&row["chat_id"])?).await?;
    let mut queued = queued.clone();
    queued["withdrawn"] = json!(true);
    update(
        tx,
        &row,
        json!({"queuedSource":queued,"errorCode":Value::Null}),
    )
    .await
}

pub(super) async fn retarget(
    tx: &Transaction<'_>,
    chat: &str,
    queued: &Value,
    model: &Value,
) -> Result<Option<Value>> {
    let operation = text(&queued["operationId"])?;
    let generation = text(&queued["operationGeneration"])?;
    let item=one(Executor::Transaction(tx),"SELECT to_jsonb(p)::text FROM managed_queue_claims c INNER JOIN queued_prompts p ON p.id=c.prompt_id WHERE c.chat_id=$1 AND c.operation_id=$2 AND c.operation_generation=$3 AND c.status='deferred' AND p.chat_id=$1 AND p.state='pending' AND p.revision=c.prompt_revision LIMIT 1", &[&chat,&operation,&generation]).await?;
    let Some(item) = item else { return Ok(None) };
    let mut opaque = item["opaque_content"].clone();
    if !opaque.is_null() {
        opaque["modelId"] = model.clone();
        opaque = parse("queuedPromptOpaqueContentSchema", &opaque)?;
    }
    let opaque_json = if opaque.is_null() {
        None
    } else {
        Some(opaque.stringify())
    };
    let rows=tx.query("UPDATE queued_prompts SET model_id=$1,opaque_content=$2::text::jsonb,revision=revision+1,updated_at=$3 WHERE id=$4 RETURNING revision", &[&text(model)?,&opaque_json,&crate::auth::now(),&text(&item["id"])?]).await?;
    let revision = rows
        .first()
        .context("Transferred prompt revision")?
        .get::<i32>(0)?;
    Ok(Some(json!({"id":item["id"],"revision":revision})))
}

pub(super) async fn decline(tx: &Transaction<'_>, owner: &str, row: Value) -> Result<Value> {
    if row["phase"] == "cancelled" {
        return Ok(row);
    }
    if row["phase"] != "preparing"
        || truthy(row.get("prepared"))
        || !truthy(row.get("queued_source"))
        || row["queued_source"]["withdrawn"] == true
    {
        return reject("handoff-phase-conflict");
    }
    guards::assert_source(
        tx,
        owner,
        row.get("binding")
            .filter(|v| !v.is_null())
            .unwrap_or(&row["source"]),
    )
    .await?;
    let error = if row["cancel_requested"] == true {
        Value::Null
    } else {
        json!("handoff-source-no-longer-queued")
    };
    let result = update(tx, &row, json!({"phase":"cancelled","errorCode":error})).await?;
    crate::native_commands::queue_state_changed(tx, &text(&row["chat_id"])?).await?;
    Ok(result)
}
