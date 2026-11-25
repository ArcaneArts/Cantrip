//! Preserve the exact delegated input's logical completion before delivering
//! it to the originating Council agent.
pub(crate) mod delivery;
mod request;
mod task;

use crate::{database::Transaction, wire::Value};
use anyhow::Result;

pub(crate) async fn capture_result(
    tx: &Transaction<'_>,
    root: &Value,
    terminal: &Value,
    logical_status: &str,
    transport_ended: bool,
) -> Result<()> {
    if root["identity"]["contextKind"] != "project" {
        return Ok(());
    }
    let input = root["logical_client_message_id"].as_str();
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
    let activation = terminal["activation_generation"].as_str();
    // A turn can close before the native steer acknowledgment arrives. Keep the
    // exact candidate, and let the outbox deliver it only after the steer applies.
    tx.query(
        r#"WITH observed AS (
           SELECT thread_id,turn_id FROM native_command_turns
           WHERE chat_id=$1 AND operation_id IN ($4,$5)
           ORDER BY (operation_id=$4) DESC LIMIT 1
         ), identity AS (
           SELECT COALESCE((SELECT thread_id FROM observed),$6) AS thread_id,
                  COALESCE((SELECT turn_id FROM observed),$7) AS turn_id
         ), exact_inputs AS (
           SELECT d.input_message_id,NULL::text AS steer_operation FROM council_project_deliveries d
           WHERE d.target_chat_id=$1 AND d.input_message_id=$2
             AND (d.result_status IS NULL OR d.steer_result_operation_id IS NOT NULL)
           UNION ALL
           SELECT d.input_message_id,s.operation_id FROM council_project_deliveries d
           JOIN managed_queue_claims q ON q.chat_id=d.target_chat_id AND q.prompt_id=d.queued_prompt_id
           JOIN native_commands s ON s.operation_id=q.operation_id AND s.operation_generation=q.operation_generation
           WHERE d.target_chat_id=$1 AND d.input_message_id IS DISTINCT FROM $2 AND d.result_status IS NULL AND d.steer_requested
             AND s.chat_id=$1 AND s.method='turn/steer' AND s.activation_generation=$8 AND s.status<>'rejected'
         )
         UPDATE council_project_deliveries d SET result_status=$3,steer_result_operation_id=e.steer_operation,
           result_operation_id=$4,result_thread_id=i.thread_id,result_turn_id=i.turn_id,callback_due_at=now()
         FROM identity i, exact_inputs e WHERE d.input_message_id=e.input_message_id AND d.callback_delivered_at IS NULL"#,
        &[&chat, &input, &status, &operation, &root_operation, &thread, &turn, &activation],
    )
    .await?;
    Ok(())
}
