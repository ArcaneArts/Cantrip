//! Actual dispatch ownership is locked in the round mutation transaction.
use super::*;

async fn assert_goal_placement(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    r: &Value,
    projection: Option<&Value>,
) -> Result<()> {
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

    if let Some(projection) = projection {
        let chat_row = placement.as_ref().context("Task projection placement")?;
        let project=one(Executor::Transaction(tx),"SELECT to_jsonb(p)::text FROM projects p WHERE p.id=$1 AND p.owner_id=$2 LIMIT 1 FOR UPDATE",&[&text(&chat_row["project_id"])?,&owner]).await?;
        if !project
            .as_ref()
            .is_some_and(|p| p["task_scheduling_paused"] == projection["taskSchedulingPaused"])
            || chat_row["placement_revision"] != projection["placementRevision"]
            || chat_row["automation_paused"] != projection["automationPaused"]
            || lane
                .as_ref()
                .is_none_or(|l| l["codex_thread_id"] != projection["threadId"])
        {
            return Err(crate::task_dispatch::Conflict::stale().into());
        }
    }
    Ok(())
}

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
    let outcome = expected["kind"] == "outcome";
    if (!leased && !outcome && expected["kind"] != "expired")
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
    let projection_control = if outcome && expected.get("goalInferenceInputOperationId").is_some() {
        expected
            .get("goalProjection")
            .and_then(|p| p.get("control"))
    } else if outcome {
        expected
            .get("roundProjection")
            .and_then(|p| p.get("control"))
    } else {
        None
    };
    let expired_outcome = projection_control.is_none()
        && outcome
        && cycle["state"] == "expired"
        && cycle["fencing_token"].as_i64()
            == fence["fencingToken"]
                .as_i64()
                .and_then(|n| n.checked_add(1));
    let current = latest.as_ref().and_then(|v| v.get("id")) == cycle.get("id")
        && if let Some(control) = projection_control {
            cycle["fencing_token"] == control["fencingToken"]
                && cycle["fencing_token"]
                    .as_i64()
                    .zip(fence["fencingToken"].as_i64())
                    .is_some_and(|(current, original)| current >= original)
        } else {
            cycle["fencing_token"] == fence["fencingToken"] || expired_outcome
        };
    let valid = if outcome {
        if let Some(control) = projection_control {
            cycle["state"] == control["state"]
                && cycle["lease_owner"] == control["leaseOwner"]
                && (matches!(
                    cycle["state"].as_str(),
                    Some("claimed" | "running" | "paused" | "expired" | "succeeded" | "failed")
                ) || (cycle["state"] == "queued"
                    && expected.get("inferenceInputOperationId").is_some()))
        } else {
            expired_outcome
                || ((matches!(cycle["state"].as_str(), Some("claimed" | "running"))
                    || (expected.get("goalInferenceInputOperationId").is_some()
                        && matches!(
                            cycle["state"].as_str(),
                            Some("paused" | "succeeded" | "failed")
                        )))
                    && cycle["lease_owner"] == fence["leaseOwner"])
        }
    } else if leased {
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
    if outcome {
        if let Some(attempt) = expected.get("goalInferenceInputOperationId") {
            let state = super::resumption::goal_execution(
                &cycle,
                &super::resumption::goal_receipt(&cycle, Some(attempt)),
            );
            let input = &state;
            let r = &super::resumption::physical(input)["receipt"];
            if input.is_null()
                || input["deferred"] == true
                || r["kind"] != "goal"
                || r["operationId"] != *attempt
                || r["dispatch"]["cycleId"] != fence["cycleId"]
                || r["dispatch"]["operationId"] != fence["operationId"]
                || r["dispatch"]["fencingToken"] != fence["fencingToken"]
                || r["dispatch"]["leaseOwner"] != fence["leaseOwner"]
                || expected.get("goalProjection").is_some_and(|p| {
                    input["terminal"].is_null()
                        || input["terminal"]["observedAt"] != p["terminalObservedAt"]
                        || !input["terminal"]["projectedAt"].is_null()
                })
            {
                return Err(crate::task_dispatch::Conflict::stale().into());
            }
            assert_goal_placement(tx, owner, chat, r, expected.get("goalProjection")).await?;
        } else {
            let round=one(Executor::Transaction(tx),"SELECT to_jsonb(r)::text FROM task_planning_rounds r WHERE r.id=$1 AND r.chat_id=$2 LIMIT 1 FOR UPDATE",&[&operation,&chat]).await?;
            let valid = round.as_ref().is_some_and(|round| {
                let input = &round["inference_input"];
                let receipt = &super::resumption::physical(input)["receipt"];
                !input.is_null()
                    && input["deferred"] != true
                    && receipt["kind"] != "goal"
                    && receipt["operationId"] == expected["inferenceInputOperationId"]
                    && receipt["dispatch"]["cycleId"] == fence["cycleId"]
                    && receipt["dispatch"]["operationId"] == fence["operationId"]
                    && receipt["dispatch"]["fencingToken"] == fence["fencingToken"]
                    && receipt["dispatch"]["leaseOwner"] == fence["leaseOwner"]
            });
            if !valid {
                return Err(crate::task_dispatch::Conflict::stale().into());
            }
        }
    }
    if leased && let Some(launch) = expected.get("goalLaunch") {
        let current = cycle["goal_input"]
            .get("receipt")
            .and_then(|r| r.get("operationId"))
            .cloned()
            .unwrap_or(Value::Null);
        if current != launch["inputOperationId"] {
            return Err(crate::task_dispatch::Conflict::stale().into());
        }
        tx.query("WITH p AS MATERIALIZED (SELECT projects.id FROM projects JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM p JOIN chats ON chats.project_id=p.id WHERE chats.id=$2 FOR UPDATE OF chats",&[&owner,&chat]).await?;
        let placement=one(Executor::Transaction(tx),"SELECT jsonb_build_object('chat',to_jsonb(c),'project',to_jsonb(p))::text FROM chats c JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE c.id=$2 LIMIT 1 FOR UPDATE OF c,p",&[&owner,&chat]).await?;
        let round=one(Executor::Transaction(tx),"SELECT to_jsonb(r)::text FROM task_planning_rounds r WHERE r.chat_id=$1 AND r.id=$2 LIMIT 1 FOR UPDATE",&[&chat,&operation]).await?;
        let task = one(
            Executor::Transaction(tx),
            "SELECT to_jsonb(t)::text FROM tasks t WHERE t.chat_id=$1 LIMIT 1 FOR UPDATE",
            &[&chat],
        )
        .await?;
        let valid = placement
            .as_ref()
            .zip(round.as_ref())
            .zip(task.as_ref())
            .is_some_and(|((p, r), t)| {
                p["chat"]["archived_at"].is_null()
                    && p["chat"]["automation_paused"] != true
                    && p["project"]["task_scheduling_paused"] != true
                    && p["chat"]["placement_revision"] == launch["placementRevision"]
                    && r["kind"] == "finalize"
                    && t["plan_goal_enabled"] == true
                    && t["state"] != "complete"
                    && t["planning_round"] == r["ordinal"]
                    && (t["active_operation_id"].is_null() || t["active_operation_id"] == operation)
                    && launch.get("preparation").is_none_or(|preparation| {
                        !r["relay_result"].is_null()
                            && t["state"] != "paused"
                            && (cycle["goal_input"].is_null()
                                || cycle["goal_input"]["deferred"] == true)
                            && t["implementation_started_at"]
                                .as_js_string()
                                .and_then(crate::wire::date_milliseconds)
                                == preparation["implementationStartedAt"]
                                    .as_js_string()
                                    .and_then(crate::wire::date_milliseconds)
                    })
            });
        if !valid {
            return Err(crate::task_dispatch::Conflict::stale().into());
        }
    }
    if leased && let Some(attempt) = expected.get("goalInferenceInputOperationId") {
        let state = super::resumption::goal_execution(
            &cycle,
            &super::resumption::goal_receipt(&cycle, Some(attempt)),
        );
        let input = &state;
        let receipt = &super::resumption::physical(input)["receipt"];
        if input.is_null()
            || input["deferred"] == true
            || receipt["operationId"] != *attempt
            || receipt["dispatch"]["fencingToken"] != cycle["fencing_token"]
            || receipt["dispatch"]["leaseOwner"] != cycle["lease_owner"]
        {
            return Err(crate::task_dispatch::Conflict::stale().into());
        }
        assert_goal_placement(tx, owner, chat, receipt, None).await?;
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
                && super::resumption::physical(input)["receipt"]["operationId"] == *attempt
        };
        if !matches {
            return Err(crate::task_dispatch::Conflict::stale().into());
        }
    }
    Ok(())
}
