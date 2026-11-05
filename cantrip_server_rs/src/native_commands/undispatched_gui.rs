//! Compensation only for a limiter rejection before its delegate was invoked.
//! Worker errors, timeouts, missing notifications and disconnects are not proof.
use super::transport_evidence::is_transport_closure;
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
use sha2::{Digest, Sha256};

async fn defer(
    tx: &Transaction<'_>,
    owner: &str,
    worker: &str,
    operation: &str,
    generation: &str,
    proof: Option<&Value>,
) -> Result<bool> {
    let rejection = if proof.is_some() {
        "worker-inference-deferred"
    } else {
        "worker-transport-deferred"
    };
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
    if row["rejection_code"] == rejection && truthy(row.get("logical_completed_at")) {
        return Ok(true);
    }
    let closed_transport = proof.is_some()
        && truthy(row.get("logical_completed_at"))
        && truthy(row.get("execution_completed_at"))
        && is_transport_closure(row.get("terminal_evidence"))
        && ((row["status"] == "rejected" && row["rejection_code"] == "not-dispatched")
            || (row["status"] == "uncertain" && row["rejection_code"] == "missing-native-receipt"));
    if row["origin"] != "gui"
        || row["kind"] != "start"
        || row["method"] != "turn/start"
        || (row["status"] != "accepted" && !closed_transport)
        || row.get("logical_operation_id") != row.get("operation_id")
        || [
            "previous_operation_id",
            "result_digest",
            "protected_result",
            "terminal_result_digest",
            "protected_terminal_result",
        ]
        .iter()
        .any(|key| truthy(row.get(key)))
        || (!closed_transport
            && [
                "logical_completed_at",
                "execution_completed_at",
                "terminal_evidence",
            ]
            .iter()
            .any(|key| truthy(row.get(key))))
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
    // Reject contradictory consumption. Missing notifications are never the
    // positive proof, whether the caller supplies journal or limiter evidence.
    let observed = !tx
        .query(
            "SELECT operation_id FROM native_command_turns WHERE operation_id=$1 LIMIT 1",
            &[&operation],
        )
        .await?
        .is_empty();
    let same_activation = activation.get("generation") == row.get("activation_generation")
        && activation.get("operation_id") == row.get("operation_id")
        && activation.get("execution_lane_id") == row.get("execution_lane_id");
    if (!closed_transport && (!truthy(activation.get("active")) || !same_activation))
        || (same_activation
            && (truthy(activation.get("logical_cancelled"))
                || (truthy(activation.get("native_turn_id"))
                    && proof.is_none_or(|p| {
                        activation.get("native_turn_id") != row["intent"].get("expectedTurnId")
                            || (truthy(p["identity"]["recovery"].get("turnId"))
                                && p["identity"]["recovery"].get("turnId")
                                    != activation.get("native_turn_id"))
                    }))
                || proof.map_or_else(
                    || truthy(activation.get("runtime_generation")),
                    |_| {
                        activation.get("runtime_generation")
                            != row["identity"].get("runtimeGeneration")
                    },
                )))
        || (claim["status"] != "accepted"
            && !(closed_transport
                && matches!(
                    claim["status"].as_str(),
                    Some("rejected" | "uncertain" | "dispatched")
                )))
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
    if !closed_transport
        && !execution_lanes::finish_in_transaction(
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
    let evidence = proof.map_or_else(
        || json!({"kind":"not-dispatched","source":"worker-command-admission"}),
        |p| json!({"kind":"not-started","source":"worker-inference-journal","key":p["key"],"workerGeneration":p["workerGeneration"],"runtimeGeneration":p["identity"]["runtimeGeneration"],"revision":p["revision"]}),
    );
    let evidence = serde_json::to_string(&evidence)?;
    tx.query(
        "UPDATE native_commands SET status='rejected',rejection_code=$4,terminal_evidence=$5::jsonb,logical_completed_at=$1,execution_completed_at=$1,updated_at=$1 WHERE operation_id=$2 AND operation_generation=$3",
        &[&now, &operation, &generation, &rejection, &evidence],
    ).await?;
    tx.query(
        "UPDATE native_command_activations SET active=false WHERE chat_id=$1 AND generation=$2 AND operation_id=$3",
        &[&chat, &text(&row["activation_generation"])?, &operation],
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
                Box::pin(
                    async move { defer(tx, &owner, &worker, &operation, &generation, None).await },
                )
            })
            .await
    }

    /// Current replacement worker only, after native scope takeover fenced the
    /// previous generation. Inputs remain in the canonical encrypted queue.
    pub async fn reconcile_inference(&self, owner: &str, input: &Value) -> Result<Value> {
        let record = &input["record"];
        let identity = &record["identity"]["recovery"];
        let unresolved = json!({"key":record["key"],"chatId":record["identity"]["chatId"],"disposition":"unresolved"});
        let parts = [
            text(&record["workerGeneration"])?,
            text(&record["identity"]["runtimeGeneration"])?,
            text(&record["identity"]["operationId"])?,
        ];
        let key = format!("{:x}", Sha256::digest(serde_json::to_vec(&parts)?));
        let never_started = (record["everGranted"] == false && record["state"] != "granted")
            || (record["state"] == "released" && record["outcome"] == "never-started");
        if record.get("workerGeneration") == input.get("workerGeneration")
            || record["key"].as_str() != Some(key.as_str())
            || !never_started
            || !["commandId", "commandGeneration", "messageId"]
                .iter()
                .all(|key| truthy(identity.get(key)))
            || record["identity"].get("operationId") != identity.get("commandGeneration")
        {
            return Ok(unresolved);
        }
        let (owner, worker, operation, generation, record) = (
            owner.to_owned(),
            text(&input["workerId"])?,
            text(&identity["commandId"])?,
            text(&identity["commandGeneration"])?,
            record.clone(),
        );
        let base = unresolved.clone();
        let result = self.database.transaction(|tx|Box::pin(async move {
            let captured = context::read(Executor::Transaction(tx), &owner, &worker, &operation, &generation).await?;
            let chat = text(&captured["chat_id"])?;
            context::lock_chat(tx, &owner, &chat).await?;
            let row = context::read(Executor::Transaction(tx), &owner, &worker, &operation, &generation).await?;
            let identity = &record["identity"]["recovery"];
            let mut result = base;
            if row.get("chat_id") != record["identity"].get("chatId") ||
                row.get("logical_client_message_id") != identity.get("messageId") ||
                (truthy(identity.get("threadId")) && row["identity"].get("threadId") != identity.get("threadId")) {
                return Ok(result);
            }
            if truthy(row.get("logical_completed_at")) && !is_transport_closure(row.get("terminal_evidence")) &&
              (row["rejection_code"] != "worker-inference-deferred" ||
                row["terminal_evidence"].get("key") != record.get("key")) {
                result["disposition"] = json!("retired");
                return Ok(result);
            }
            if !defer(tx, &owner, &worker, &operation, &generation, Some(&record)).await? {
                return Ok(result);
            }
            let prompt = raw_one(tx,
                "SELECT to_jsonb(p)::text FROM managed_queue_claims c JOIN queued_prompts p ON p.id=c.prompt_id WHERE c.operation_id=$1 AND c.operation_generation=$2",
                &[&operation,&generation],
            ).await?;
            let eligible = if let Some(prompt) = prompt {
                super::managed_queue::recovery_eligible(tx, &owner, &worker, &chat, &text(&prompt["id"])?).await?
            } else { false };
            result["disposition"] = json!(if eligible {
                "requeued"
            } else { "retired" });
            Ok(result)
        })).await;
        match result {
            Err(cause)
                if cause
                    .downcast_ref::<super::CommandError>()
                    .is_some_and(|e| {
                        matches!(e.code.as_str(), "operation-not-found" | "chat-not-found")
                    }) =>
            {
                let mut result = unresolved;
                result["disposition"] = json!("retired");
                Ok(result)
            }
            other => other,
        }
    }
}
