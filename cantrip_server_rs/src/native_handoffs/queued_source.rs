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
    if lanes.len() != 1 || commands.len() != 1 || claims.len() != 1 {
        return reject("handoff-native-operation-pending");
    }
    let (command, claim) = (&commands[0], &claims[0]);
    let session = &command["identity"];
    if command["status"] != "accepted"
        || command["origin"] != "gui"
        || command["kind"] != "start"
        || command["method"] != "turn/start"
        || command.get("logical_operation_id") != command.get("operation_id")
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
        || claim["status"] != "accepted"
        || truthy(claim.get("native_turn_id"))
        || claim.get("operation_id") != command.get("operation_id")
        || claim.get("operation_generation") != command.get("operation_generation")
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
    Ok(
        json!({"operationId":command["operation_id"],"operationGeneration":command["operation_generation"],"withdrawn":false}),
    )
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
                    record["workerGeneration"],
                    record["identity"]["runtimeGeneration"],
                    record["identity"]["operationId"]
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
