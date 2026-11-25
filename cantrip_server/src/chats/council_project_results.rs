//! Preserve the exact delegated input's logical completion before delivering
//! it to the originating Council agent.
pub(crate) mod delivery;
mod request;

use crate::{database::Transaction, wire::Value};
use anyhow::Result;

pub(crate) async fn capture_result(
    tx: &Transaction<'_>,
    root: &Value,
    terminal: &Value,
    logical_status: &str,
    transport_ended: bool,
) -> Result<()> {
    let Some(input) = root["logical_client_message_id"].as_str() else {
        return Ok(());
    };
    if root["identity"]["contextKind"] != "project" {
        return Ok(());
    }
    let evidence = &terminal["terminal_evidence"];
    let status = match evidence["terminalStatus"].as_str() {
        Some(status @ ("completed" | "failed" | "interrupted")) => status,
        _ if terminal["status"] == "rejected"
            || (logical_status == "failed" && !transport_ended) =>
        {
            "failed"
        }
        _ => "unavailable",
    };
    let chat = root["chat_id"].as_str();
    let operation = terminal["operation_id"].as_str();
    let root_operation = root["operation_id"].as_str();
    let thread = terminal["identity"]["threadId"].as_str();
    let turn = evidence["nativeTurnId"].as_str();
    tx.query(
        r#"WITH observed AS (
           SELECT thread_id,turn_id FROM native_command_turns
           WHERE chat_id=$1 AND operation_id IN ($4,$5)
           ORDER BY (operation_id=$4) DESC LIMIT 1
         ), identity AS (
           SELECT COALESCE((SELECT thread_id FROM observed),$6) AS thread_id,
                  COALESCE((SELECT turn_id FROM observed),$7) AS turn_id
         )
         UPDATE council_project_deliveries d SET result_status=$3,
           result_operation_id=$4,result_thread_id=i.thread_id,result_turn_id=i.turn_id,callback_due_at=now()
         FROM identity i WHERE d.target_chat_id=$1 AND d.input_message_id=$2 AND d.result_status IS NULL"#,
        &[&chat, &input, &status, &operation, &root_operation, &thread, &turn],
    )
    .await?;
    Ok(())
}
