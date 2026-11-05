use super::*;

pub(in crate::native_commands) async fn assert_admission(
    tx: &Transaction<'_>,
    input: &Value,
) -> Result<()> {
    let chat = text(&input["session"]["chatId"])?;
    let marker = read(tx, &chat).await?;
    let source = input["intent"].get("goalRecovery").filter(|v| !v.is_null());
    if input["method"] != "turn/start" {
        if source.is_some() {
            return reject("invalid-goal-recovery");
        }
        return Ok(());
    }
    if marker.is_none() && source.is_none() {
        return Ok(());
    }
    let (Some(marker), Some(source)) = (marker, source) else {
        return reject("stale-goal-recovery");
    };
    if !deep_equal(&marker["source"], source)
        || input["origin"] != "autonomous"
        || input["intent"]["autonomousAttempt"].get("goalEpoch") != source.get("goalEpoch")
        || input["session"].get("threadId") != source.get("threadId")
        || !truthy(input["intent"].get("workerGeneration"))
    {
        return reject("stale-goal-recovery");
    }
    if truthy(marker.get("admission")) {
        return reject("goal-recovery-already-admitted");
    }
    let current = raw_one(
        tx,
        "SELECT to_jsonb(c)::text FROM chats c WHERE id=$1",
        &[&chat],
    )
    .await?;
    if current.is_none_or(|c| {
        truthy(c.get("automation_paused")) || truthy(c.get("managed_autonomy_stopped"))
    }) {
        return reject("goal-recovery-ineligible");
    }
    Ok(())
}

pub(in crate::native_commands) async fn record_admission(
    tx: &Transaction<'_>,
    input: &Value,
    row: &Value,
) -> Result<()> {
    if row["status"] != "accepted" || !truthy(input["intent"].get("goalRecovery")) {
        return Ok(());
    }
    let chat = text(&row["chat_id"])?;
    let marker = read(tx, &chat).await?;
    let Some(marker) = marker.filter(|m| {
        !truthy(m.get("admission"))
            && deep_equal(&m["source"], &input["intent"]["goalRecovery"])
            && truthy(input["intent"].get("workerGeneration"))
    }) else {
        return reject("stale-goal-recovery");
    };
    let admission = json!({"operationId":row["operation_id"],
        "operationGeneration":row["operation_generation"],"workerGeneration":input["intent"]["workerGeneration"]});
    let marker = json!({"source":marker["source"],"admission":admission}).stringify();
    tx.query(
        "UPDATE managed_queue_states SET goal_recovery=$1::text::jsonb WHERE chat_id=$2",
        &[&marker, &chat],
    )
    .await?;
    Ok(())
}

/// Worker ticket adoption precedes this transaction. Dispatch and marker removal
/// commit atomically, so an accepted marker source has never forwarded input.
pub(in crate::native_commands) async fn dispatch(
    tx: &Transaction<'_>,
    row: &Value,
    generation: &Value,
) -> Result<()> {
    let intent = &row["intent"];
    if !truthy(intent.get("goalRecovery")) {
        return Ok(());
    }
    let chat = text(&row["chat_id"])?;
    let marker = read(tx, &chat).await?;
    let current = raw_one(
        tx,
        "SELECT to_jsonb(c)::text FROM chats c WHERE id=$1",
        &[&chat],
    )
    .await?;
    if marker.as_ref().is_none_or(|m| {
        !deep_equal(&m["source"], &intent["goalRecovery"])
            || m["admission"].get("operationId") != row.get("operation_id")
            || m["admission"].get("operationGeneration") != row.get("operation_generation")
            || m["admission"].get("workerGeneration") != Some(generation)
    }) || !truthy(Some(generation))
        || intent.get("workerGeneration") != Some(generation)
        || current.is_none_or(|c| {
            truthy(c.get("automation_paused")) || truthy(c.get("managed_autonomy_stopped"))
        })
    {
        return reject("stale-goal-recovery");
    }
    tx.query(
        "UPDATE managed_queue_states SET goal_recovery=NULL WHERE chat_id=$1",
        &[&chat],
    )
    .await?;
    queue::changed(tx, &chat).await
}
