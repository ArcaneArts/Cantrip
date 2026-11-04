//! Compensation only for a limiter rejection before its delegate was invoked.
//! Worker errors, timeouts, missing notifications and disconnects are not proof.
use super::{
    Repository,
    admit::{raw_one, text},
    context,
};
use crate::{
    chats::execution_lanes,
    database::{Executor, Transaction},
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::Result;
use futures::FutureExt;

async fn defer(
    tx: &Transaction<'_>,
    owner: &str,
    worker: &str,
    operation: &str,
    generation: &str,
) -> Result<bool> {
    let captured = context::read(
        Executor::Transaction(tx),
        owner,
        worker,
        operation,
        generation,
    )
    .await?;
    let chat = text(&captured["chat_id"])?;
    context::lock_chat(tx, owner, &chat).await?;
    let row = context::read(
        Executor::Transaction(tx),
        owner,
        worker,
        operation,
        generation,
    )
    .await?;
    if row["rejection_code"] == "worker-transport-deferred"
        && truthy(row.get("logical_completed_at"))
    {
        return Ok(true);
    }
    if row["origin"] != "gui"
        || row["kind"] != "start"
        || row["method"] != "turn/start"
        || row["status"] != "accepted"
        || row.get("logical_operation_id") != row.get("operation_id")
        || [
            "previous_operation_id",
            "logical_completed_at",
            "execution_completed_at",
            "result_digest",
            "terminal_result_digest",
            "terminal_evidence",
        ]
        .iter()
        .any(|key| truthy(row.get(key)))
        || !truthy(row.get("execution_lane_id"))
        || !truthy(row.get("activation_generation"))
    {
        return Ok(false);
    }
    let activation = raw_one(
        tx,
        "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",
        &[&chat],
    )
    .await?
    .unwrap_or(Value::Null);
    let claim = raw_one(tx,
        "SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE operation_id=$1 AND operation_generation=$2",
        &[&operation, &generation],
    ).await?.unwrap_or(Value::Null);
    // Reject contradictory consumption. Absence is not the positive evidence:
    // that evidence comes from the actual pre-delegate admission failure.
    let observed = !tx
        .query(
            "SELECT operation_id FROM native_command_turns WHERE operation_id=$1 LIMIT 1",
            &[&operation],
        )
        .await?
        .is_empty();
    if !truthy(activation.get("active"))
        || truthy(activation.get("logical_cancelled"))
        || activation.get("generation") != row.get("activation_generation")
        || activation.get("operation_id") != row.get("operation_id")
        || activation.get("execution_lane_id") != row.get("execution_lane_id")
        || truthy(activation.get("native_turn_id"))
        || truthy(activation.get("runtime_generation"))
        || claim["status"] != "accepted"
        || truthy(claim.get("native_turn_id"))
        || observed
    {
        return Ok(false);
    }
    let prompt = raw_one(
        tx,
        "SELECT to_jsonb(p)::text FROM queued_prompts p WHERE id=$1",
        &[&text(&claim["prompt_id"])?],
    )
    .await?;
    let removed = prompt
        .as_ref()
        .is_none_or(|p| p["state"] == "removed" || p["state"] == "consumed");
    if !execution_lanes::finish_in_transaction(
        tx,
        &chat,
        &text(&row["execution_lane_id"])?,
        "idle",
        &json!({"markUnreadCompletion": false}),
    )
    .boxed()
    .await?
    {
        return Ok(false);
    }
    let now = crate::auth::now();
    tx.query(
        "UPDATE native_commands SET status='rejected',rejection_code='worker-transport-deferred',terminal_evidence='{\"kind\":\"not-dispatched\",\"source\":\"worker-command-admission\"}'::jsonb,logical_completed_at=$1,execution_completed_at=$1,updated_at=$1 WHERE operation_id=$2 AND operation_generation=$3",
        &[&now, &operation, &generation],
    ).await?;
    tx.query(
        "UPDATE native_command_activations SET active=false WHERE chat_id=$1 AND generation=$2",
        &[&chat, &text(&row["activation_generation"])?],
    )
    .await?;
    tx.query(
        "UPDATE managed_queue_claims SET status=$1 WHERE id=$2",
        &[
            &if removed { "rejected" } else { "deferred" },
            &text(&claim["id"])?,
        ],
    )
    .await?;
    if !removed {
        tx.query(
            "UPDATE queued_prompts SET state='pending',updated_at=$1 WHERE id=$2",
            &[&now, &text(&claim["prompt_id"])?],
        )
        .await?;
    }
    super::queue::changed(tx, &chat).await?;
    Ok(true)
}

impl Repository {
    pub async fn defer_undispatched_gui(
        &self,
        owner: &str,
        worker: &str,
        operation: &str,
        generation: &str,
    ) -> Result<bool> {
        let (owner, worker, operation, generation) = (
            owner.to_owned(),
            worker.to_owned(),
            operation.to_owned(),
            generation.to_owned(),
        );
        self.database
            .transaction(|tx| {
                Box::pin(async move { defer(tx, &owner, &worker, &operation, &generation).await })
            })
            .await
    }
}
