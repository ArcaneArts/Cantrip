//! Bind actual Core execution to an already consumed Task input. This records
//! correlation only: it grants no input, capacity, or recovery authority.
use super::*;

pub(super) async fn bind(
    tx: &Transaction<'_>,
    owner: &str,
    receipt: &Value,
    row: &Value,
    metadata: &Value,
) -> Result<Value> {
    let stale = || crate::task_dispatch::Conflict::stale();
    let state = &row["round"]["inference_input"];
    let physical = super::resumption::physical(state);
    if state.is_null()
        || state["deferred"] == true
        || state["failedBeforeDispatch"] == true
        || physical["accepted"] != true
        || physical["dispatched"] != true
        || !state["terminal"].is_null()
        || metadata["workerGeneration"].is_null()
        || metadata["nativeRuntimeGeneration"].is_null()
        || physical["claimWorkerGeneration"] != metadata["workerGeneration"]
        || physical["receipt"] != *receipt
        || row["lane"]["state"] != "active"
    {
        return Err(stale().into());
    }
    let execution = crate::wire::parse_property(
        "taskInferenceInputDispatchSchema",
        "nativeExecution",
        &metadata["nativeExecution"],
    )
    .map_err(crate::settings::response_error)?;
    let native_owner = json!({"workerGeneration":metadata["workerGeneration"],"runtimeGeneration":metadata["nativeRuntimeGeneration"]});
    if (!physical["nativeExecution"].is_null() && physical["nativeExecution"] != execution)
        || (!physical["nativeOwner"].is_null() && physical["nativeOwner"] != native_owner)
        || (!state["resumption"].is_null()
            && (execution["threadId"] != state["nativeExecution"]["threadId"]
                || execution["turnId"] != state["nativeExecution"]["turnId"]))
    {
        return Err(stale().into());
    }
    let (lane, cycle, operation, thread, turn, at) = (
        text(&receipt["executionLaneId"])?,
        text(&receipt["dispatch"]["cycleId"])?,
        text(&receipt["dispatch"]["operationId"])?,
        text(&execution["threadId"])?,
        text(&execution["turnId"])?,
        text(&now())?,
    );
    let fencing_token = receipt["dispatch"]["fencingToken"]
        .as_i64()
        .context("Task native binding fence")?
        .to_string();
    let lane_rows = tx.query("UPDATE chat_execution_lanes SET codex_thread_id=$2,updated_at=$3::text::timestamptz WHERE id=$1 AND state='active' RETURNING id", &[&lane,&thread,&at]).await?;
    let cycle_rows = tx.query("UPDATE task_dispatch_cycles SET codex_thread_id=$3,turn_id=$4,updated_at=$5::text::timestamptz WHERE id=$1 AND owner_id=$2 AND fencing_token=$6::text::bigint RETURNING id", &[&cycle,&owner,&thread,&turn,&at,&fencing_token]).await?;
    if lane_rows.is_empty() || cycle_rows.is_empty() {
        return Err(stale().into());
    }
    let mut state = state.clone();
    let resumed = !state["resumption"].is_null();
    let physical = if resumed {
        &mut state["resumption"]
    } else {
        &mut state
    };
    physical["nativeExecution"] = execution.clone();
    physical["nativeOwner"] = native_owner;
    update(
        tx,
        Table::Round,
        &operation,
        &json!({"inference_input":state}),
        None,
    )
    .await?;
    if resumed {
        crate::native_commands::task_suspension::bind_running(
            tx,
            owner,
            receipt,
            &state["resumption"],
        )
        .await?;
    }
    Ok(
        json!({"receipt":receipt,"nativeExecution":execution,"nativeRuntimeGeneration":metadata["nativeRuntimeGeneration"]}),
    )
}
