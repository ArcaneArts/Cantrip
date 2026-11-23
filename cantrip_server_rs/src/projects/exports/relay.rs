use crate::{
    chats::hydration::encode_canonical_payload,
    settings::parse_response,
    wire::{Value, value::json},
    workers::command_bus::LimitedCommandBus,
};
use anyhow::Result;
use base64::{Engine, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const COMPLETE_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const CHUNK_BYTES: usize = 256 * 1024;

pub struct Input<'a> {
    pub operation: &'a Value,
    pub target: &'a Value,
    pub worker: &'a str,
    pub chat: &'a Value,
    pub cwd: &'a Value,
    pub title: &'a Value,
    pub payload: &'a Value,
}
pub async fn export(commands: &Arc<LimitedCommandBus>, input: Input<'_>) -> Result<Value> {
    let bytes = encode_canonical_payload(input.payload);
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let begin = commands
        .request(
            input.worker,
            json!({
                "type":"project.export.chat.begin", "operationId":input.operation,
                "target":input.target, "chatId":input.chat, "cwd":input.cwd,
                "titleProtection":input.title, "transcriptSha256":digest, "sizeBytes":bytes.len()
            }),
            Some(REQUEST_TIMEOUT),
            None,
        )
        .await?;
    let mut begin = parse_response("projectExportChatBeginResultSchema", begin.as_ref())?;
    if begin["status"] == "exported" {
        if let Value::Object(fields) = &mut begin {
            fields.shift_remove("status");
        }
        return parse_response("projectExportChatResultSchema", Some(&begin));
    }
    for (index, chunk) in bytes.chunks(CHUNK_BYTES).enumerate() {
        // Source accepts the chunk acknowledgment without parsing its body.
        commands
            .request(
                input.worker,
                json!({
                    "type":"project.export.chat.chunk", "operationId":input.operation,
                    "chatId":input.chat, "chunkIndex":index, "data":STANDARD.encode(chunk)
                }),
                Some(REQUEST_TIMEOUT),
                None,
            )
            .await?;
    }
    let result = commands.request(input.worker, json!({
        "type":"project.export.chat.complete", "operationId":input.operation, "chatId":input.chat
    }), Some(COMPLETE_TIMEOUT), None).await?;
    parse_response("projectExportChatResultSchema", result.as_ref())
}
