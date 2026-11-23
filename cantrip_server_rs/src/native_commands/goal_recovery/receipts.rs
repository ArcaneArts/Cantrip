use super::*;

/// Reserve positive no-dispatch authority at the first negative receipt. Keep
/// its exact first-cycle child until physical completion so partial settlement
/// cannot reject the applied setter's claim before the final receipt arrives.
pub(in crate::native_commands) async fn settle_before_dispatch(
    tx: &Transaction<'_>,
    row: &Value,
    before: &Value,
) -> Result<bool> {
    if !matches!(row["status"].as_str(), Some("rejected" | "uncertain")) {
        return Ok(false);
    }
    let chat = text(&row["chat_id"])?;
    let mut marker = read(tx, &chat).await?;
    if marker.is_none()
        && !truthy(row["intent"].get("goalRecovery"))
        && before["status"] == "accepted"
    {
        let attempt = crate::native_handoffs::autonomous_attempt(row)?;
        let current = raw_one(
            tx,
            "SELECT to_jsonb(c)::text FROM chats c WHERE id=$1",
            &[&chat],
        )
        .await?;
        if attempt.as_ref().is_none_or(|a| !truthy(a.get("goalEpoch")))
            || !truthy(row["identity"].get("threadId"))
            || !truthy(row["intent"].get("workerGeneration"))
            || current.is_none_or(|c| {
                truthy(c.get("archived_at")) || truthy(c.get("managed_autonomy_stopped"))
            })
        {
            return Ok(false);
        }
        let source = json!({"operationId":row["operation_id"],"operationGeneration":row["operation_generation"],
            "threadId":row["identity"]["threadId"],"goalEpoch":attempt.unwrap()["goalEpoch"]});
        let admission = json!({"operationId":row["operation_id"],"operationGeneration":row["operation_generation"],"workerGeneration":row["intent"]["workerGeneration"]});
        marker = Some(json!({"source":source,"admission":admission}));
        tx.query(
            "INSERT INTO managed_queue_states(chat_id) VALUES($1) ON CONFLICT DO NOTHING",
            &[&chat],
        )
        .await?;
    }
    let Some(marker) = marker.filter(|m| {
        (!truthy(row["intent"].get("goalRecovery"))
            || deep_equal(&m["source"], &row["intent"]["goalRecovery"]))
            && m["admission"].get("operationId") == row.get("operation_id")
            && m["admission"].get("operationGeneration") == row.get("operation_generation")
    }) else {
        return Ok(false);
    };
    let attempt = crate::native_handoffs::autonomous_attempt(row)?;
    if attempt
        .as_ref()
        .is_none_or(|a| a.get("goalEpoch") != marker["source"].get("goalEpoch"))
    {
        return reject("stale-goal-recovery");
    }
    let operation = text(&row["operation_id"])?;
    let generation = text(&row["operation_generation"])?;
    if !tx
        .query(
            "SELECT operation_id FROM native_command_turns WHERE operation_id=$1 LIMIT 1",
            &[&operation],
        )
        .await?
        .is_empty()
    {
        return reject("stale-goal-recovery");
    }
    let claims = tx.query("SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE goal_operation_id=$1 AND goal_operation_generation=$2", &[&operation,&generation]).await?;
    for claim in claims {
        let claim: Value = serde_json::from_str(&claim.get::<String>(0)?)?;
        if claim["awaiting_goal"] != true
            || claim["chat_id"] != chat
            || claim.get("goal_epoch") != marker["source"].get("goalEpoch")
            || truthy(claim.get("native_turn_id"))
            || !matches!(claim["status"].as_str(), Some("dispatched" | "uncertain"))
        {
            return reject("stale-goal-recovery");
        }
        if truthy(row.get("execution_completed_at")) {
            tx.query("UPDATE managed_queue_claims SET goal_operation_id=NULL,goal_operation_generation=NULL WHERE id=$1", &[&text(&claim["id"])?]).await?;
        }
    }
    // Never rewrite terminal_evidence or protected digests: a repeated worker
    // settlement must keep resolving to the same immutable negative receipt.
    tx.query(
        "UPDATE native_commands SET goal_recovery_source=$1::text::jsonb WHERE operation_id=$2",
        &[&marker["source"].stringify(), &operation],
    )
    .await?;
    let mut next_marker = marker.clone();
    if truthy(row.get("execution_completed_at")) {
        next_marker["admission"] = Value::Null;
    }
    tx.query(
        "UPDATE managed_queue_states SET goal_recovery=$1::text::jsonb WHERE chat_id=$2",
        &[&next_marker.stringify(), &chat],
    )
    .await?;
    queue::changed(tx, &chat).await?;
    Ok(true)
}

/// Receipt is from the current authenticated worker connection, not capacity
/// authority. A stale result cannot clear a newer admission or source.
pub(in crate::native_commands) async fn confirm_receipt(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    receipt: &Value,
) -> Result<()> {
    let marker = read(tx, chat).await?;
    let Some(marker) = marker.filter(|m| deep_equal(&m["source"], &receipt["source"])) else {
        return Ok(());
    };
    if receipt["status"] == "admitted" {
        if !deep_equal(&marker["admission"], &receipt["admission"]) {
            return reject("stale-goal-recovery");
        }
        let row = raw_one(tx,"SELECT to_jsonb(n)::text FROM native_commands n WHERE owner_id=$1 AND chat_id=$2 AND operation_id=$3 AND operation_generation=$4", &[&owner,&chat,&text(&receipt["admission"]["operationId"])?,&text(&receipt["admission"]["operationGeneration"])?]).await?;
        if row.is_none_or(|r| {
            r["status"] != "accepted"
                || truthy(r.get("execution_completed_at"))
                || !deep_equal(&r["intent"]["goalRecovery"], &receipt["source"])
        }) {
            return reject("stale-goal-recovery");
        }
        return Ok(());
    }
    if receipt["reason"] == "source-changed" {
        return Ok(());
    }
    if receipt["reason"] == "paused" {
        let current = raw_one(
            tx,
            "SELECT to_jsonb(c)::text FROM chats c WHERE id=$1",
            &[&chat],
        )
        .await?;
        if current.is_none_or(|c| !truthy(c.get("automation_paused"))) {
            return reject("stale-goal-recovery");
        }
        return Ok(());
    }
    let Some(observation) = receipt.get("observation").filter(|o| !o.is_null()) else {
        return Ok(());
    };
    if observation["chatId"] != chat
        || observation.get("threadId") != marker["source"].get("threadId")
        || observation["orderEpoch"].as_f64().unwrap_or(0.0)
            != marker["orderEpoch"].as_f64().unwrap_or(0.0)
    {
        return Ok(());
    }
    let settings = raw_one(
        tx,
        "SELECT to_jsonb(s)::text FROM native_settings_states s WHERE chat_id=$1",
        &[&chat],
    )
    .await?;
    let binding = settings
        .as_ref()
        .and_then(|s| s["state"].get("binding"))
        .filter(|b| !b.is_null());
    if binding.is_none_or(|binding| {
        [
            "chatId",
            "workerId",
            "threadId",
            "contextKind",
            "projectId",
            "placementId",
            "modelRouteId",
            "providerAccountId",
            "runtimeGeneration",
            "nativeEpoch",
        ]
        .iter()
        .any(|field| binding.get(field) != observation.get(field))
    }) {
        return Ok(());
    }
    let current = context::execution(tx, owner, chat).await?;
    if !context::same_placement(
        current.as_ref(),
        &observation["workerId"],
        Some(observation),
    )? || !context::same_runtime_route(current.as_ref(), Some(observation))?
        || current.as_ref().and_then(|c| c.get("threadId")) != observation.get("threadId")
    {
        return Ok(());
    }
    if truthy(marker.get("admission")) {
        return reject("goal-recovery-already-admitted");
    }
    let worker = text(&observation["workerId"])?;
    let source = context::read(
        Executor::Transaction(tx),
        owner,
        &worker,
        &text(&marker["source"]["operationId"])?,
        &text(&marker["source"]["operationGeneration"])?,
    )
    .await?;
    if source["chat_id"] != chat
        || !truthy(source.get("execution_completed_at"))
        || recovered(&source).is_none_or(|s| !deep_equal(s, &marker["source"]))
    {
        return reject("goal-recovery-source-unsettled");
    }
    let rows = tx.query("SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE chat_id=$1 AND awaiting_goal=true AND goal_epoch=$2 AND status IN ('dispatched','uncertain') LIMIT 2", &[&chat,&text(&receipt["source"]["goalEpoch"])?]).await?;
    let claims = rows
        .iter()
        .map(|row| -> Result<Value> { Ok(serde_json::from_str(&row.get::<String>(0)?)?) })
        .collect::<Result<Vec<_>>>()?;
    if claims.len() > 1 {
        return reject("goal-recovery-claim-conflict");
    }
    for claim in &claims {
        if truthy(claim.get("native_turn_id"))
            || truthy(claim.get("goal_operation_id"))
            || truthy(claim.get("goal_operation_generation"))
            || !truthy(claim.get("operation_id"))
            || !truthy(claim.get("operation_generation"))
        {
            return reject("goal-recovery-already-admitted");
        }
        let parent = context::read(
            Executor::Transaction(tx),
            owner,
            &worker,
            &text(&claim["operation_id"])?,
            &text(&claim["operation_generation"])?,
        )
        .await?;
        if parent["chat_id"] != chat
            || parent["method"] != "thread/goal/set"
            || parent["status"] != "applied"
        {
            return reject("goal-recovery-parent-unsettled");
        }
    }
    tx.query(
        "UPDATE managed_queue_states SET goal_recovery=NULL WHERE chat_id=$1",
        &[&chat],
    )
    .await?;
    // The original setter is already applied. Retire its exact claim without
    // putting that old Goal prompt back into the current native Goal's queue.
    for claim in claims {
        tx.query(
            "UPDATE managed_queue_claims SET status='consumed' WHERE id=$1",
            &[&text(&claim["id"])?],
        )
        .await?;
        let revision = i32::try_from(
            claim["prompt_revision"]
                .as_i64()
                .ok_or_else(|| anyhow::anyhow!("Goal claim revision is missing"))?,
        )?;
        tx.query("UPDATE queued_prompts SET state='consumed',updated_at=now() WHERE id=$1 AND chat_id=$2 AND revision=$3 AND state='claimed'", &[&text(&claim["prompt_id"])?,&chat,&revision]).await?;
    }
    queue::changed(tx, chat).await
}
