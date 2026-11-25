//! Preserve the exact delegated input's logical completion before delivering
//! it to the originating Council agent.
pub(crate) mod delivery;
mod request;
mod task;

use crate::{
    database::Transaction,
    native_commands::runtime::finish_gui::GuiReply,
    wire::{Value, value::json},
};
use anyhow::Result;

pub(crate) async fn capture_result(
    tx: &Transaction<'_>,
    root: &Value,
    terminal: &Value,
    logical_status: &str,
    transport_ended: bool,
    reply: Option<GuiReply<'_>>,
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
    let reply = reply.filter(|reply| {
        matches!(status, "completed" | "unavailable")
            && Some(reply.thread_id) == thread
            && turn.is_none_or(|turn| turn == reply.turn_id)
            && reply.message["classification"]["role"] == "assistant"
    });
    let reply_turn = reply.map(|reply| reply.turn_id);
    let protected_reply = reply.map(|reply| {
        json!({
            "id": reply.message["id"],
            "classification": reply.message["classification"],
            "protectedContent": reply.message["protectedContent"],
        })
        .stringify()
    });
    // Keep the authenticated reply from the exact turn while history projects
    // independently. A steered input becomes deliverable only after it applies.
    tx.query(
        r#"WITH observed AS (
           SELECT thread_id,turn_id FROM native_command_turns
           WHERE chat_id=$1 AND operation_id IN ($4,$5)
           ORDER BY (operation_id=$4) DESC LIMIT 1
         ), identity AS (
           SELECT COALESCE((SELECT thread_id FROM observed),$6) AS thread_id,
                  COALESCE((SELECT turn_id FROM observed),$7,$9) AS turn_id
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
         UPDATE council_project_deliveries d SET
           result_status=CASE WHEN i.thread_id=$6 AND i.turn_id=$9 THEN 'completed' ELSE $3 END,
           protected_reply=CASE WHEN i.thread_id=$6 AND i.turn_id=$9 THEN $10::text::jsonb END,
           steer_result_operation_id=e.steer_operation,
           result_operation_id=$4,result_thread_id=i.thread_id,result_turn_id=i.turn_id,callback_due_at=now()
         FROM identity i, exact_inputs e WHERE d.input_message_id=e.input_message_id AND d.callback_delivered_at IS NULL"#,
        &[&chat, &input, &status, &operation, &root_operation, &thread, &turn, &activation, &reply_turn, &protected_reply],
    )
    .await?;
    Ok(())
}
