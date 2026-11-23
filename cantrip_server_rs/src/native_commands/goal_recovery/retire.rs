use super::*;
use crate::chats::execution_lanes;
use futures::FutureExt;

/// Caller supplies positive no-input authority and actual replacement-worker
/// fencing. Missing native history only checks for contradictory consumption.
pub(super) async fn unused(
    tx: &Transaction<'_>,
    row: &Value,
    source: &Value,
    evidence: Value,
) -> Result<bool> {
    let Some(attempt) = crate::native_handoffs::autonomous_attempt(row)? else {
        return Ok(false);
    };
    if attempt.get("goalEpoch") != source.get("goalEpoch") {
        return Ok(false);
    }
    let reserved = recovered(row).is_some_and(|s| deep_equal(s, source));
    if reserved && truthy(row.get("execution_completed_at")) {
        return Ok(true);
    }
    let closed = (!truthy(row.get("terminal_evidence"))
        || super::super::transport_evidence::is_transport_closure(row.get("terminal_evidence")))
        && ((row["status"] == "rejected" && row["rejection_code"] == "not-dispatched")
            || (row["status"] == "uncertain" && row["rejection_code"] == "missing-native-receipt"));
    if (row["status"] != "accepted" && !closed && !reserved)
        || (!reserved
            && [
                "result_digest",
                "protected_result",
                "terminal_result_digest",
                "protected_terminal_result",
            ]
            .iter()
            .any(|k| truthy(row.get(k))))
        || (!closed
            && !reserved
            && [
                "logical_completed_at",
                "execution_completed_at",
                "terminal_evidence",
            ]
            .iter()
            .any(|k| truthy(row.get(k))))
        || !truthy(row.get("execution_lane_id"))
        || !truthy(row.get("activation_generation"))
    {
        return Ok(false);
    }
    let chat = text(&row["chat_id"])?;
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
        return Ok(false);
    }
    let activation = raw_one(
        tx,
        "SELECT to_jsonb(a)::text FROM native_command_activations a WHERE chat_id=$1",
        &[&chat],
    )
    .await?
    .unwrap_or(Value::Null);
    let same = activation.get("generation") == row.get("activation_generation")
        && activation.get("operation_id") == row.get("operation_id")
        && activation.get("execution_lane_id") == row.get("execution_lane_id");
    if (!closed && (!same || activation["active"] != true))
        || (activation["active"] == true && !same)
        || (same
            && (truthy(activation.get("logical_cancelled"))
                || activation.get("runtime_generation")
                    != row["identity"].get("runtimeGeneration")
                || (truthy(activation.get("native_turn_id"))
                    && activation.get("native_turn_id") != attempt.get("turnId"))))
    {
        return Ok(false);
    }
    let rows = tx.query("SELECT to_jsonb(c)::text FROM managed_queue_claims c WHERE chat_id=$1 AND status IN ('claimed','accepted','dispatched','uncertain') LIMIT 2", &[&chat]).await?;
    let claims = rows
        .iter()
        .map(|r| Ok(serde_json::from_str::<Value>(&r.get::<String>(0)?)?))
        .collect::<Result<Vec<_>>>()?;
    if claims.len() > 1 {
        return Ok(false);
    }
    if let Some(claim) = claims.first() {
        if claim["awaiting_goal"] != true
            || claim.get("goal_epoch") != source.get("goalEpoch")
            || claim.get("goal_operation_id") != row.get("operation_id")
            || claim.get("goal_operation_generation") != row.get("operation_generation")
            || truthy(claim.get("native_turn_id"))
            || !matches!(claim["status"].as_str(), Some("dispatched" | "uncertain"))
            || !truthy(claim.get("operation_id"))
            || !truthy(claim.get("operation_generation"))
        {
            return Ok(false);
        }
        let parent = raw_one(tx,"SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1 AND operation_generation=$2 AND owner_id=$3 AND worker_id=$4 AND chat_id=$5", &[&text(&claim["operation_id"])?,&text(&claim["operation_generation"])?,&text(&row["owner_id"])?,&text(&row["worker_id"])?,&chat]).await?;
        let prompt = raw_one(tx,"SELECT to_jsonb(p)::text FROM queued_prompts p WHERE id=$1 AND chat_id=$2 AND revision=$3::text::integer AND state='claimed'", &[&text(&claim["prompt_id"])?,&chat,&claim["prompt_revision"].stringify()]).await?;
        if parent.is_none_or(|p| p["method"] != "thread/goal/set" || p["status"] != "applied")
            || prompt.is_none()
        {
            return Ok(false);
        }
    }
    if same
        && activation["active"] == true
        && !execution_lanes::finish_in_transaction(
            tx,
            &chat,
            &text(&row["execution_lane_id"])?,
            "idle",
            &json!({"markUnreadCompletion":false}),
        )
        .boxed()
        .await?
    {
        return Ok(false);
    }
    let mut evidence = evidence;
    evidence["recoveryKind"] = json!("managed-goal");
    evidence["goalRecovery"] = source.clone();
    let now = crate::auth::now();
    if reserved {
        // A partial negative receipt already reserved no-dispatch authority.
        // Actual fencing can finish it without changing that immutable result.
        tx.query("UPDATE native_commands SET logical_completed_at=COALESCE(logical_completed_at,$1),execution_completed_at=COALESCE(execution_completed_at,$1),updated_at=$1 WHERE operation_id=$2 AND operation_generation=$3", &[&now,&operation,&generation]).await?;
    } else {
        tx.query("UPDATE native_commands SET status='rejected',rejection_code='worker-inference-deferred',goal_recovery_source=$1::text::jsonb,terminal_evidence=$2::text::jsonb,logical_completed_at=COALESCE(logical_completed_at,$3),execution_completed_at=COALESCE(execution_completed_at,$3),updated_at=$3 WHERE operation_id=$4 AND operation_generation=$5", &[&source.stringify(),&evidence.stringify(),&now,&operation,&generation]).await?;
    }
    if same {
        tx.query("UPDATE native_command_activations SET active=false WHERE chat_id=$1 AND generation=$2 AND operation_id=$3", &[&chat,&text(&row["activation_generation"])?,&operation]).await?;
    }
    if let Some(claim) = claims.first() {
        // Keep the applied setter, original ciphertext, claim and Goal epoch.
        tx.query("UPDATE managed_queue_claims SET goal_operation_id=NULL,goal_operation_generation=NULL WHERE id=$1", &[&text(&claim["id"])?]).await?;
    }
    Ok(true)
}
