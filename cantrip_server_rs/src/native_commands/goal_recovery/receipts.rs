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
    tx.query(
        "UPDATE managed_queue_states SET goal_recovery=$1::text::jsonb WHERE chat_id=$2",
        &[
            &json!({"source":marker["source"],"admission":if truthy(row.get("execution_completed_at")) { Value::Null } else { marker["admission"].clone() }}).stringify(),
            &chat,
        ],
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
    if truthy(marker.get("admission")) {
        return reject("goal-recovery-already-admitted");
    }
    tx.query(
        "UPDATE managed_queue_states SET goal_recovery=NULL WHERE chat_id=$1",
        &[&chat],
    )
    .await?;
    let claims = tx.query("UPDATE managed_queue_claims SET status='rejected' WHERE chat_id=$1 AND awaiting_goal=true AND goal_epoch=$2 AND goal_operation_id IS NULL AND status IN ('dispatched','uncertain') RETURNING id,prompt_id,prompt_revision", &[&chat,&text(&receipt["source"]["goalEpoch"])?]).await?;
    for claim in claims {
        tx.query("UPDATE queued_prompts SET state='pending' WHERE id=$1 AND revision=$2 AND state='claimed'", &[&claim.get::<String>(1)?,&claim.get::<i32>(2)?]).await?;
    }
    queue::changed(tx, chat).await
}
