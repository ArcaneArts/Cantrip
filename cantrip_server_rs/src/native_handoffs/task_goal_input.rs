//! Transfer an already-applied Goal's unused first input. Preserve the existing
//! encrypted message and native Goal; neither is recreated by this deferral.
use super::*;

pub(super) async fn confirm(
    tx: &Transaction<'_>,
    row: &Value,
    queued: &Value,
    transfer: &Value,
) -> Result<()> {
    let state = &row["cycle"]["goal_input"];
    let source = &queued["taskGoal"]["identity"]["recovery"]["taskInput"];
    if state.is_null()
        || source.is_null()
        || !deep_equal(&state["receipt"], source)
        || state["deferred"] == true
        || state["failedBeforeDispatch"] == true
        || !state["firstDispatchedOperationId"].is_null()
    {
        return reject("handoff-task-goal-input-replaced");
    }
    let chat = text(&source["chatId"])?;
    crate::chats::execution_lanes::finish_in_transaction(
        tx, &chat, &text(&source["executionLaneId"])?, "idle",
        &json!({"expectedActivatedAt":source["executionLaneActivatedAt"],"markUnreadCompletion":false}),
    ).await?;
    let now = crate::auth::now();
    tx.query("UPDATE chats SET status='idle',updated_at=$2 WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM chat_execution_lanes WHERE chat_id=$1 AND state='active')", &[&chat,&now]).await?;
    let change = parse(
        "taskInferenceRouteChangeSchema",
        &json!({
            "operationId":transfer["operation_id"],"inputOperationId":source["operationId"],
            "expectedRevision":row["task"]["row_version"],"source":source,"phase":"draining",
            "targetModelRouteId":transfer["target_model_route_id"],"targetProviderAccountId":transfer["target_provider_account_id"],
            "queuedFencingToken":row["cycle"]["fencing_token"].as_i64().context("Task Goal input fence")?+1,
            "createdAt":receipt::iso(&json!(now))?,"completedAt":Value::Null
        }),
    )?;
    let mut input = state.clone();
    input["deferred"] = json!(true);
    input["routeChange"] = change;
    let paused = row["chat"]["automation_paused"] == true
        || row["project"]["task_scheduling_paused"] == true
        || row["task"]["state"] == "paused";
    tx.query("UPDATE task_dispatch_cycles SET goal_input=$1::text::jsonb,state=$2,lease_owner=NULL,lease_expires_at=NULL,last_heartbeat_at=NULL,fencing_token=fencing_token+1,claimed_at=NULL,started_at=NULL,completed_at=NULL,paused_at=CASE WHEN $2='paused' THEN $3 ELSE NULL END,eligibility_code='provider-transfer-pending',updated_at=$3 WHERE id=$4",
        &[&input.stringify(),&if paused {"paused"}else{"queued"},&now,&text(&row["cycle"]["id"])?]).await?;
    Ok(())
}

pub(super) async fn cancel(tx: &Transaction<'_>, transfer: &Value) -> Result<()> {
    let queued = &transfer["queued_source"];
    let source = &queued["taskGoal"]["identity"]["recovery"]["taskInput"];
    if !truthy(queued.get("taskGoalInput")) || queued["withdrawn"] != true || source.is_null() {
        return Ok(());
    }
    let cycle = one(Executor::Transaction(tx),
        "SELECT to_jsonb(c)::text FROM task_dispatch_cycles c WHERE c.id=$1 AND c.chat_id=$2 LIMIT 1 FOR UPDATE",
        &[&text(&source["dispatch"]["cycleId"])?,&text(&transfer["chat_id"])?]).await?;
    let Some(cycle) = cycle else {
        return Ok(());
    };
    let mut input = cycle["goal_input"].clone();
    if input["deferred"] != true
        || input["routeChange"].get("operationId") != transfer.get("operation_id")
        || input["routeChange"]["phase"] != "draining"
    {
        return Ok(());
    }
    input["routeChange"]["phase"] = json!("cancelled");
    input["routeChange"]["completedAt"] = receipt::iso(&json!(crate::auth::now()))?;
    tx.query("UPDATE task_dispatch_cycles SET goal_input=$1::text::jsonb,eligibility_code=NULL WHERE id=$2",
        &[&input.stringify(),&text(&cycle["id"])?]).await?;
    Ok(())
}

pub(super) async fn commit(
    tx: &Transaction<'_>,
    row: &Value,
    queued: &Value,
    target: &Value,
    task_configuration: &Value,
    cycle_configuration: &Value,
    epoch: i64,
) -> Result<Value> {
    let mut input = row["cycle"]["goal_input"].clone();
    let change = &input["routeChange"];
    if input["deferred"] != true
        || change.is_null()
        || change["phase"] != "draining"
        || change.get("inputOperationId") != queued["taskGoal"]["identity"].get("operationId")
        || change.get("targetModelRouteId") != target.get("routeId")
        || change.get("targetProviderAccountId") != target.get("accountId")
    {
        return reject("handoff-task-goal-input-replaced");
    }
    let now = crate::auth::now();
    input["routeChange"]["phase"] = json!("completed");
    input["routeChange"]["completedAt"] = receipt::iso(&json!(now))?;
    let mut marker = row["cycle"]["goal_cycle_recovery"].clone();
    if !marker.is_null() {
        marker["admission"] = Value::Null;
        marker["settled"] =
            json!({"reason":"transferred","turnId":marker["turnId"],"operationId":Value::Null});
        marker = parse("taskGoalCycleRecoverySchema", &marker)?;
    }
    tx.query("UPDATE tasks SET model_configuration=$1::text::jsonb,row_version=row_version+1,updated_at=$2 WHERE chat_id=$3",
        &[&task_configuration.stringify(),&now,&text(&row["cycle"]["chat_id"])?]).await?;
    tx.query("UPDATE task_dispatch_cycles SET model_configuration=$1::text::jsonb,model_route_id=$2,provider_account_id=$3,goal_order_epoch=$4,goal_input=$5::text::jsonb,goal_cycle_recovery=NULLIF($6::text::jsonb,'null'::jsonb),eligibility_code=NULL,updated_at=$7 WHERE id=$8",
        &[&cycle_configuration.stringify(),&text(&target["routeId"])?,&optional(&target["accountId"])?,&epoch,&input.stringify(),&marker.stringify(),&now,&text(&row["cycle"]["id"])?]).await?;
    let mut next = queued.clone();
    next["taskGoalControl"] =
        json!({"taskConfiguration":task_configuration,"cycleConfiguration":cycle_configuration});
    Ok(next)
}
