//! Owner-scoped opaque attachment records and verified worker replicas.
use crate::{
    database::{Database, query_error::context},
    native_commands::receipt,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use std::sync::Arc;

// Captured from actual failed Source INSERTs, not synthesized startup checks.
const INSERT_CONTEXT: &str = "insert into \"chat_attachments\" (\"id\", \"chat_id\", \"worker_id\", \"protected_metadata\", \"size_bytes\", \"status\", \"created_at\", \"updated_at\") values ($1, $2, $3, $4, $5, $6, default, default) returning \"id\", \"chat_id\", \"worker_id\", \"protected_metadata\", \"size_bytes\", \"status\", \"created_at\", \"updated_at\"";
const REPLICA_CONTEXT: &str = "insert into \"chat_attachment_replicas\" (\"attachment_id\", \"worker_id\", \"status\", \"verified_at\", \"created_at\", \"updated_at\") values ($1, $2, $3, default, default, default)";

pub struct Repository {
    database: Arc<Database>,
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }

    pub async fn get(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        let rows = self.database.query("SELECT to_jsonb(a)::text FROM chat_attachments a INNER JOIN chats c ON c.id=a.chat_id WHERE a.id=$1 AND c.owner_id=$2 LIMIT 1", &[&id, &owner]).await?;
        rows.first()
            .map(|row| record(&serde_json::from_str(&row.get::<String>(0)?)?))
            .transpose()
    }

    pub async fn replicas(&self, owner: &str, id: &str) -> Result<Vec<String>> {
        let rows = self.database.query("SELECT r.worker_id FROM chat_attachment_replicas r INNER JOIN chat_attachments a ON a.id=r.attachment_id INNER JOIN chats c ON c.id=a.chat_id WHERE c.owner_id=$1 AND r.attachment_id=$2 AND r.status='ready'", &[&owner, &id]).await?;
        let mut workers = Vec::new();
        for row in rows {
            let worker = row.get::<String>(0)?;
            if !workers.contains(&worker) {
                workers.push(worker);
            }
        }
        Ok(workers)
    }

    pub async fn create(
        &self,
        owner: &str,
        chat: &str,
        worker: &str,
        input: &Value,
        size: i32,
    ) -> Result<Option<Value>> {
        // Source checks ownership before opening the insert transaction. The
        // two inserts and response validation then commit or roll back together.
        if self
            .database
            .query(
                "SELECT id FROM chats WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL LIMIT 1",
                &[&chat, &owner],
            )
            .await?
            .is_empty()
        {
            return Ok(None);
        }
        let id = input["attachmentId"]
            .as_str()
            .context("Attachment identity")?
            .to_owned();
        let metadata = input["protectedMetadata"].stringify();
        let (chat, worker) = (chat.to_owned(), worker.to_owned());
        self.database.transaction(move |tx| Box::pin(async move {
            let rows = context(tx.query("INSERT INTO chat_attachments(id,chat_id,worker_id,protected_metadata,size_bytes,status) VALUES($1,$2,$3,$4::text::jsonb,$5,'ready') RETURNING to_jsonb(chat_attachments)::text", &[&id,&chat,&worker,&metadata,&size]).await, INSERT_CONTEXT, &[json!(id),json!(chat),json!(worker),json!(metadata),json!(size),json!("ready")])?;
            let row: Value = serde_json::from_str(&rows.first().context("Creating an attachment")?.get::<String>(0)?)?;
            context(tx.query("INSERT INTO chat_attachment_replicas(attachment_id,worker_id,status) VALUES($1,$2,'ready')", &[&id,&worker]).await, REPLICA_CONTEXT, &[json!(id),json!(worker),json!("ready")])?;
            record(&row).map(Some)
        })).await
    }

    pub async fn delete(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        let attachment = self.get(owner, id).await?;
        if attachment.is_some() {
            self.database
                .query("DELETE FROM chat_attachments WHERE id=$1", &[&id])
                .await?;
        }
        Ok(attachment)
    }
}

fn record(row: &Value) -> Result<Value> {
    let mut value = crate::settings::parse_response(
        "chatAttachmentOpaqueSummarySchema",
        Some(
            &json!({"id":row["id"],"chatId":row["chat_id"],"sizeBytes":row["size_bytes"],"status":row["status"],"protectedMetadata":row["protected_metadata"],"createdAt":receipt::iso(&row["created_at"])?}),
        ),
    )?;
    value["workerId"] = row["worker_id"].clone();
    Ok(value)
}
