//! Actual dispatch ownership is locked in the round mutation transaction.
use super::*;

pub(super) async fn assert(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    operation: &str,
    expected: &Value,
    association: bool,
) -> Result<()> {
    let leased = expected["kind"] == "leased";
    let fence = if leased { &expected["lease"] } else { expected };
    if (!leased && expected["kind"] != "expired")
        || fence["operationId"] != operation
        || !lock_user(tx, owner).await?
    {
        return Err(crate::task_dispatch::Conflict::stale().into());
    }
    // Claim/enqueue use the same owner lock. Keep the cycle locked through the
    // write so a heartbeat cannot authorize a callback after recovery replaced it.
    let cycle = one(
        Executor::Transaction(tx),
        "SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.id=$1 AND c.owner_id=$2 AND c.chat_id=$3 AND c.operation_id=$4 LIMIT 1 FOR UPDATE",
        &[&text(&fence["cycleId"])?, &owner, &chat, &operation],
    ).await?;
    let latest = one(
        Executor::Transaction(tx),
        "SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.owner_id=$1 AND c.chat_id=$2 ORDER BY c.created_at DESC,c.id DESC LIMIT 1",
        &[&owner, &chat],
    ).await?;
    let Some(cycle) = cycle else {
        return Err(crate::task_dispatch::Conflict::stale().into());
    };
    let current = latest.as_ref().and_then(|v| v.get("id")) == cycle.get("id")
        && cycle["fencing_token"] == fence["fencingToken"];
    let valid = if leased {
        let valid_state = if association {
            // Binding history may trail a fast completion. It never revives or
            // settles work, and the exact owner/fence/latest cycle still match.
            matches!(
                cycle["state"].as_str(),
                Some("claimed" | "running" | "paused" | "succeeded" | "failed" | "cancelled")
            )
        } else {
            matches!(cycle["state"].as_str(), Some("claimed" | "running"))
                && cycle["lease_expires_at"]
                    .as_js_string()
                    .and_then(crate::wire::date_milliseconds)
                    .is_some_and(|expires| expires > crate::auth::now().timestamp_millis())
        };
        valid_state && cycle["lease_owner"] == fence["leaseOwner"]
    } else {
        cycle["state"] == "expired"
    };
    if !current || !valid {
        return Err(crate::task_dispatch::Conflict::stale().into());
    }
    if leased && let Some(attempt) = expected.get("goalInferenceInputOperationId") {
        let input = &cycle["goal_input"];
        if input.is_null()
            || input["deferred"] == true
            || input["receipt"]["operationId"] != *attempt
            || input["receipt"]["dispatch"]["fencingToken"] != cycle["fencing_token"]
            || input["receipt"]["dispatch"]["leaseOwner"] != cycle["lease_owner"]
        {
            return Err(crate::task_dispatch::Conflict::stale().into());
        }
        let r = &input["receipt"];
        tx.query("WITH p AS MATERIALIZED (SELECT projects.id FROM projects JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM p JOIN chats ON chats.project_id=p.id WHERE chats.id=$2 FOR UPDATE OF chats",&[&owner,&chat]).await?;
        let placement = one(
            Executor::Transaction(tx),
            "SELECT to_jsonb(c)::text FROM chats c WHERE c.id=$1 LIMIT 1 FOR UPDATE",
            &[&chat],
        )
        .await?;
        let lane=one(Executor::Transaction(tx),"SELECT to_jsonb(l)::text FROM chat_execution_lanes l WHERE l.chat_id=$1 AND l.id=$2 LIMIT 1 FOR UPDATE",&[&chat,&text(&r["executionLaneId"])?]).await?;
        if !placement.as_ref().is_some_and(|c| {
            c["archived_at"].is_null()
                && c["active_worker_id"] == r["workerId"]
                && c["active_worktree_id"] == r["worktreeId"]
        }) || !lane.as_ref().is_some_and(|l| {
            l["worker_id"] == r["workerId"]
                && l["worktree_id"] == r["worktreeId"]
                && l["activated_at"]
                    .as_js_string()
                    .and_then(crate::wire::date_milliseconds)
                    == r["executionLaneActivatedAt"]
                        .as_js_string()
                        .and_then(crate::wire::date_milliseconds)
        }) {
            return Err(crate::task_dispatch::Conflict::stale().into());
        }
    }
    if leased && let Some(attempt) = expected.get("inferenceInputOperationId") {
        // Receipt prepare/defer uses this same owner/cycle lock. Match inside
        // the actual round-write transaction, not an earlier heartbeat.
        let round = one(Executor::Transaction(tx),
            "SELECT to_jsonb(r)::text FROM task_planning_rounds r WHERE r.id=$1 AND r.chat_id=$2 LIMIT 1",
            &[&operation, &chat]).await?;
        let Some(round) = round else {
            return Err(crate::task_dispatch::Conflict::stale().into());
        };
        let input = &round["inference_input"];
        let matches = if attempt.is_null() {
            input.is_null()
        } else {
            !input.is_null()
                && input["deferred"] != true
                && input["receipt"]["operationId"] == *attempt
        };
        if !matches {
            return Err(crate::task_dispatch::Conflict::stale().into());
        }
    }
    Ok(())
}
