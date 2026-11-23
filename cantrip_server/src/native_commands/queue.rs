//! Queue and autonomy changes share the command writer's canonical chat transaction.
use crate::{
    database::Transaction,
    wire::{Value, coercion::truthy},
};
use anyhow::Result;
pub(crate) async fn changed(tx: &Transaction<'_>, chat: &str) -> Result<()> {
    tx.query(
        "UPDATE managed_queue_states SET revision=revision+1 WHERE chat_id=$1",
        &[&chat],
    )
    .await?;
    Ok(())
}
pub(super) async fn cancel_goal_handoffs(tx: &Transaction<'_>, chat: &str) -> Result<()> {
    let removed = tx.query("UPDATE managed_queue_states SET goal_recovery=NULL WHERE chat_id=$1 AND goal_recovery IS NOT NULL RETURNING chat_id", &[&chat]).await?;
    let rows=tx.query("SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE chat_id=$1 AND awaiting_goal=true AND goal_operation_id IS NULL AND status IN ('accepted','dispatched','uncertain')",&[&chat]).await?;
    for row in &rows {
        use super::admit::{raw_one, text};
        let claim: Value = serde_json::from_str(&row.get::<String>(0)?)?;
        let parent = if truthy(claim.get("operation_id"))
            && truthy(claim.get("operation_generation"))
        {
            raw_one(tx,"SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1 AND operation_generation=$2 AND chat_id=$3 AND method='thread/goal/set'", &[&text(&claim["operation_id"])?,&text(&claim["operation_generation"])?,&chat]).await?
        } else {
            None
        };
        let consumed = parent.as_ref().is_some_and(|p| p["status"] == "applied");
        let rejected = parent
            .as_ref()
            .is_some_and(|p| matches!(p["status"].as_str(), Some("accepted" | "rejected")));
        // A dispatched setter with no response remains claimed and uncertain.
        // Cancelling the first cycle cannot turn missing evidence into replay.
        if parent.as_ref().is_some_and(|p| p["status"] == "accepted") {
            let operation = super::admit::text(&claim["operation_id"])?;
            let generation = super::admit::optional(&claim["operation_generation"])?;
            let now = crate::auth::now();
            tx.query("UPDATE native_commands SET status='rejected',rejection_code='queue-goal-handoff-cancelled',updated_at=$1 WHERE operation_id=$2 AND operation_generation=$3 AND status='accepted'",&[&now,&operation,&generation]).await?;
        }
        let status = if consumed {
            "consumed"
        } else if rejected {
            "rejected"
        } else {
            "uncertain"
        };
        tx.query(
            "UPDATE managed_queue_claims SET goal_cancelled=true,status=$1 WHERE id=$2",
            &[&status, &text(&claim["id"])?],
        )
        .await?;
        let prompt = super::admit::text(&claim["prompt_id"])?;
        let state = if consumed {
            "consumed"
        } else if rejected {
            "pending"
        } else {
            "claimed"
        };
        tx.query(
            "UPDATE queued_prompts SET state=$1,updated_at=$2 WHERE id=$3 AND chat_id=$4 AND revision::text=$5 AND state='claimed'",
            &[&state,&crate::auth::now(),&prompt,&chat,&claim["prompt_revision"].stringify()],
        )
        .await?;
    }
    if !rows.is_empty() || !removed.is_empty() {
        changed(tx, chat).await?;
    }
    Ok(())
}
pub(super) async fn stop_autonomy(tx: &Transaction<'_>, chat: &str) -> Result<()> {
    tx.query("UPDATE chats SET managed_autonomy_stopped=true,managed_input_revision=managed_input_revision+1 WHERE id=$1",&[&chat]).await?;
    tx.query("UPDATE native_command_activations SET logical_cancelled=true WHERE chat_id=$1 AND active=true",&[&chat]).await?;
    changed(tx, chat).await?;
    cancel_goal_handoffs(tx, chat).await?;
    let now = crate::auth::now();
    tx.query("UPDATE native_commands SET status='rejected',rejection_code='autonomy-stopped',updated_at=$1 WHERE chat_id=$2 AND status='accepted' AND intent->>'resumeAutonomy'='true'",&[&now,&chat]).await?;
    Ok(())
}
pub(super) async fn settle(
    tx: &Transaction<'_>,
    row: &Value,
    native_turn: Option<&str>,
    goal_epoch: Option<&Value>,
) -> Result<()> {
    use super::admit::{raw_one, reject, text};
    let operation = text(&row["operation_id"])?;
    let generation = text(&row["operation_generation"])?;
    let Some(claim)=raw_one(tx,"SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE (operation_id=$1 AND operation_generation=$2) OR (goal_operation_id=$1 AND goal_operation_generation=$2)",&[&operation,&generation]).await? else {return Ok(());};
    if matches!(
        claim["status"].as_str(),
        Some("consumed" | "rejected" | "deferred")
    ) {
        return Ok(());
    }
    let goal_epoch = goal_epoch.filter(|value| truthy(Some(value)));
    let id = text(&claim["id"])?;
    if let Some(epoch) = goal_epoch {
        if row["method"] != "thread/goal/set"
            || !truthy(claim.get("awaiting_goal"))
            || (truthy(claim.get("goal_epoch")) && claim.get("goal_epoch") != Some(epoch))
        {
            return reject("stale-goal-epoch");
        }
        let encoded_epoch = text(epoch)?;
        tx.query(
            "UPDATE managed_queue_claims SET goal_epoch=$1 WHERE id=$2",
            &[&encoded_epoch, &id],
        )
        .await?;
    }
    let parent_goal =
        truthy(claim.get("awaiting_goal")) && claim.get("operation_id") == row.get("operation_id");
    if parent_goal
        && row["status"] == "applied"
        && !truthy(claim.get("goal_epoch"))
        && goal_epoch.is_none()
    {
        return reject("goal-epoch-required");
    }
    let consumed = (!parent_goal || truthy(claim.get("goal_cancelled")))
        && row["status"] == "applied"
        && truthy(row.get("protected_result"))
        && truthy(row.get("result_digest"));
    let deferred = row["status"] == "rejected"
        && row["rejection_code"] == "native-settings-pending"
        && row["terminal_evidence"]
            .get("kind")
            .is_some_and(|k| *k == "deferred");
    let rejected = row["status"] == "rejected" && !deferred;
    let mut applied_goal = parent_goal && row["status"] == "applied";
    if truthy(claim.get("awaiting_goal")) && !parent_goal && truthy(claim.get("operation_id")) {
        applied_goal = raw_one(tx,"SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1 AND operation_generation=$2 AND chat_id=$3 AND owner_id=$4 AND method='thread/goal/set'", &[&text(&claim["operation_id"])?,&text(&claim["operation_generation"])?,&text(&claim["chat_id"])?,&text(&row["owner_id"])?]).await?.is_some_and(|p| p["status"] == "applied");
    }
    let status = if deferred {
        "deferred"
    } else if consumed {
        "consumed"
    } else if rejected {
        "rejected"
    } else if row["status"] == "uncertain" {
        "uncertain"
    } else {
        claim["status"].as_str().unwrap_or("")
    };
    let native_turn = native_turn.filter(|s| !s.is_empty());
    if let Some(turn) = native_turn {
        tx.query(
            "UPDATE managed_queue_claims SET status=$1,native_turn_id=$2 WHERE id=$3",
            &[&status, &turn, &id],
        )
        .await?;
    } else {
        tx.query(
            "UPDATE managed_queue_claims SET status=$1 WHERE id=$2",
            &[&status, &id],
        )
        .await?;
    }
    if consumed || rejected || deferred {
        let state = if consumed || applied_goal {
            "consumed"
        } else {
            "pending"
        };
        let prompt = text(&claim["prompt_id"])?;
        let chat = text(&claim["chat_id"])?;
        let now = crate::auth::now();
        tx.query(
            "UPDATE queued_prompts SET state=$1,updated_at=$2 WHERE id=$3 AND chat_id=$4 AND revision::text=$5 AND state='claimed'",
            &[&state, &now, &prompt, &chat, &claim["prompt_revision"].stringify()],
        )
        .await?;
        changed(tx, &chat).await?;
    }
    Ok(())
}
