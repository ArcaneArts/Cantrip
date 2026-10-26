//! Scope authorization follows the reference repository's complete read path.
use crate::{
    auth::now,
    database::Database,
    projects::repository::ProjectRepository,
    wire::{self, Value, value::Object},
};
use anyhow::{Context, Result, bail};
use std::sync::Arc;

pub struct LiveRepository {
    database: Arc<Database>,
    projects: ProjectRepository,
}
fn object(fields: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect::<Object>(),
    )
}
fn text(value: impl Into<String>) -> Value {
    Value::String(value.into().into())
}
fn nullable(value: Option<String>) -> Value {
    value.map(text).unwrap_or(Value::Null)
}
fn copy(value: &Value, key: &str) -> Value {
    value.get(key).cloned().unwrap_or(Value::Null)
}
fn same_generation(left: Option<&Value>, right: Option<&Value>) -> bool {
    // These fields came from separate JSON properties. JavaScript === never
    // equates their array/object identities, even with identical contents.
    !matches!(left, Some(Value::Array(_) | Value::Object(_)))
        && !matches!(right, Some(Value::Array(_) | Value::Object(_)))
        && left == right
}

// getChatExecutionContext constructs this projection after validating the model
// configuration. Preserve its property-access failures without validating
// additional optional metadata that the reference deliberately retains opaquely.
fn permission_projection(state: &Value, source: &Value) -> Result<()> {
    let policy = state.get("permissionPolicy");
    if !wire::coercion::truthy(policy) || source["threadId"].is_null() {
        return Ok(());
    }
    let policy = policy.unwrap();
    let retained_source = policy
        .get("source")
        .filter(|v| !v.is_null())
        .context("Native permission policy source is unavailable")?;
    let fields = [
        "threadId",
        "workerId",
        "placementId",
        "modelRouteId",
        "providerAccountId",
        "contextKind",
        "projectId",
    ];
    if !fields
        .into_iter()
        .all(|key| retained_source.get(key) == source.get(key))
    {
        return Ok(());
    }
    let binding = state.get("binding");
    if wire::coercion::truthy(binding)
        && same_generation(
            retained_source.get("runtimeGeneration"),
            binding.and_then(|v| v.get("runtimeGeneration")),
        )
    {
        policy
            .get("settingsVersion")
            .filter(|v| !v.is_null())
            .context("Native permission policy settings version is unavailable")?;
    }
    Ok(())
}
impl LiveRepository {
    pub fn new(database: Arc<Database>) -> Result<Self> {
        Ok(Self {
            projects: ProjectRepository::new(database.clone())?,
            database,
        })
    }
    pub async fn authorize(&self, owner: &str, scope: &Value) -> Result<bool> {
        match scope["kind"].as_str() {
            Some("current-user") => Ok(true),
            Some("project") => Ok(self
                .projects
                .list(owner)
                .await?
                .iter()
                .any(|project| project["id"] == scope["projectId"])),
            Some("chat") => match scope["chatId"].as_js_string() {
                // Both reference connectors encode SQL text as UTF-8, replacing
                // unpaired UTF-16 units. In-memory project ID comparison above
                // deliberately keeps JavaScript's exact UTF-16 equality.
                Some(id) => self.chat(owner, &id.lossy()).await,
                None => Ok(false),
            },
            _ => Ok(false),
        }
    }
    pub async fn session_active(&self, session: &str, owner: &str) -> Result<bool> {
        Ok(!self.database.query("SELECT s.id FROM user_sessions s INNER JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>$3 AND u.status='active' LIMIT 1",&[&session,&owner,&now()]).await?.is_empty())
    }
    async fn chat(&self, owner: &str, chat: &str) -> Result<bool> {
        let identities = self
            .database
            .query(
                "SELECT context_kind FROM chats WHERE id=$1 AND owner_id=$2 LIMIT 1",
                &[&chat, &owner],
            )
            .await?;
        let standalone = identities
            .first()
            .map(|row| row.get::<String>(0))
            .transpose()?
            .is_some_and(|kind| kind == "standalone");
        let sql = if standalone {
            "SELECT to_jsonb(c)::text,n.state::text,r.codex_thread_id,root.worker_id,root.id,NULL::text,r.model_route_id,r.provider_account_id FROM chats c LEFT JOIN native_settings_states n ON n.chat_id=c.id INNER JOIN standalone_chat_roots root ON root.id=c.active_scratch_root_id AND root.chat_id=c.id AND root.owner_id=c.owner_id AND root.worker_id=c.active_worker_id LEFT JOIN chat_runtime_sessions r ON r.chat_id=c.id AND r.worker_id=root.worker_id AND r.scratch_root_id=root.id LEFT JOIN chat_execution_lanes l ON l.chat_id=c.id AND l.state='active' LEFT JOIN user_settings s ON s.user_id=c.owner_id WHERE c.id=$1 AND c.owner_id=$2 AND c.context_kind='standalone' AND c.archived_at IS NULL LIMIT 1"
        } else {
            "SELECT to_jsonb(c)::text,n.state::text,r.codex_thread_id,w.worker_id,w.id,p.id,r.model_route_id,r.provider_account_id FROM chats c LEFT JOIN native_settings_states n ON n.chat_id=c.id INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$2 LEFT JOIN user_settings s ON s.user_id=p.owner_id INNER JOIN project_worktrees w ON w.id=c.active_worktree_id LEFT JOIN chat_runtime_sessions r ON r.chat_id=c.id AND r.worker_id=w.worker_id AND r.worktree_id=w.id LEFT JOIN chat_execution_lanes l ON l.chat_id=c.id AND l.state='active' WHERE c.id=$1 AND c.archived_at IS NULL LIMIT 1"
        };
        let rows = self.database.query(sql, &[&chat, &owner]).await?;
        let Some(row) = rows.first() else {
            return Ok(false);
        };
        let chat: Value = serde_json::from_str(&row.get::<String>(0)?)?;
        let project = row.get::<Option<String>>(5)?;
        if !standalone && project.as_ref().is_none_or(String::is_empty) {
            bail!("Project Chat operation received a standalone Chat.");
        }
        let model = object([
            ("modelId", copy(&chat, "model_id")),
            ("reasoningEffort", copy(&chat, "reasoning_effort")),
            ("customSubagentModel", copy(&chat, "custom_subagent_model")),
            ("subagentModelId", copy(&chat, "subagent_model_id")),
            (
                "subagentReasoningEffort",
                copy(&chat, "subagent_reasoning_effort"),
            ),
        ]);
        wire::parse("modelConfigurationSchema", Some(&model))
            .map_err(|_| anyhow::anyhow!("Invalid chat model configuration"))?;
        let state = row
            .get::<Option<String>>(1)?
            .map(|raw| serde_json::from_str::<Value>(&raw))
            .transpose()?
            .unwrap_or(Value::Null);
        let source = object([
            ("threadId", nullable(row.get(2)?)),
            ("workerId", text(row.get::<String>(3)?)),
            ("placementId", text(row.get::<String>(4)?)),
            ("modelRouteId", nullable(row.get(6)?)),
            ("providerAccountId", nullable(row.get(7)?)),
            (
                "contextKind",
                text(if standalone { "standalone" } else { "project" }),
            ),
            ("projectId", nullable(project)),
        ]);
        permission_projection(&state, &source)?;
        Ok(true)
    }
}
