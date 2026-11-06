//! Canonical encrypted retention commits atomically with direct TUI admission.
use super::{
    admit::{reject, text},
    managed_queue::deep_equal,
    queue, queued_prompt,
};
use crate::{database::Transaction, wire::Value};
use anyhow::Result;

pub(super) async fn retain(
    tx: &Transaction<'_>,
    owner: &str,
    row: &Value,
    input: &Value,
) -> Result<()> {
    let Some(retained) = input.get("retainedInput") else {
        return Ok(());
    };
    let prompt = &retained["prompt"];
    let attachments = retained["attachments"].as_array().unwrap();
    let ids = Value::Array(attachments.iter().map(|item| item["id"].clone()).collect());
    if row["origin"] != "terminal"
        || row["kind"] != "start"
        || row["method"] != "turn/start"
        || !input["queueClaim"].is_null()
        || !input["intent"]["expectedTurnId"].is_null()
        || prompt["pendingMessage"]["classification"]["role"] != "user"
        || prompt["executionMethod"] != "turn/start"
        || prompt["nativeAction"] != "literal"
        || prompt["protectedNativeInput"].is_null()
        || prompt["nativeClientUserMessageId"].is_null()
        || prompt["nativeClientUserMessageId"] != input["intent"]["nativeClientUserMessageId"]
        || attachments
            .iter()
            .any(|item| item["chatId"] != row["chat_id"])
        || !deep_equal(&prompt["classification"]["attachmentIds"], &ids)
    {
        return reject("invalid-terminal-input");
    }
    let chat = text(&row["chat_id"])?;
    let id = text(&prompt["id"])?;
    let key = text(&prompt["idempotencyKey"])?;
    if !tx
        .query(
            "SELECT id FROM queued_prompts WHERE chat_id=$1 AND (id=$2 OR idempotency_key=$3)",
            &[&chat, &id, &key],
        )
        .await?
        .is_empty()
    {
        return reject("terminal-input-conflict");
    }
    let saved = queued_prompt::create(tx, owner, &chat, prompt, &retained["attachments"]).await?;
    if !saved.as_ref().is_some_and(|saved| {
        saved["id"] == prompt["id"]
            && saved["revision"] == 0
            && ["pendingMessage", "protectedContent", "protectedNativeInput"]
                .iter()
                .all(|field| deep_equal(&saved[field], &prompt[field]))
    }) {
        return reject("terminal-input-conflict");
    }
    let operation = text(&row["operation_id"])?;
    let generation = text(&row["operation_generation"])?;
    let claim = format!("terminal:{id}");
    let now = crate::auth::now();
    tx.query(
        "INSERT INTO managed_queue_states(chat_id) VALUES($1) ON CONFLICT DO NOTHING",
        &[&chat],
    )
    .await?;
    tx.query("INSERT INTO managed_queue_claims(id,chat_id,prompt_id,prompt_revision,operation_id,operation_generation,status,created_at) VALUES($1,$2,$3,0,$4,$5,'accepted',$6)", &[&claim,&chat,&id,&operation,&generation,&now]).await?;
    tx.query(
        "UPDATE queued_prompts SET state='claimed',updated_at=$1 WHERE id=$2",
        &[&now, &id],
    )
    .await?;
    queue::changed(tx, &chat).await?;
    Ok(())
}
