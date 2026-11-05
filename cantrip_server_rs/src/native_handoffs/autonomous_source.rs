//! Only worker-observed, unstarted managed Goal cycles use this transition.
//! A first-cycle awaitingGoal claim is deliberately not a claimless cycle.
use super::*;
use crate::chats::execution_lanes;
use sha2::{Digest, Sha256};

pub(crate) fn attempt(command: &Value) -> Result<Option<Value>> {
    let Some(attempt) = command["intent"].get("autonomousAttempt") else {
        return Ok(None);
    };
    let attempt = parse("nativeAutonomousAttemptSchema", attempt)?;
    if command["origin"] != "autonomous"
        || command["kind"] != "start"
        || command["method"] != "turn/start"
        || truthy(command.get("logical_operation_id"))
        || truthy(command.get("previous_operation_id"))
        || command["operation_id"]
            != format!(
                "native:{}:{}",
                text(&attempt["runnerGeneration"])?,
                text(&attempt["attemptId"])?
            )
        || command["intent"].get("expectedTurnId") != attempt.get("turnId")
        || command["identity"]["connectionId"]
            != format!("autonomous:{}", text(&attempt["runnerGeneration"])?)
    {
        return Ok(None);
    }
    Ok(Some(attempt))
}

pub(super) async fn confirm(
    tx: &Transaction<'_>,
    source: &Value,
    root: &Value,
    expected: &Value,
    record: &Value,
    retained_claim: Option<&Value>,
) -> Result<()> {
    if attempt(root)?.as_ref() != Some(expected)
        || root.get("chat_id") != source.get("chatId")
        || root.get("worker_id") != source.get("workerId")
        || !truthy(root.get("execution_lane_id"))
        || !truthy(root.get("activation_generation"))
        || [
            "threadId",
            "runtimeGeneration",
            "modelRouteId",
            "providerAccountId",
            "contextKind",
            "projectId",
            "placementId",
        ]
        .iter()
        .any(|field| root["identity"].get(field) != source.get(field))
    {
        return reject("handoff-native-operation-pending");
    }
    let chat = text(&root["chat_id"])?;
    let operation = text(&root["operation_id"])?;
    if !tx.query("SELECT operation_id FROM native_command_turns WHERE operation_id=$1 LIMIT 1", &[&operation]).await?.is_empty()
        || (retained_claim.is_none() && !tx.query("SELECT id FROM managed_queue_claims WHERE chat_id=$1 AND status IN ('claimed','accepted','dispatched','uncertain') LIMIT 1", &[&chat]).await?.is_empty())
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
    if let Some(expected) = retained_claim {
        goal_claim::validate_withdrawal(tx, root, expected, already).await?;
    }
    if record.is_null() {
        return if already {
            complete_recovered_withdrawal(tx, root).await
        } else {
            reject("handoff-native-operation-pending")
        };
    }
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
        || record["identity"].get("operationId") != root.get("operation_generation")
        || record["identity"].get("chatId") != source.get("chatId")
        || (!record["identity"]["projectId"].is_null()
            && record["identity"].get("projectId") != source.get("projectId"))
        || identity.get("commandId") != root.get("operation_id")
        || identity.get("commandGeneration") != root.get("operation_generation")
        || identity.get("threadId") != source.get("threadId")
        || identity.get("turnId") != expected.get("turnId")
        || (already && evidence.get("key") != record.get("key"))
    {
        return reject("handoff-native-operation-pending");
    }
    if already {
        return complete_recovered_withdrawal(tx, root).await;
    }
    let activation = one(
        Executor::Transaction(tx),
        "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",
        &[&chat],
    )
    .await?
    .unwrap_or(Value::Null);
    let same = activation.get("generation") == root.get("activation_generation")
        && activation.get("operation_id") == root.get("operation_id")
        && activation.get("execution_lane_id") == root.get("execution_lane_id");
    if [
        "result_digest",
        "protected_result",
        "terminal_result_digest",
        "protected_terminal_result",
    ]
    .iter()
    .any(|key| truthy(root.get(key)))
    {
        return reject("handoff-native-operation-pending");
    }
    // Preserve an explicit Stop that settled the exact source before this ACK.
    if same
        && activation["logical_cancelled"] == true
        && activation["active"] == false
        && root["status"] == "rejected"
        && (truthy(root.get("execution_completed_at"))
            || root["rejection_code"] == "cancelled-before-dispatch")
    {
        persist_no_start(tx, root, record, true).await?;
        return Ok(());
    }
    // A pure autonomous command has no GUI logical root to receive closure
    // timestamps. This path still requires the exact worker no-start proof.
    let closed = (!truthy(Some(evidence))
        || (matches!(evidence, Value::Object(fields) if fields.len() == 2)
            && evidence["kind"] == "transport-ended"
            && evidence["source"] == "worker-command"))
        && ((root["status"] == "rejected" && root["rejection_code"] == "not-dispatched")
            || (root["status"] == "uncertain"
                && root["rejection_code"] == "missing-native-receipt"));
    if (!closed
        && (root["status"] != "accepted"
            || [
                "logical_completed_at",
                "execution_completed_at",
                "terminal_evidence",
            ]
            .iter()
            .any(|key| truthy(root.get(key)))
            || !same
            || activation["active"] != true))
        || (same
            && (activation["logical_cancelled"] == true
                || activation.get("runtime_generation")
                    != root["identity"].get("runtimeGeneration")
                || (truthy(activation.get("native_turn_id"))
                    && activation.get("native_turn_id") != expected.get("turnId"))))
    {
        return reject("handoff-native-operation-pending");
    }
    if !closed
        && !execution_lanes::finish_in_transaction(
            tx,
            &chat,
            &text(&root["execution_lane_id"])?,
            "idle",
            &json!({"markUnreadCompletion":false}),
        )
        .boxed()
        .await?
    {
        return reject("handoff-native-operation-pending");
    }
    persist_no_start(tx, root, record, false).await?;
    tx.query("UPDATE native_command_activations SET active=false WHERE chat_id=$1 AND generation=$2 AND operation_id=$3", &[&chat,&text(&root["activation_generation"])?,&operation]).await?;
    if let Some(claim) = retained_claim {
        let updated = tx.query("UPDATE managed_queue_claims SET goal_operation_id=NULL,goal_operation_generation=NULL WHERE id=$1 AND goal_operation_id=$2 AND goal_operation_generation=$3 RETURNING id", &[&text(&claim["id"])?,&operation,&text(&root["operation_generation"])?]).await?;
        if updated.len() != 1 {
            return reject("handoff-native-operation-pending");
        }
        crate::native_commands::queue_state_changed(tx, &chat).await?;
    }
    complete_recovered_withdrawal(tx, root).await
}

/// Exact withdrawal plus native invalidation ACK retires only its own marker
/// admission. Keep the logical source and immutable native settlement intact.
async fn complete_recovered_withdrawal(tx: &Transaction<'_>, root: &Value) -> Result<()> {
    let chat = text(&root["chat_id"])?;
    let state = one(
        Executor::Transaction(tx),
        "SELECT to_jsonb(s)::text FROM managed_queue_states s WHERE chat_id=$1",
        &[&chat],
    )
    .await?;
    let Some(state) = state else {
        return Ok(());
    };
    let Some(marker) = state.get("goal_recovery").filter(|m| !m.is_null()) else {
        return Ok(());
    };
    let marker = parse("nativeGoalRecoverySchema", marker)?;
    if marker["admission"].get("operationId") != root.get("operation_id")
        || marker["admission"].get("operationGeneration") != root.get("operation_generation")
    {
        return Ok(());
    }
    if !deep_equal(&root["intent"]["goalRecovery"], &marker["source"])
        || root["intent"].get("workerGeneration") != marker["admission"].get("workerGeneration")
    {
        return reject("handoff-native-operation-pending");
    }
    tx.query(
        "UPDATE native_commands SET goal_recovery_source=$1::text::jsonb WHERE operation_id=$2",
        &[&marker["source"].stringify(), &text(&root["operation_id"])?],
    )
    .await?;
    tx.query(
        "UPDATE managed_queue_states SET goal_recovery=$1::text::jsonb WHERE chat_id=$2",
        &[
            &json!({"source":marker["source"],"admission":Value::Null}).stringify(),
            &chat,
        ],
    )
    .await?;
    crate::native_commands::queue_state_changed(tx, &chat).await
}

async fn persist_no_start(
    tx: &Transaction<'_>,
    root: &Value,
    record: &Value,
    preserve_cancellation: bool,
) -> Result<()> {
    let now = crate::auth::now();
    let evidence = serde_json::to_string(
        &json!({"kind":"not-started","source":"worker-inference-journal",
        "key":record["key"],"workerGeneration":record["workerGeneration"],
        "runtimeGeneration":record["identity"]["runtimeGeneration"],"revision":record["revision"]}),
    )?;
    let rejection = if preserve_cancellation {
        text(&root["rejection_code"])?
    } else {
        "worker-inference-deferred".into()
    };
    tx.query("UPDATE native_commands SET status='rejected',rejection_code=$5,terminal_evidence=$1::jsonb,logical_completed_at=COALESCE(logical_completed_at,$2),execution_completed_at=COALESCE(execution_completed_at,$2),updated_at=$2 WHERE operation_id=$3 AND operation_generation=$4", &[&evidence,&now,&text(&root["operation_id"])?,&text(&root["operation_generation"])?,&rejection]).await?;
    Ok(())
}
