//! Preserve the pending first cycle without replaying its applied Goal setter.
use super::*;
use crate::native_commands::goal_handoff;

pub(super) fn retained(claim: &Value, expected: &Value) -> bool {
    goal_handoff::identity(claim).is_some_and(|v| deep_equal(&v, expected))
        && matches!(claim["status"].as_str(), Some("dispatched" | "uncertain"))
        && !truthy(claim.get("native_turn_id"))
        && !truthy(claim.get("goal_operation_id"))
        && !truthy(claim.get("goal_operation_generation"))
}

pub(super) async fn assert_prompt(
    tx: &Transaction<'_>,
    chat: &str,
    expected: &Value,
) -> Result<()> {
    if tx.query("SELECT id FROM queued_prompts WHERE id=$1 AND chat_id=$2 AND revision::text=$3 AND state='claimed' LIMIT 1", &[&text(&expected["promptId"])?,&chat,&expected["promptRevision"].stringify()]).await?.is_empty()
    { return reject("handoff-native-operation-pending"); }
    Ok(())
}

pub(super) async fn capture(
    tx: &Transaction<'_>,
    command: &Value,
    claims: &[Value],
) -> Result<Option<Value>> {
    if claims.is_empty() {
        return Ok(None);
    }
    let claim = &claims[0];
    let identity = goal_handoff::identity(claim);
    let attempt = &command["intent"]["autonomousAttempt"];
    if claims.len() != 1
        || identity.is_none()
        || !truthy(attempt.get("goalEpoch"))
        || claim.get("goal_epoch") != attempt.get("goalEpoch")
        || claim.get("chat_id") != command.get("chat_id")
        || !matches!(claim["status"].as_str(), Some("dispatched" | "uncertain"))
        || truthy(claim.get("native_turn_id"))
        || claim.get("goal_operation_id") != command.get("operation_id")
        || claim.get("goal_operation_generation") != command.get("operation_generation")
    {
        return reject("handoff-native-operation-pending");
    }
    let identity = identity.unwrap();
    let owner = text(&command["owner_id"])?;
    let worker = text(&command["worker_id"])?;
    let chat = text(&command["chat_id"])?;
    let parent = one(Executor::Transaction(tx), "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1 AND operation_generation=$2 AND owner_id=$3 AND worker_id=$4 AND chat_id=$5", &[&text(&identity["operationId"])?,&text(&identity["operationGeneration"])?,&owner,&worker,&chat]).await?;
    let Some(parent) = parent else {
        return reject("handoff-native-operation-pending");
    };
    if parent["method"] != "thread/goal/set"
        || parent["status"] != "applied"
        || !goal_handoff::session_matches(
            tx,
            &owner,
            &worker,
            claim,
            &parent["identity"],
            &command["identity"],
        )
        .await?
    {
        return reject("handoff-native-operation-pending");
    }
    assert_prompt(tx, &chat, &identity).await?;
    Ok(Some(identity))
}

pub(super) async fn validate_withdrawal(
    tx: &Transaction<'_>,
    root: &Value,
    expected: &Value,
    already: bool,
) -> Result<()> {
    if root["intent"]["autonomousAttempt"].get("goalEpoch") != expected.get("goalEpoch") {
        return reject("handoff-native-operation-pending");
    }
    let chat = text(&root["chat_id"])?;
    let active = tx.query("SELECT id FROM managed_queue_claims WHERE chat_id=$1 AND status IN ('claimed','accepted','dispatched','uncertain') LIMIT 2", &[&chat]).await?;
    if active.len() > 1
        || active
            .first()
            .map(|r| r.get::<String>(0))
            .transpose()?
            .is_some_and(|id| expected["id"] != id)
    {
        return reject("handoff-native-operation-pending");
    }
    let claim = one(
        Executor::Transaction(tx),
        "SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE id=$1 AND chat_id=$2",
        &[&text(&expected["id"])?, &chat],
    )
    .await?;
    let Some(claim) = claim else {
        return reject("handoff-native-operation-pending");
    };
    let child = claim.get("goal_operation_id") == root.get("operation_id")
        && claim.get("goal_operation_generation") == root.get("operation_generation");
    let retired = already
        && !truthy(claim.get("goal_operation_id"))
        && !truthy(claim.get("goal_operation_generation"));
    if goal_handoff::identity(&claim).is_none_or(|v| !deep_equal(&v, expected))
        || truthy(claim.get("native_turn_id"))
        || (!child && !retired)
    {
        return reject("handoff-native-operation-pending");
    }
    if matches!(claim["status"].as_str(), Some("dispatched" | "uncertain")) {
        assert_prompt(tx, &chat, expected).await?;
    } else if !(claim["status"] == "rejected" && root["status"] == "rejected") {
        return reject("handoff-native-operation-pending");
    }
    Ok(())
}
