//! Durable read/write collaborators for the full turn bootstrap and stream.
use super::{Repository, catalog, execution_lanes::LaneError};
use crate::{
    database::Executor,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::Result;
impl Repository {
    pub async fn live_routing(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        let rows=self.database.query("SELECT jsonb_build_object('experience',experience,'projectId',project_id)::text FROM chats WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL LIMIT 1",&[&chat,&owner]).await?;
        rows.first().map(catalog::raw).transpose()
    }
    pub async fn encrypted_plan(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        let rows = self
            .database
            .query(
                "SELECT protected_plan::text FROM chats WHERE id=$1 AND owner_id=$2 LIMIT 1",
                &[&chat, &owner],
            )
            .await?;
        let input = rows
            .first()
            .map(|row| row.get::<Option<String>>(0))
            .transpose()?
            .flatten();
        input
            .filter(|s| s != "null")
            .map(|s| {
                crate::settings::parse_response(
                    "chatPlanOpaqueStateSchema",
                    Some(&serde_json::from_str::<Value>(&s)?),
                )
            })
            .transpose()
    }
    pub async fn plan_wire_state(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        let rows=self.database.query("SELECT jsonb_build_object('kind','chat-encrypted','chatId',id,'mode',plan_mode,'hasQuestion',has_pending_plan_question,'state',protected_plan)::text FROM chats WHERE id=$1 AND owner_id=$2 LIMIT 1",&[&chat,&owner]).await?;
        rows.first()
            .map(|row| {
                crate::settings::parse_response(
                    "encryptedChatPlanWireStateSchema",
                    Some(&catalog::raw(row)?),
                )
            })
            .transpose()
    }
    pub async fn update_plan_mode(
        &self,
        owner: &str,
        chat: &str,
        mode: &str,
    ) -> Result<Option<Value>> {
        if self.plan_wire_state(owner, chat).await?.is_none() {
            return Ok(None);
        }
        let rows = self
            .database
            .query(
                "SELECT context_kind FROM chats WHERE id=$1 AND owner_id=$2 LIMIT 1",
                &[&chat, &owner],
            )
            .await?;
        if rows
            .first()
            .is_some_and(|r| r.get::<String>(0).is_ok_and(|s| s == "standalone"))
            && mode != "default"
        {
            return Err(LaneError::Conflict(
                "Standalone Chat supports only default conversation mode.".into(),
            )
            .into());
        }
        self.database.query("UPDATE chats SET plan_mode=$2,protected_plan=CASE WHEN $2='default' THEN NULL ELSE protected_plan END,has_pending_plan_question=CASE WHEN $2='default' THEN false ELSE has_pending_plan_question END,updated_at=$3 WHERE id=$1",&[&chat,&mode,&crate::auth::now()]).await?;
        self.plan_wire_state(owner, chat).await
    }
    pub async fn update_encrypted_plan(&self, chat: &str, state: &Value) -> Result<()> {
        let parsed = crate::settings::parse_response("chatPlanOpaqueStateSchema", Some(state))?;
        self.database.query("UPDATE chats SET protected_plan=$1::text::jsonb,has_pending_plan_question=$2,updated_at=$3 WHERE id=$4",&[&parsed.stringify(),&parsed["classification"]["hasQuestion"].as_bool().unwrap(),&crate::auth::now(),&chat]).await?;
        Ok(())
    }
    pub async fn prompt_attachments(
        &self,
        owner: &str,
        context: &Value,
        ids: &Value,
    ) -> Result<Vec<Value>> {
        let chat = context["chatId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Chat attachment context"))?;
        let attachments = crate::native_commands::attachments::get(
            Executor::Database(&self.database),
            owner,
            chat,
            ids,
        )
        .await?;
        if attachments.len() != ids.as_array().map_or(0, Vec::len) {
            anyhow::bail!("One or more attachments are unavailable.")
        }
        if attachments
            .iter()
            .any(|a| a["workerId"] != context["workerId"])
        {
            anyhow::bail!("Attachments belong to another worker.")
        }
        Ok(attachments)
    }
    pub async fn skill_audience_keys(
        &self,
        owner: &str,
        worker: &str,
        provider: &str,
    ) -> Result<Vec<Value>> {
        self.database.query("SELECT audience_key FROM skill_audiences WHERE owner_id=$1 AND worker_id=$2 AND provider_id=$3 AND audience IN ('chat','both') ORDER BY audience_key ASC",&[&owner,&worker,&provider]).await?.iter().map(|r|r.get::<String>(0).map(|v|json!(v))).collect()
    }
}
pub fn attachment_summary(attachment: &Value) -> Value {
    let mut result = attachment.clone();
    if let Value::Object(object) = &mut result {
        object.shift_remove("workerId");
    }
    result
}
pub fn message_stub(message: &Value) -> Value {
    let contextual = message.get("scratchRootId").is_some();
    let mut result = json!({"contextKind":if contextual {message["contextKind"].clone()}else{json!("project")},"scratchRootId":if contextual {message["scratchRootId"].clone()}else{Value::Null},"content":Vec::<Value>::new()});
    for key in [
        "id",
        "chatId",
        "worktreeId",
        "executionLaneId",
        "sequence",
        "role",
        "mode",
        "modelId",
        "modelRouteId",
        "providerId",
        "providerName",
        "providerModelName",
        "reasoningEffort",
        "appliedReasoningEffort",
        "reasoningAdjusted",
        "createdAt",
    ] {
        if let Some(value) = message.get(key) {
            result[key] = value.clone();
        }
    }
    result
}
pub fn project_scope(project: &Value) -> Value {
    if truthy(Some(project)) {
        json!({"kind":"project","projectId":project})
    } else {
        json!({"kind":"current-user"})
    }
}
