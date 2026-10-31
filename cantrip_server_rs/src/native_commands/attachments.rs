//! Transaction-bound port of ChatAttachmentRepository.getChatAttachments.
use super::{admit::text, receipt, settings_persistence::parse};
use crate::{
    database::Transaction,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
pub(super) async fn get(
    tx: &Transaction<'_>,
    owner: &str,
    chat: &str,
    ids: &Value,
) -> Result<Vec<Value>> {
    let ids = ids.as_array().context("Chat attachment identifiers")?;
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let encoded = ids.iter().map(text).collect::<Result<Vec<_>>>()?;
    let rows=tx.query("SELECT to_jsonb(a)::text FROM chat_attachments a INNER JOIN chats c ON c.id=a.chat_id AND c.id=$1 WHERE c.owner_id=$2 AND a.id=ANY($3::text[])",&[&chat,&owner,&encoded]).await?;
    // Map every selected row before reordering, including malformed rows that an
    // original UTF-16 identifier would not select from the resulting JS Map.
    let mapped=rows.iter().map(|row|{
        let row:Value=serde_json::from_str(&row.get::<String>(0)?)?;
        let mut result=parse("chatAttachmentOpaqueSummarySchema",&json!({"id":row["id"],"chatId":row["chat_id"],"sizeBytes":row["size_bytes"],"status":row["status"],"protectedMetadata":row["protected_metadata"],"createdAt":receipt::iso(&row["created_at"])?}))?;
        result["workerId"]=row["worker_id"].clone();
        Ok(result)
    }).collect::<Result<Vec<_>>>()?;
    Ok(ids
        .iter()
        .filter_map(|id| mapped.iter().find(|row| row.get("id") == Some(id)).cloned())
        .collect())
}
