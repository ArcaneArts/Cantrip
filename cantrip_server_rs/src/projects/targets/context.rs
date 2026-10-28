use super::reads::{self, Kind, Reads, copy, json, mapped, parse, sql_text};
use crate::wire::{self, Value, coercion};
use anyhow::{Context, Result};

fn context(project: Value, worker: Value, worktree: Value) -> Value {
    Value::object([
        ("projectId", project),
        ("workerId", worker),
        ("worktreeId", worktree),
    ])
}
impl Reads {
    pub async fn context(&self, owner: &str, kind: &str, id: &Value) -> Result<Option<Value>> {
        if kind == "chat" {
            return self.chat_context(owner, id).await;
        }
        let id = sql_text(id)?;
        let (table, join) = match kind {
            "terminal" => ("terminals", ""),
            "explorer" => ("explorers", ""),
            "code" => (
                "code_tabs",
                " INNER JOIN workers x ON x.id=r.active_worker_id",
            ),
            _ => anyhow::bail!("Unsupported resource context"),
        };
        let query = format!(
            "SELECT to_jsonb(r)::text,w.id FROM {table} r INNER JOIN projects p ON p.id=r.project_id AND p.owner_id=$2 INNER JOIN project_worktrees w ON w.id=r.worktree_id{join} WHERE r.id=$1 LIMIT 1"
        );
        let rows = self.database.query(&query, &[&id, &owner]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let raw = parse(row.get(0)?)?;
        if kind == "code" {
            reads::resource(Kind::Code, &raw)?;
        }
        Ok(Some(context(
            copy(&raw, "project_id"),
            copy(&raw, "active_worker_id"),
            Value::String(row.get::<String>(1)?.into()),
        )))
    }
    async fn chat_context(&self, owner: &str, id: &Value) -> Result<Option<Value>> {
        let id = sql_text(id)?;
        let identities = self
            .database
            .query(
                "SELECT context_kind FROM chats WHERE id=$1 AND owner_id=$2 LIMIT 1",
                &[&id, &owner],
            )
            .await?;
        let standalone = identities
            .first()
            .map(|r| r.get::<String>(0))
            .transpose()?
            .is_some_and(|v| v == "standalone");
        let query = if standalone {
            "SELECT to_jsonb(c)::text,to_jsonb(w)::text,n.state::text,to_jsonb(r)::text FROM chats c LEFT JOIN native_settings_states n ON n.chat_id=c.id INNER JOIN standalone_chat_roots w ON w.id=c.active_scratch_root_id AND w.chat_id=c.id AND w.owner_id=c.owner_id AND w.worker_id=c.active_worker_id LEFT JOIN chat_runtime_sessions r ON r.chat_id=c.id AND r.worker_id=w.worker_id AND r.scratch_root_id=w.id LEFT JOIN chat_execution_lanes l ON l.chat_id=c.id AND l.state='active' LEFT JOIN user_settings u ON u.user_id=c.owner_id WHERE c.id=$1 AND c.owner_id=$2 AND c.context_kind='standalone' AND c.archived_at IS NULL LIMIT 1"
        } else {
            "SELECT to_jsonb(c)::text,to_jsonb(w)::text,n.state::text,to_jsonb(r)::text FROM chats c LEFT JOIN native_settings_states n ON n.chat_id=c.id INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$2 LEFT JOIN user_settings u ON u.user_id=p.owner_id INNER JOIN project_worktrees w ON w.id=c.active_worktree_id LEFT JOIN chat_runtime_sessions r ON r.chat_id=c.id AND r.worker_id=w.worker_id AND r.worktree_id=w.id LEFT JOIN chat_execution_lanes l ON l.chat_id=c.id AND l.state='active' WHERE c.id=$1 AND c.archived_at IS NULL LIMIT 1"
        };
        let rows = self.database.query(query, &[&id, &owner]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let chat = parse(row.get(0)?)?;
        let root = parse(row.get(1)?)?;
        let state = json(row.get(2)?)?;
        let runtime = json(row.get(3)?)?;
        let model = mapped(
            &chat,
            &[
                ("modelId", "model_id"),
                ("reasoningEffort", "reasoning_effort"),
                ("customSubagentModel", "custom_subagent_model"),
                ("subagentModelId", "subagent_model_id"),
                ("subagentReasoningEffort", "subagent_reasoning_effort"),
            ],
        );
        wire::parse("modelConfigurationSchema", Some(&model))
            .map_err(|_| anyhow::anyhow!("Invalid chat model configuration"))?;
        let project = if standalone {
            Value::Null
        } else {
            copy(&chat, "project_id")
        };
        let source = Value::object([
            ("threadId", copy(&runtime, "codex_thread_id")),
            ("workerId", copy(&root, "worker_id")),
            ("placementId", copy(&root, "id")),
            (
                "contextKind",
                Value::String(if standalone { "standalone" } else { "project" }.into()),
            ),
            ("projectId", project.clone()),
            ("modelRouteId", copy(&runtime, "model_route_id")),
            ("providerAccountId", copy(&runtime, "provider_account_id")),
        ]);
        permission_projection(&state, &source)?;
        Ok(Some(context(
            project,
            copy(&root, "worker_id"),
            if standalone {
                Value::Null
            } else {
                copy(&root, "id")
            },
        )))
    }
    pub async fn remote_context(&self, owner: &str, id: &Value) -> Result<Option<Value>> {
        let id = sql_text(id)?;
        let rows=self.database.query("SELECT to_jsonb(r)::text,b.protected_label::text,b.protected_state::text,b.state_revision,v.protected_label::text FROM remote_surfaces r LEFT JOIN browsers b ON b.id=r.id LEFT JOIN project_views v ON v.id=r.id INNER JOIN workers w ON w.id=r.worker_id AND w.owner_id=$2 WHERE r.id=$1 LIMIT 1",&[&id,&owner]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let raw = parse(row.get(0)?)?;
        let title = raw.get("protected_label").filter(|v| !v.is_null()).cloned();
        let browser_title = json(row.get(1)?)?;
        let view_title = json(row.get(4)?)?;
        let title = title.unwrap_or_else(|| {
            if browser_title.is_null() {
                view_title
            } else {
                browser_title
            }
        });
        let browser_state = json(row.get(2)?)?;
        let state = if browser_state.is_null() {
            copy(&raw, "protected_state")
        } else {
            browser_state
        };
        let revision = row
            .get::<Option<i32>>(3)?
            .map_or_else(|| copy(&raw, "state_revision"), |v| Value::Number(v as f64));
        reads::remote(&raw, title, state, revision).map(Some)
    }
    pub async fn browser_owned(&self, owner: &str, id: &Value) -> Result<bool> {
        let id = sql_text(id)?;
        Ok(!self.database.query("SELECT b.id FROM browsers b INNER JOIN projects p ON p.id=b.project_id AND p.owner_id=$2 WHERE b.id=$1 LIMIT 1",&[&id,&owner]).await?.is_empty())
    }
    pub async fn desktop_context(&self, owner: &str, id: &Value) -> Result<Option<Value>> {
        let id = sql_text(id)?;
        self.database.query("SELECT to_jsonb(v)::text,to_jsonb(r)::text FROM project_views v INNER JOIN projects p ON p.id=v.project_id AND p.owner_id=$2 INNER JOIN remote_surfaces r ON r.id=v.id WHERE v.id=$1 AND v.kind='remote-desktop' AND r.kind='desktop' LIMIT 1",&[&id,&owner]).await?.first()
            .map(|row|reads::desktop(&parse(row.get(0)?)?,&parse(row.get(1)?)?)).transpose()
    }
}
fn permission_projection(state: &Value, source: &Value) -> Result<()> {
    let Some(policy) = state
        .get("permissionPolicy")
        .filter(|v| coercion::truthy(Some(v)))
    else {
        return Ok(());
    };
    if source["threadId"].is_null() {
        return Ok(());
    }
    let policy_source = policy
        .get("source")
        .filter(|v| !v.is_null())
        .context("Invalid native permission policy source")?;
    if source
        .as_object()
        .unwrap()
        .iter()
        .any(|(key, value)| policy_source.get(key.as_str().unwrap()) != Some(value))
    {
        return Ok(());
    }
    if let Some(binding) = state.get("binding").filter(|v| coercion::truthy(Some(v)))
        && policy_source.get("runtimeGeneration") == binding.get("runtimeGeneration")
    {
        policy
            .get("settingsVersion")
            .filter(|v| !v.is_null())
            .context("Invalid native permission settings version")?;
    }
    Ok(())
}
