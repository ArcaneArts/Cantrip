//! Opaque labels and drafts remain server-owned ciphertext.
use super::{
    Repository,
    catalog::{iso, raw},
    summary::wire_summary,
};
use crate::wire::{Value, value::json};
use anyhow::Result;

impl Repository {
    pub async fn set_automation_paused(
        &self,
        owner: &str,
        chat: &str,
        paused: bool,
    ) -> Result<Option<Value>> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        self.database.transaction(|tx|Box::pin(async move{
            let at=crate::auth::now();
            let rows=crate::database::task_pause_queries::context(tx.query("UPDATE chats SET automation_paused=$3,updated_at=$4 WHERE id=$1 AND owner_id=$2 RETURNING to_jsonb(chats)::text",&[&chat,&owner,&paused,&at]).await,"chat",&[json!(paused),json!(crate::auth::iso(at)),json!(chat),json!(owner)])?;
            if !rows.is_empty(){crate::database::task_pause_queries::context(tx.query("UPDATE managed_queue_states SET revision=revision+1 WHERE chat_id=$1",&[&chat]).await,"queue",&[json!(chat)])?;}
            rows.first().map(|row|wire_summary(&raw(row)?)).transpose()
        })).await
    }
    pub async fn update_label(
        &self,
        owner: &str,
        id: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        if self
            .database
            .query(
                "SELECT id FROM chats WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL LIMIT 1",
                &[&id, &owner],
            )
            .await?
            .is_empty()
        {
            return Ok(None);
        }
        let label = input["titleProtection"].stringify();
        let at = crate::auth::now();
        let rows=self.database.query("UPDATE chats SET protected_label=$1::text::jsonb,auto_title_pending=false,auto_title_claim=NULL,updated_at=$2 WHERE id=$3 AND archived_at IS NULL RETURNING to_jsonb(chats)::text",&[&label,&at,&id]).await?;
        rows.first().map(|r| wire_summary(&raw(r)?)).transpose()
    }
    pub async fn acknowledge_completion(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        let rows=self.database.query("UPDATE chats SET has_unread_completion=false WHERE id=$1 AND owner_id=$2 RETURNING to_jsonb(chats)::text",&[&id,&owner]).await?;
        rows.first().map(|r| wire_summary(&raw(r)?)).transpose()
    }
    pub async fn composer_draft(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        let rows=self.database.query("SELECT to_jsonb(c)::text FROM chats c WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL LIMIT 1",&[&id,&owner]).await?;
        rows.first().map(|r|{let c=raw(r)?;crate::settings::parse_response("encryptedChatComposerDraftWireStateSchema",Some(&json!({"chatId":c["id"],"state":c["protected_composer_draft"],"updatedAt":if c["composer_draft_updated_at"].is_null(){Value::Null}else{iso(&c["composer_draft_updated_at"])?}})))}).transpose()
    }
    pub async fn update_composer_draft(
        &self,
        owner: &str,
        id: &str,
        state: &Value,
    ) -> Result<Option<Value>> {
        let state = if crate::wire::coercion::truthy(Some(state)) {
            crate::settings::parse_response("chatComposerDraftOpaqueStateSchema", Some(state))?
        } else {
            Value::Null
        };
        let stored = if state.is_null() {
            None
        } else {
            Some(state.stringify())
        };
        let at = crate::auth::now();
        let rows=self.database.query("UPDATE chats SET protected_composer_draft=$1::text::jsonb,composer_draft_updated_at=$2 WHERE id=$3 AND archived_at IS NULL AND owner_id=$4 RETURNING id",&[&stored,&at,&id,&owner]).await?;
        rows.first().map(|r|crate::settings::parse_response("encryptedChatComposerDraftWireStateSchema",Some(&json!({"chatId":r.get::<String>(0)?,"state":state,"updatedAt":crate::auth::iso(at)})))).transpose()
    }
}
