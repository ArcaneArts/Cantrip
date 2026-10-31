use super::*;
pub(super) async fn persist(tx: &Transaction<'_>, binding: &Value, item: &Value) -> Result<()> {
    let chat = text(&binding["chatId"])?;
    let worker = text(&binding["workerId"])?;
    let referenced = item["message"]["classification"]["attachmentIds"]
        .as_array()
        .context("History attachment references")?;
    let mut supplied = Vec::new();
    for attachment in item["attachments"]
        .as_array()
        .context("History attachments")?
    {
        let id = text(&attachment["id"])?;
        if attachment["chatId"] != binding["chatId"]
            || !referenced.contains(&attachment["id"])
            || supplied.contains(&id)
        {
            return reject("item-attachment-mismatch", 409);
        }
        supplied.push(id.clone());
        let existing = one(
            tx,
            "SELECT to_jsonb(a)::text FROM chat_attachments a WHERE id=$1 FOR UPDATE",
            &[&id],
        )
        .await?;
        if existing
            .as_ref()
            .is_some_and(|r| r["chat_id"] != binding["chatId"])
        {
            return reject("attachment-chat-mismatch", 409);
        }
        let metadata = attachment["protectedMetadata"].stringify();
        let size = attachment["sizeBytes"].stringify();
        let status = text(&attachment["status"])?;
        if let Some(existing) = &existing {
            if existing["status"] != "ready" && attachment["status"] == "ready" {
                tx.query("UPDATE chat_attachments SET protected_metadata=$1::text::jsonb,size_bytes=$2::text::integer,status=$3,updated_at=$4 WHERE id=$5",&[&metadata,&size,&status,&crate::auth::now(),&id]).await?;
            } else if attachment["status"] == "ready"
                && (existing["size_bytes"] != attachment["sizeBytes"]
                    || existing["protected_metadata"] != attachment["protectedMetadata"])
            {
                return reject("attachment-content-conflict", 409);
            }
        } else {
            let created =
                chrono::DateTime::parse_from_rfc3339(&text(&attachment["createdAt"])?)?.to_utc();
            tx.query("INSERT INTO chat_attachments(id,chat_id,worker_id,protected_metadata,size_bytes,status,created_at) VALUES($1,$2,$3,$4::text::jsonb,$5::text::integer,$6,$7)",&[&id,&chat,&worker,&metadata,&size,&status,&created]).await?;
        }
        if attachment["status"] == "ready" {
            let verified = crate::auth::now();
            let updated = crate::auth::now();
            tx.query("INSERT INTO chat_attachment_replicas(attachment_id,worker_id,status) VALUES($1,$2,'ready') ON CONFLICT(attachment_id,worker_id) DO UPDATE SET status='ready',verified_at=$3,updated_at=$4",&[&id,&worker,&verified,&updated]).await?;
        }
    }
    for id in referenced {
        let id = text(id)?;
        if supplied.contains(&id) {
            continue;
        }
        if tx
            .query(
                "SELECT id FROM chat_attachments WHERE id=$1 AND chat_id=$2",
                &[&id, &chat],
            )
            .await?
            .is_empty()
        {
            return reject("referenced-attachment-unavailable", 409);
        }
    }
    Ok(())
}
