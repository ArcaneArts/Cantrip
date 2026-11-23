//! Recover the existing applied input without inventing a child or replaying a setter.
use super::{
    admit::{raw_one, text},
    context, goal_handoff,
    managed_queue::{NO_HANDOFF, NO_PERMISSION, deep_equal},
    queue,
    settings_persistence::parse,
};
use crate::{
    database::Transaction,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::Result;

/// Caller holds the canonical chat lock. The claim remains the sole input.
pub(super) async fn read(tx: &Transaction<'_>, owner: &str, chat: &str) -> Result<Option<Value>> {
    let Some(current) = context::execution(tx, owner, chat).await? else {
        return Ok(None);
    };
    if current["experience"] != "agent" || !truthy(current.get("threadId")) {
        return Ok(None);
    }
    if tx.query(&format!("SELECT c.id FROM chats c WHERE c.id=$1 AND c.owner_id=$2 AND c.archived_at IS NULL AND c.automation_paused=false AND c.managed_autonomy_stopped=false AND {NO_PERMISSION} AND {NO_HANDOFF} AND NOT EXISTS (SELECT 1 FROM managed_queue_states s WHERE s.chat_id=c.id AND s.goal_recovery IS NOT NULL)"), &[&chat,&owner]).await?.is_empty() { return Ok(None); }
    let worker = text(&current["workerId"])?;
    let rows = tx.query("SELECT jsonb_build_object('claim',to_jsonb(q),'parent',to_jsonb(n))::text FROM managed_queue_claims q JOIN native_commands n ON n.operation_id=q.operation_id AND n.operation_generation=q.operation_generation AND n.chat_id=$1 AND n.owner_id=$2 AND n.worker_id=$3 AND n.method='thread/goal/set' AND n.status='applied' JOIN queued_prompts p ON p.id=q.prompt_id AND p.chat_id=$1 AND p.revision=q.prompt_revision AND p.state='claimed' WHERE q.chat_id=$1 AND q.awaiting_goal=true AND q.goal_cancelled=false AND q.native_turn_id IS NULL AND q.status IN ('dispatched','uncertain') LIMIT 2", &[&chat,&owner,&worker]).await?;
    if rows.len() != 1 {
        return Ok(None);
    }
    let item: Value = serde_json::from_str(&rows[0].get::<String>(0)?)?;
    let claim = &item["claim"];
    let parent = &item["parent"];
    if ["goal_epoch", "operation_id", "operation_generation"]
        .iter()
        .any(|k| !truthy(claim.get(k)))
    {
        return Ok(None);
    }
    let settings = raw_one(
        tx,
        "SELECT state::text FROM native_settings_states WHERE chat_id=$1",
        &[&chat],
    )
    .await?;
    let generation = settings
        .as_ref()
        .and_then(|s| s["binding"].get("runtimeGeneration"))
        .filter(|g| !g.is_null())
        .unwrap_or(&parent["identity"]["runtimeGeneration"]);
    let placement = current
        .get("worktreeId")
        .filter(|p| !p.is_null())
        .unwrap_or(&current["scratchRootId"]);
    let session = json!({"chatId":chat,"threadId":current["threadId"],"contextKind":current["contextKind"],"projectId":current["projectId"],"placementId":placement,
      "modelRouteId":current["modelRouteId"],"providerAccountId":current["providerAccountId"],"runtimeGeneration":generation,"connectionId":Value::Null});
    if !goal_handoff::session_matches(tx, owner, &worker, claim, &parent["identity"], &session)
        .await?
    {
        return Ok(None);
    }
    let mut admission = Value::Null;
    if truthy(claim.get("goal_operation_id")) || truthy(claim.get("goal_operation_generation")) {
        if !truthy(claim.get("goal_operation_id"))
            || !truthy(claim.get("goal_operation_generation"))
        {
            return Ok(None);
        }
        let child = raw_one(tx,"SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1 AND operation_generation=$2 AND owner_id=$3 AND worker_id=$4 AND chat_id=$5", &[&text(&claim["goal_operation_id"])?,&text(&claim["goal_operation_generation"])?,&owner,&worker,&chat]).await?;
        let Some(child) = child else {
            return Ok(None);
        };
        if child["status"] != "accepted"
            || [
                "execution_completed_at",
                "result_digest",
                "protected_result",
                "terminal_result_digest",
                "protected_terminal_result",
            ]
            .iter()
            .any(|k| truthy(child.get(k)))
            || crate::native_handoffs::autonomous_attempt(&child)?
                .as_ref()
                .is_none_or(|a| a.get("goalEpoch") != claim.get("goal_epoch"))
        {
            return Ok(None);
        }
        if !tx
            .query(
                "SELECT operation_id FROM native_command_turns WHERE operation_id=$1 LIMIT 1",
                &[&text(&child["operation_id"])?],
            )
            .await?
            .is_empty()
        {
            return Ok(None);
        }
        admission = json!({"operationId":child["operation_id"],"operationGeneration":child["operation_generation"],"workerGeneration":child["intent"]["workerGeneration"]});
    }
    let value = json!({"claimId":claim["id"],"promptId":claim["prompt_id"],"promptRevision":claim["prompt_revision"],"operationId":claim["operation_id"],"operationGeneration":claim["operation_generation"],"threadId":current["threadId"],"goalEpoch":claim["goal_epoch"],"admission":admission});
    Ok(parse("nativeGoalClaimRecoverySchema", &value).ok())
}

/// Only a negative actual Goal read in the current full binding may retire it.
pub(super) async fn confirm(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    receipt: &Value,
) -> Result<()> {
    if receipt["status"] != "ineligible" {
        return Ok(());
    }
    let Some(current) = read(tx, owner, chat).await? else {
        return Ok(());
    };
    if truthy(current.get("admission")) || !deep_equal(&current, &receipt["claim"]) {
        return Ok(());
    }
    let observed = &receipt["observation"];
    if observed["goalEpoch"] == current["goalEpoch"] && observed["goalStatus"] == "active" {
        return Ok(());
    }
    let settings = raw_one(
        tx,
        "SELECT state::text FROM native_settings_states WHERE chat_id=$1",
        &[&chat],
    )
    .await?;
    let Some(binding) = settings
        .as_ref()
        .and_then(|s| s.get("binding"))
        .filter(|b| !b.is_null())
    else {
        return Ok(());
    };
    let context = context::execution(tx, owner, chat).await?;
    if context.is_none()
        || !context::same_placement(context.as_ref(), &observed["workerId"], Some(observed))?
        || !context::same_runtime_route(context.as_ref(), Some(observed))?
        || context.as_ref().unwrap().get("threadId") != observed.get("threadId")
        || [
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
        .any(|k| binding.get(k) != observed.get(k))
    {
        return Ok(());
    }
    tx.query(
        "UPDATE managed_queue_claims SET status='consumed' WHERE id=$1",
        &[&text(&current["claimId"])?],
    )
    .await?;
    tx.query("UPDATE queued_prompts SET state='consumed',updated_at=$1 WHERE id=$2 AND chat_id=$3 AND revision::text=$4 AND state='claimed'", &[&crate::auth::now(),&text(&current["promptId"])?,&chat,&current["promptRevision"].stringify()]).await?;
    queue::changed(tx, chat).await
}
