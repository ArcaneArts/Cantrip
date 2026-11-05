//! Marker-only Goal transfer: a retired source is not a live inference lease.
use super::*;
use crate::native_commands::goal_handoff;

async fn marker(tx: &Transaction<'_>, chat: &str) -> Result<Option<Value>> {
    let state = one(
        Executor::Transaction(tx),
        "SELECT to_jsonb(s)::text FROM managed_queue_states s WHERE chat_id=$1",
        &[&chat],
    )
    .await?;
    state
        .and_then(|s| s.get("goal_recovery").cloned())
        .filter(|s| !s.is_null())
        .map(|s| parse("nativeGoalRecoverySchema", &s))
        .transpose()
}
async fn root(tx: &Transaction<'_>, source: &Value, recovery: &Value) -> Result<Value> {
    let row = one(Executor::Transaction(tx), "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1 AND operation_generation=$2 AND chat_id=$3 AND worker_id=$4", &[
        &text(&recovery["operationId"])?, &text(&recovery["operationGeneration"])?,
        &text(&source["chatId"])?, &text(&source["workerId"])?]).await?;
    let Some(row) = row.filter(|r| {
        truthy(r.get("execution_completed_at")) && deep_equal(&r["goal_recovery_source"], recovery)
    }) else {
        return reject("handoff-native-operation-pending");
    };
    Ok(row)
}
pub(super) async fn reserve(
    tx: &Transaction<'_>,
    source: &Value,
    idle: bool,
    claims: &[Value],
) -> Result<Option<Value>> {
    let Some(marker) = marker(tx, &text(&source["chatId"])?)
        .await?
        .filter(|m| !truthy(m.get("admission")))
    else {
        return Ok(None);
    };
    if !idle || marker["source"].get("threadId") != source.get("threadId") {
        return reject("handoff-native-operation-pending");
    }
    let root = root(tx, source, &marker["source"]).await?;
    let Some(attempt) = autonomous_source::attempt(&root)?
        .filter(|a| a.get("goalEpoch") == marker["source"].get("goalEpoch"))
    else {
        return reject("handoff-native-operation-pending");
    };
    let mut queued = json!({"operationId":marker["source"]["operationId"],"operationGeneration":marker["source"]["operationGeneration"],
        "withdrawn":false,"goalRecovery":marker["source"],"autonomousAttempt":attempt});
    if let Some(claim) = claims.first() {
        let Some(identity) = goal_handoff::identity(claim)
            .filter(|i| i.get("goalEpoch") == marker["source"].get("goalEpoch"))
        else {
            return reject("handoff-native-operation-pending");
        };
        if claims.len() != 1
            || claim.get("chat_id") != source.get("chatId")
            || !goal_claim::retained(claim, &identity)
        {
            return reject("handoff-native-operation-pending");
        }
        let owner = text(&root["owner_id"])?;
        let worker = text(&source["workerId"])?;
        let parent = context::read(
            Executor::Transaction(tx),
            &owner,
            &worker,
            &text(&identity["operationId"])?,
            &text(&identity["operationGeneration"])?,
        )
        .await?;
        let session = json!({"chatId":source["chatId"],"threadId":source["threadId"],"runtimeGeneration":source["runtimeGeneration"],
            "contextKind":source["contextKind"],"projectId":source["projectId"],"placementId":source["placementId"],
            "modelRouteId":source["modelRouteId"],"providerAccountId":source["providerAccountId"],"connectionId":Value::Null});
        if parent.get("chat_id") != source.get("chatId")
            || parent["method"] != "thread/goal/set"
            || parent["status"] != "applied"
            || !goal_handoff::session_matches(
                tx,
                &owner,
                &worker,
                claim,
                &parent["identity"],
                &session,
            )
            .await?
        {
            return reject("handoff-native-operation-pending");
        }
        goal_claim::assert_prompt(tx, &text(&source["chatId"])?, &identity).await?;
        queued["goalClaim"] = identity;
    }
    Ok(Some(queued))
}

pub(super) async fn confirm(
    tx: &Transaction<'_>,
    owner: &str,
    row: Value,
    receipt: &Value,
) -> Result<Value> {
    let queued = &row["queued_source"];
    if queued["withdrawn"] == true {
        return if deep_equal(&queued["goalWithdrawal"], receipt) {
            Ok(row)
        } else {
            reject("handoff-operation-conflict")
        };
    }
    if row["phase"] != "preparing"
        || truthy(row.get("prepared"))
        || !truthy(queued.get("goalRecovery"))
    {
        return reject("handoff-phase-conflict");
    }
    let source = row
        .get("binding")
        .filter(|b| !b.is_null())
        .unwrap_or(&row["source"]);
    guards::assert_source(tx, owner, source).await?;
    if queued.get("operationId") != queued["goalRecovery"].get("operationId")
        || queued.get("operationGeneration") != queued["goalRecovery"].get("operationGeneration")
        || receipt.get("operationId") != row.get("operation_id")
        || !deep_equal(&receipt["source"], &queued["goalRecovery"])
        || receipt.get("bindingId") != source.get("bindingId")
        || receipt.get("runtimeGeneration") != source.get("runtimeGeneration")
    {
        return reject("handoff-native-operation-pending");
    }
    if marker(tx, &text(&source["chatId"])?)
        .await?
        .is_some_and(|m| {
            truthy(m.get("admission")) || !deep_equal(&m["source"], &queued["goalRecovery"])
        })
    {
        return reject("handoff-native-operation-pending");
    }
    root(tx, source, &queued["goalRecovery"]).await?;
    guards::assert_idle(tx, &text(&row["chat_id"])?, queued).await?;
    let mut queued = queued.clone();
    queued["withdrawn"] = json!(true);
    queued["goalWithdrawal"] = receipt.clone();
    update(
        tx,
        &row,
        json!({"queuedSource":queued,"errorCode":Value::Null}),
    )
    .await
}
