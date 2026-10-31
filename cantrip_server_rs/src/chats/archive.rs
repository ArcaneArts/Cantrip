//! Chat retention preserves the reference lock order and commit boundaries.
use super::{
    Repository,
    catalog::{iso, raw},
    summary::wire_summary,
};
use crate::{
    database::Transaction,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};

fn executing(chat: &Value) -> bool {
    chat["status"] == "running" || chat["status"] == "waiting-for-approval"
}
async fn lock_project(tx: &Transaction<'_>, owner: &str, id: &str) -> Result<Option<String>> {
    tx.query("SELECT id FROM projects WHERE owner_id=$1 AND id IN (SELECT project_id FROM chats WHERE id=$2) FOR UPDATE", &[&owner,&id]).await?.first().map(|r|r.get(0)).transpose()
}
async fn detach(tx: &Transaction<'_>, owner: &str, project: &str, id: &str) -> Result<()> {
    crate::workspaces::remove_resource(tx, owner, project, "project.agent", id).await?;
    crate::project_layout::detach_resource(tx, project, "chat", id).await
}
pub(super) fn archived_summary(chat: &Value, count: i32) -> Result<Value> {
    let at = chat["archived_at"]
        .as_js_string()
        .and_then(crate::wire::date_milliseconds)
        .context("Cannot summarize an active Chat as archived.")?;
    crate::settings::parse_response(
        "archivedStandaloneChatWireSummarySchema",
        Some(
            &json!({"id":chat["id"],"contextKind":"standalone","projectId":Value::Null,"titleProtection":chat["protected_label"],"experience":"agent","messageCount":count,"archivedAt":iso(&chat["archived_at"])? ,"expiresAt":crate::wire::date_iso_milliseconds(at+90*24*60*60*1000).context("Invalid time value")?,"createdAt":iso(&chat["created_at"])? ,"updatedAt":iso(&chat["updated_at"])?}),
        ),
    )
}
impl Repository {
    pub async fn archive_agent(&self, owner: &str, id: &str) -> Result<Value> {
        let (owner, id) = (owner.to_owned(), id.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            let Some(project)=lock_project(tx,&owner,&id).await? else{return Ok(json!(false))};
            let rows=tx.query("SELECT to_jsonb(c)::text FROM chats c WHERE id=$1 AND project_id=$2 AND context_kind='project' AND experience='agent' FOR UPDATE",&[&id,&project]).await?;
            let Some(chat)=rows.first().map(raw).transpose()? else{return Ok(json!(false))};
            if !chat["archived_at"].is_null(){return Ok(json!("archived"))}
            if executing(&chat){return Ok(json!("running"))}
            detach(tx,&owner,&project,&id).await?;
            let at=crate::auth::now();
            tx.query("UPDATE chats SET archived_at=$1,automation_paused=true,status='idle',updated_at=$1 WHERE id=$2",&[&at,&id]).await?;
            Ok(json!("archived"))
        })).await
    }
    pub async fn delete_chat(&self, owner: &str, id: &str) -> Result<Value> {
        // The legacy operation authorizes and checks status before its transaction.
        let rows=self.database.query("SELECT to_jsonb(c)::text FROM chats c INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE c.id=$2 LIMIT 1",&[&owner,&id]).await?;
        let Some(chat) = rows.first().map(raw).transpose()? else {
            return Ok(json!(false));
        };
        if !chat["archived_at"].is_null() {
            return Ok(json!(false));
        }
        let project = chat["project_id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .context("Project Chat operation received a standalone Chat.")?
            .to_owned();
        if executing(&chat) {
            return Ok(json!("running"));
        }
        let (owner, id) = (owner.to_owned(), id.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            crate::workspaces::remove_resource(tx,&owner,&project,"project.agent",&id).await?;
            let messages=tx.query("SELECT id FROM chat_messages WHERE chat_id=$1 LIMIT 1",&[&id]).await?;
            crate::project_layout::detach_resource(tx,&project,"chat",&id).await?;
            if !messages.is_empty(){
                let archived=crate::auth::now();let updated=crate::auth::now();
                tx.query("UPDATE chats SET archived_at=$1,automation_paused=true,status='idle',updated_at=$2 WHERE id=$3",&[&archived,&updated,&id]).await?;
                Ok(json!("archived"))
            }else{
                tx.query("DELETE FROM chats WHERE id=$1",&[&id]).await?;
                Ok(json!("deleted"))
            }
        })).await
    }
    pub async fn archive_standalone(&self, owner: &str, id: &str) -> Result<Value> {
        let (owner, id) = (owner.to_owned(), id.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT to_jsonb(c)::text,to_jsonb(r)::text FROM chats c INNER JOIN standalone_chat_roots r ON r.id=c.active_scratch_root_id AND r.chat_id=c.id WHERE c.id=$1 AND c.owner_id=$2 AND c.context_kind='standalone' AND c.archived_at IS NULL LIMIT 1 FOR UPDATE",&[&id,&owner]).await?;
            let Some(row)=rows.first() else{return Ok(json!(false))};
            let chat=raw(row)?;if executing(&chat){return Ok(json!("running"))}
            let root:Value=serde_json::from_str(&row.get::<String>(1)?)?;
            let root_id=root["id"].as_str().context("Scratch root ID")?;
            let at=crate::auth::now();let expiry=at+chrono::Duration::days(90);
            let rows=tx.query("UPDATE chats SET archived_at=$1,status='idle',updated_at=$1 WHERE id=$2 RETURNING to_jsonb(chats)::text",&[&at,&id]).await?;
            let chat=raw(rows.first().context("Database returned no row while archiving a standalone Chat")?)?;
            tx.query("UPDATE standalone_chat_roots SET archived_at=$1,archive_expires_at=$2,updated_at=$1 WHERE id=$3",&[&at,&expiry,&root_id]).await?;
            let count=tx.query("SELECT count(*)::int FROM chat_messages WHERE chat_id=$1",&[&id]).await?[0].get::<i32>(0)?;
            Ok(json!({"archivedAt":crate::auth::iso(at),"archiveExpiresAt":crate::auth::iso(expiry),"chat":archived_summary(&chat,count)?,"rootId":root["id"],"workerId":root["worker_id"]}))
        })).await
    }
    pub async fn restore_standalone(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        let (owner, id) = (owner.to_owned(), id.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("SELECT to_jsonb(c)::text,to_jsonb(r)::text FROM chats c INNER JOIN standalone_chat_roots r ON r.id=c.active_scratch_root_id WHERE c.id=$1 AND c.owner_id=$2 AND c.context_kind='standalone' AND c.archived_at IS NOT NULL LIMIT 1 FOR UPDATE",&[&id,&owner]).await?;
            let Some(row)=rows.first() else{return Ok(None)};
            let root:Value=serde_json::from_str(&row.get::<String>(1)?)?;
            let at=crate::auth::now();
            let rows=tx.query("UPDATE chats SET archived_at=NULL,updated_at=$1 WHERE id=$2 RETURNING to_jsonb(chats)::text",&[&at,&id]).await?;
            let chat=raw(rows.first().context("Database returned no row while restoring a standalone Chat")?)?;
            let at=crate::auth::now();let root_id=root["id"].as_str().context("Scratch root ID")?;
            tx.query("UPDATE standalone_chat_roots SET archived_at=NULL,archive_expires_at=NULL,updated_at=$1 WHERE id=$2",&[&at,&root_id]).await?;
            Ok(Some(json!({"chat":wire_summary(&chat)?,"rootId":root["id"],"workerId":root["worker_id"]})))
        })).await
    }
    pub async fn standalone_deletion_root(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        let rows=self.database.query("SELECT jsonb_build_object('chatId',r.chat_id,'ownerId',r.owner_id,'rootId',r.id,'workerId',r.worker_id)::text FROM standalone_chat_roots r INNER JOIN chats c ON c.id=r.chat_id WHERE c.id=$1 AND c.owner_id=$2 AND c.context_kind='standalone' AND c.archived_at IS NOT NULL LIMIT 1",&[&id,&owner]).await?;
        rows.first().map(raw).transpose()
    }
    pub async fn restore_archived(
        &self,
        owner: &str,
        id: &str,
        options: &Value,
    ) -> Result<Option<Value>> {
        let attach = options["attachToTabLayout"] != false;
        // PGlite owns one connection; this collaborator must run before the tx.
        let position = if attach {
            let rows = self
                .database
                .query(
                    "SELECT project_id FROM chats WHERE id=$1 AND owner_id=$2",
                    &[&id, &owner],
                )
                .await?;
            if let Some(project) = rows
                .first()
                .map(|r| r.get::<Option<String>>(0))
                .transpose()?
                .flatten()
                .filter(|s| !s.is_empty())
            {
                Some(crate::project_layout::next_position(&self.database, &project).await?)
            } else {
                None
            }
        } else {
            None
        };
        let (owner, id) = (owner.to_owned(), id.to_owned());
        self.database.transaction(|tx|Box::pin(async move {
            let Some(project)=lock_project(tx,&owner,&id).await? else{return Ok(None)};
            let rows=tx.query("SELECT to_jsonb(c)::text FROM chats c WHERE id=$1 AND project_id=$2 FOR UPDATE",&[&id,&project]).await?;
            let Some(chat)=rows.first().map(raw).transpose()? else{return Ok(None)};
            if chat["archived_at"].is_null(){return if !attach && chat["experience"]=="agent"{wire_summary(&chat).map(Some)}else{Ok(None)}}
            let at=crate::auth::now();
            let rows=if let Some(position)=position{
                tx.query("UPDATE chats SET archived_at=NULL,updated_at=$1,last_used_at=$1,position=$2::bigint::integer WHERE id=$3 RETURNING to_jsonb(chats)::text",&[&at,&position,&id]).await?
            }else{
                tx.query("UPDATE chats SET archived_at=NULL,updated_at=$1,last_used_at=$1 WHERE id=$2 RETURNING to_jsonb(chats)::text",&[&at,&id]).await?
            };
            let restored=raw(rows.first().context("Restored Chat")?)?;
            if chat["experience"]!="task" && attach{crate::project_layout::attach_resource(tx,&project,&id,"chat",&Value::Object(Default::default())).await?;}
            wire_summary(&restored).map(Some)
        })).await
    }
    pub async fn permanently_delete_archived(&self, owner: &str, id: &str) -> Result<bool> {
        Ok(!self.database.query("DELETE FROM chats WHERE id=$1 AND archived_at IS NOT NULL AND project_id IN (SELECT id FROM projects WHERE owner_id=$2) RETURNING id",&[&id,&owner]).await?.is_empty())
    }
    pub async fn purge_expired_project_chats(
        &self,
        owner: &str,
        cutoff: chrono::DateTime<chrono::Utc>,
    ) -> Result<usize> {
        Ok(self.database.query("DELETE FROM chats WHERE archived_at IS NOT NULL AND archived_at<=$1 AND project_id IN (SELECT id FROM projects WHERE owner_id=$2) RETURNING id",&[&cutoff,&owner]).await?.len())
    }
}
