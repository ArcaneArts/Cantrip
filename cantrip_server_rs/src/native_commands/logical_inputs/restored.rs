//! A dead original GUI caller cannot publish a replacement worker's outcome.
//! The actual terminal receipt and protected publication retire both owners in
//! the same transaction. Administrative transport closure is insufficient.
use super::{
    super::{
        admit::{raw_one, reject, text},
        suspension,
    },
    outcomes,
};
use crate::{
    database::Transaction,
    wire::{Value, coercion::truthy},
};
use anyhow::Result;

pub(in crate::native_commands) async fn finish(
    tx: &Transaction<'_>,
    owner: &str,
    row: &Value,
) -> Result<()> {
    if row["kind"] != "start"
        || row["method"] != "thread/resume"
        || !truthy(row.get("logical_operation_id"))
        || row["logical_operation_id"] == row["operation_id"]
        || !truthy(row.get("execution_completed_at"))
        || !truthy(row.get("protected_terminal_result"))
        || !truthy(row.get("terminal_result_digest"))
        || !truthy(row["intent"].get("restoredSuspension"))
    {
        return Ok(());
    }
    let chat = text(&row["chat_id"])?;
    let current = suspension::chat(tx, owner, &chat).await?;
    let Some(state) = suspension::read(&current)? else {
        return Ok(());
    };
    if !suspension::owns_execution(&state, row) || !suspension::terminal_proof(&state, row) {
        return Ok(());
    }
    let logical = text(&row["logical_operation_id"])?;
    let worker = text(&row["worker_id"])?;
    let root = raw_one(tx, "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1 AND owner_id=$2 AND worker_id=$3 AND chat_id=$4", &[&logical, &owner, &worker, &chat]).await?;
    let Some(root) = root else {
        return reject("invalid-continuation-lineage");
    };
    outcomes::finish(
        tx,
        owner,
        &worker,
        &logical,
        &text(&root["operation_generation"])?,
        if row["terminal_evidence"]["terminalStatus"] == "failed" {
            "failed"
        } else {
            "idle"
        },
        false,
    )
    .await?;
    Ok(())
}
