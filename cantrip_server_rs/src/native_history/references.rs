use super::*;
use crate::wire::value::json;
use std::collections::HashMap;

pub(super) async fn read(
    tx: &Transaction<'_>,
    chat: &str,
    messages: &[String],
) -> Result<HashMap<String, Vec<Value>>> {
    if messages.is_empty() {
        return Ok(HashMap::new());
    }
    let rows=all(tx,"SELECT jsonb_build_object('id',id,'attachments',attachment_ids)::text FROM chat_messages WHERE chat_id=$1 AND id=ANY($2::text[])",&[&chat,&messages]).await?;
    let mut ids = Vec::new();
    for row in &rows {
        for id in row["attachments"]
            .as_array()
            .context("Historical attachment IDs")?
        {
            let id = text(id)?;
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    }
    let mut descriptors = HashMap::new();
    if !ids.is_empty() {
        for row in all(tx,"SELECT to_jsonb(a)::text FROM chat_attachments a WHERE chat_id=$1 AND id=ANY($2::text[])",&[&chat,&ids]).await? {
            let date=chrono::DateTime::parse_from_rfc3339(&text(&row["created_at"])?)?;
            let descriptor=json!({"id":row["id"],"chatId":row["chat_id"],"sizeBytes":row["size_bytes"],"status":row["status"],"protectedMetadata":row["protected_metadata"],"createdAt":crate::auth::iso(date.to_utc())});
            descriptors.insert(text(&row["id"])?,crate::settings::parse_response("chatAttachmentOpaqueSummarySchema",Some(&descriptor))?);
        }
    }
    let mut result = HashMap::new();
    for row in rows {
        let mut refs = Vec::new();
        for id in row["attachments"]
            .as_array()
            .context("Historical message attachments")?
        {
            let Some(value) = descriptors.get(&text(id)?) else {
                return reject("referenced-attachment-unavailable", 409);
            };
            refs.push(value.clone());
        }
        result.insert(text(&row["id"])?, refs);
    }
    Ok(result)
}
