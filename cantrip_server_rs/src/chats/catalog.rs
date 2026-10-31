use super::{Repository, roots, summary::wire_summary};
use crate::{
    wire::{Value, value::json},
    workers::repository::WorkerRepository,
};
use anyhow::{Context, Result};

#[derive(Debug)]
pub struct StandaloneUnavailable;
impl std::fmt::Display for StandaloneUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("New Chat requires a compatible online worker with standalone scratch support.")
    }
}
impl std::error::Error for StandaloneUnavailable {}
#[derive(Debug)]
pub struct StatementFailure {
    pub duplicate_message: bool,
    cause: anyhow::Error,
}
impl std::fmt::Display for StatementFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Standalone Chat catalog statement failed")
    }
}
impl std::error::Error for StatementFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.cause.as_ref())
    }
}
fn statement_failure(cause: anyhow::Error, parameters: &[&str]) -> anyhow::Error {
    // Drizzle's top-level message contains its statement and rendered params,
    // rather than the PostgreSQL cause. The route matches only that message.
    // Retain the resulting predicate without adding opaque params to logs.
    StatementFailure {
        duplicate_message: parameters.iter().any(|value| {
            let value = value.to_lowercase();
            value.contains("unique") || value.contains("duplicate")
        }),
        cause,
    }
    .into()
}
fn raw(row: &crate::database::Row) -> Result<Value> {
    Ok(serde_json::from_str(&row.get::<String>(0)?)?)
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Chat catalog text")?
        .lossy()
        .into_owned())
}
fn optional(value: &Value) -> Result<Option<String>> {
    if value.is_null() {
        Ok(None)
    } else {
        text(value).map(Some)
    }
}
fn iso(value: &Value) -> Result<Value> {
    let millis = value
        .as_js_string()
        .and_then(crate::wire::date_milliseconds)
        .context("Invalid time value")?;
    Ok(json!(
        crate::wire::date_iso_milliseconds(millis).context("Invalid time value")?
    ))
}
impl Repository {
    pub async fn list_standalone(&self, owner: &str) -> Result<Vec<Value>> {
        self.database.query("SELECT to_jsonb(c)::text FROM chats c WHERE owner_id=$1 AND context_kind='standalone' AND archived_at IS NULL ORDER BY position ASC,created_at ASC",&[&owner]).await?.iter().map(|r|wire_summary(&raw(r)?)).collect()
    }
    pub async fn list_archived_standalone(&self, owner: &str) -> Result<Vec<Value>> {
        let rows=self.database.query("SELECT to_jsonb(c)::text,(SELECT count(*)::int FROM chat_messages m WHERE m.chat_id=c.id) FROM chats c WHERE owner_id=$1 AND context_kind='standalone' AND archived_at IS NOT NULL ORDER BY archived_at DESC",&[&owner]).await?;
        rows.iter().map(|r|{
            let c=raw(r)?;let at=c["archived_at"].as_js_string().and_then(crate::wire::date_milliseconds).context("Cannot summarize an active Chat as archived.")?;
            let expiry=crate::wire::date_iso_milliseconds(at+90*24*60*60*1000).context("Invalid time value")?;
            crate::settings::parse_response("archivedStandaloneChatWireSummarySchema",Some(&json!({"id":c["id"],"contextKind":"standalone","projectId":Value::Null,"titleProtection":c["protected_label"],"experience":"agent","messageCount":r.get::<i32>(1)?,"archivedAt":iso(&c["archived_at"])? ,"expiresAt":expiry,"createdAt":iso(&c["created_at"])? ,"updatedAt":iso(&c["updated_at"])?})))
        }).collect()
    }
    pub async fn create_standalone(
        &self,
        owner: &str,
        input: &Value,
        is_connected: impl Fn(&str) -> bool + Send + Sync,
    ) -> Result<Value> {
        let rows = self
            .database
            .query(
                "SELECT to_jsonb(s)::text FROM user_settings s WHERE user_id=$1 LIMIT 1",
                &[&owner],
            )
            .await?;
        let settings = raw(rows
            .first()
            .context("Database returned no row while loading standalone Chat defaults")?)?;
        let mut workers = WorkerRepository::new(self.database.clone())
            .list_workers(owner)
            .await?;
        workers.retain(|w| {
            is_connected(w["workerId"].as_str().unwrap_or(""))
                && [
                    "provision",
                    "resolve",
                    "archive",
                    "restore",
                    "remove",
                    "reconcile",
                    "routingHandles",
                ]
                .iter()
                .all(|key| w["standaloneChat"]["scratch"][key] == true)
        });
        let collator = crate::projects::placement::collator()?;
        workers.sort_by(|a, b| {
            collator.compare_utf16(
                &a["workerId"]
                    .as_str()
                    .unwrap_or("")
                    .encode_utf16()
                    .collect::<Vec<_>>(),
                &b["workerId"]
                    .as_str()
                    .unwrap_or("")
                    .encode_utf16()
                    .collect::<Vec<_>>(),
            )
        });
        let default = optional(&settings["default_worker_id"])?;
        let worker = workers
            .iter()
            .find(|w| w["workerId"].as_str() == default.as_deref())
            .or_else(|| workers.first())
            .ok_or(StandaloneUnavailable)?;
        let worker = worker["workerId"]
            .as_str()
            .context("Standalone worker ID")?
            .to_owned();
        let model = optional(if settings["default_chat_model_id"].is_null() {
            &settings["default_model_id"]
        } else {
            &settings["default_chat_model_id"]
        })?;
        let reasoning = optional(if settings["default_chat_reasoning_effort"].is_null() {
            &settings["default_reasoning_effort"]
        } else {
            &settings["default_chat_reasoning_effort"]
        })?;
        let permission = optional(&settings["default_chat_permission_profile_id"])?;
        let rows=self.database.query("SELECT position FROM chats WHERE owner_id=$1 AND context_kind='standalone' ORDER BY position DESC LIMIT 1",&[&owner]).await?;
        let position = (i64::from(
            rows.first()
                .map(|r| r.get::<i32>(0))
                .transpose()?
                .unwrap_or(-1),
        ) + 1)
            .to_string();
        let (owner, id, label) = (
            owner.to_owned(),
            text(&input["id"])?,
            input["titleProtection"].stringify(),
        );
        let auto_title = input.get("autoTitle") == Some(&Value::Bool(true));
        let root = uuid::Uuid::new_v4().to_string();
        let runtime = uuid::Uuid::new_v4().to_string();
        let provision = uuid::Uuid::new_v4().to_string();
        self.database.transaction(|tx|Box::pin(async move {
            let rows=tx.query("INSERT INTO chats(id,owner_id,context_kind,project_id,protected_label,auto_title_pending,experience,position,active_worker_id,active_worktree_id,active_scratch_root_id,worktree_mode,model_id,reasoning_effort,custom_subagent_model,subagent_model_id,subagent_reasoning_effort,permission_profile_id,automation_paused,plan_mode,protected_plan,has_pending_plan_question) VALUES($1,$2,'standalone',NULL,$3::text::jsonb,$4,'agent',$5::text::integer,$6,NULL,$7,NULL,$8,$9,false,NULL,NULL,$10,false,'default',NULL,false) RETURNING to_jsonb(chats)::text",&[&id,&owner,&label,&auto_title,&position,&worker,&root,&model,&reasoning,&permission]).await.map_err(|error|statement_failure(error,&[&id,&owner,&label,&position,&worker,&root,model.as_deref().unwrap_or(""),reasoning.as_deref().unwrap_or(""),permission.as_deref().unwrap_or("")]))?;
            let chat=raw(rows.first().context("Database returned no row while creating a standalone Chat")?)?;
            tx.query("INSERT INTO standalone_chat_roots(id,chat_id,owner_id,worker_id,protected_path_handle,status) VALUES($1,$2,$3,$4,NULL,'provisioning')",&[&root,&id,&owner,&worker]).await.map_err(|error|statement_failure(error,&[&worker]))?;
            tx.query("INSERT INTO chat_runtime_sessions(id,chat_id,worker_id,worktree_id,scratch_root_id) VALUES($1,$2,$3,NULL,$4)",&[&runtime,&id,&worker,&root]).await.map_err(|error|statement_failure(error,&[&worker]))?;
            let lane=uuid::Uuid::new_v4().to_string();
            tx.query("INSERT INTO chat_execution_lanes(id,chat_id,worktree_id,scratch_root_id,worker_id,acquiring_actor,exclusive,purpose,state,runtime_session_id) VALUES($1,$2,NULL,$3,$4,'user',false,'Initial standalone Chat scratch root','suspended',$5)",&[&lane,&id,&root,&worker,&runtime]).await.map_err(|error|statement_failure(error,&[&worker]))?;
            let rows=tx.query("INSERT INTO standalone_chat_root_jobs(id,owner_id,root_id,chat_id,worker_id,kind,state) VALUES($1,$2,$3,$4,$5,'provision','queued') RETURNING to_jsonb(standalone_chat_root_jobs)::text",&[&provision,&owner,&root,&id,&worker]).await.map_err(|error|statement_failure(error,&[&worker]))?;
            Ok(json!({"chat":wire_summary(&chat)?,"provisionJob":roots::summary(&raw(rows.first().context("Database returned no row while queueing standalone Chat scratch provisioning")?)?)?}))
        })).await
    }
}
