//! Durable resource projections used by execution catalogs and target resolution.
//! Preserve mapper failures even for fields the catalog does not display.
use crate::{
    database::Database,
    wire::{self, Value, coercion},
};
use anyhow::{Context, Result};
use std::sync::Arc;

pub(super) fn copy(v: &Value, key: &str) -> Value {
    v.get(key).cloned().unwrap_or(Value::Null)
}
pub(super) fn mapped(v: &Value, fields: &[(&str, &str)]) -> Value {
    Value::object(fields.iter().map(|(to, from)| (*to, copy(v, from))))
}
fn date(v: &Value, key: &str) -> Result<Value> {
    let time = v[key]
        .as_js_string()
        .and_then(wire::date_milliseconds)
        .context("Invalid stored resource date")?;
    Ok(Value::String(
        wire::date_iso_milliseconds(time)
            .context("Invalid stored resource date")?
            .into(),
    ))
}
fn dates(result: &mut Value, raw: &Value) -> Result<()> {
    result["createdAt"] = date(raw, "created_at")?;
    result["updatedAt"] = date(raw, "updated_at")?;
    Ok(())
}
pub(super) fn parse(raw: String) -> Result<Value> {
    Ok(serde_json::from_str(&raw)?)
}
pub(super) fn json(raw: Option<String>) -> Result<Value> {
    raw.map(parse).transpose().map(|v| v.unwrap_or(Value::Null))
}
fn nullish(a: Value, b: Value) -> Value {
    if a.is_null() { b } else { a }
}
pub(super) fn sql_text(id: &Value) -> Result<String> {
    // postgres-js binds JS strings using UTF-8 replacement. In-memory target
    // selection must keep UTF-16 keys instead; placement.rs handles that seam.
    Ok(String::from_utf16_lossy(
        id.as_js_string().context("Resource identity")?.units(),
    ))
}
pub(super) struct Reads {
    pub database: Arc<Database>,
}
#[derive(Clone, Copy)]
pub(super) enum Kind {
    Chat,
    Terminal,
    Explorer,
    Code,
    Browser,
}
impl Reads {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn workers(&self, owner: &str) -> Result<Vec<Value>> {
        self.database.query("SELECT to_jsonb(w)::text FROM workers w WHERE owner_id=$1 AND unlinked_at IS NULL ORDER BY name ASC",&[&owner]).await?.iter()
            .map(|row|worker(&parse(row.get(0)?)?)).collect()
    }
    pub async fn worker(&self, owner: &str, id: &Value) -> Result<Option<Value>> {
        let id = sql_text(id)?;
        self.database.query("SELECT to_jsonb(w)::text FROM workers w WHERE id=$1 AND owner_id=$2 AND unlinked_at IS NULL LIMIT 1",&[&id,&owner]).await?.first()
            .map(|row|worker(&parse(row.get(0)?)?)).transpose()
    }
    pub async fn worktrees(&self, owner: &str, project: &str) -> Result<Vec<Value>> {
        self.database.query("SELECT to_jsonb(w)::text FROM project_worktrees w INNER JOIN project_sources s ON s.id=w.project_source_id INNER JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 WHERE p.id=$2 AND s.removed_at IS NULL ORDER BY w.is_primary DESC,w.name ASC",&[&owner,&project]).await?.iter()
            .map(|row|worktree(&parse(row.get(0)?)?, project)).collect()
    }
    pub async fn primary(&self, owner: &str, project: &str, id: &Value) -> Result<Option<Value>> {
        let id = sql_text(id)?;
        self.database.query("SELECT to_jsonb(w)::text FROM project_worktrees w INNER JOIN project_sources s ON s.id=w.project_source_id INNER JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 WHERE p.id=$2 AND w.id=$3 AND s.removed_at IS NULL AND w.lifecycle_state='ready' LIMIT 1",&[&owner,&project,&id]).await?.first()
            .map(|row|worktree(&parse(row.get(0)?)?, project)).transpose()
    }
    pub async fn resources(&self, kind: Kind, owner: &str, project: &str) -> Result<Vec<Value>> {
        let (table, extra, join, columns) = match kind {
            Kind::Chat => (
                "chats",
                " AND r.archived_at IS NULL",
                "",
                "to_jsonb(r)::text",
            ),
            Kind::Terminal => ("terminals", "", "", "to_jsonb(r)::text"),
            Kind::Explorer => ("explorers", "", "", "to_jsonb(r)::text"),
            Kind::Code => ("code_tabs", "", "", "to_jsonb(r)::text"),
            Kind::Browser => (
                "browsers",
                "",
                " LEFT JOIN remote_surfaces s ON s.id=r.id",
                "to_jsonb(r)::text,s.worker_id",
            ),
        };
        let query = format!(
            "SELECT {columns} FROM {table} r INNER JOIN projects p ON p.id=r.project_id AND p.owner_id=$1{join} WHERE r.project_id=$2{extra} ORDER BY r.position ASC,r.created_at ASC"
        );
        self.database
            .query(&query, &[&owner, &project])
            .await?
            .iter()
            .map(|row| {
                let raw = parse(row.get(0)?)?;
                let mut result = resource(kind, &raw)?;
                if matches!(kind, Kind::Browser) {
                    result["workerId"] = row
                        .get::<Option<String>>(1)?
                        .map_or(Value::Null, |v| Value::String(v.into()));
                }
                Ok(result)
            })
            .collect()
    }
    pub async fn remotes(&self, owner: &str, project: &str) -> Result<Vec<Value>> {
        self.database.query("SELECT to_jsonb(r)::text,b.protected_label::text,b.protected_state::text,b.state_revision,v.protected_label::text FROM remote_surfaces r INNER JOIN projects p ON p.id=r.project_id AND p.owner_id=$1 LEFT JOIN browsers b ON b.id=r.id LEFT JOIN project_views v ON v.id=r.id WHERE r.project_id=$2 ORDER BY r.created_at ASC,r.id ASC",&[&owner,&project]).await?.iter().map(|row| {
            let raw=parse(row.get(0)?)?;
            let title=nullish(nullish(copy(&raw,"protected_label"),json(row.get(1)?)?),json(row.get(4)?)?);
            let state=nullish(json(row.get(2)?)?,copy(&raw,"protected_state"));
            let revision=row.get::<Option<i32>>(3)?.map_or_else(||copy(&raw,"state_revision"),|v|Value::Number(v as f64));
            remote(&raw,title,state,revision)
        }).collect()
    }
    pub async fn desktops(&self, owner: &str, project: &str) -> Result<Vec<Value>> {
        self.database.query("SELECT to_jsonb(v)::text,to_jsonb(r)::text FROM project_views v INNER JOIN projects p ON p.id=v.project_id AND p.owner_id=$1 INNER JOIN remote_surfaces r ON r.id=v.id WHERE v.project_id=$2 AND v.kind='remote-desktop' AND r.kind='desktop' ORDER BY v.position ASC,v.created_at ASC",&[&owner,&project]).await?.iter()
            .map(|row|desktop(&parse(row.get(0)?)?,&parse(row.get(1)?)?)).collect()
    }
}
fn worker(raw: &Value) -> Result<Value> {
    let mut result = mapped(
        raw,
        &[
            ("workerId", "id"),
            ("name", "name"),
            ("platform", "platform"),
            ("architecture", "architecture"),
            ("codexVersion", "codex_version"),
            ("codexRuntime", "codex_runtime"),
            ("remoteSurfaces", "remote_surface_capabilities"),
            ("directBroker", "direct_broker_advertisement"),
            ("codegraph", "codegraph_status"),
            ("webRuntimes", "web_runtime_capabilities"),
            ("encryption", "encryption_status"),
            ("projectReplicas", "project_replica_capabilities"),
            ("managedFolders", "managed_folder_capabilities"),
            ("standaloneChat", "standalone_chat_capabilities"),
            ("chatRelocation", "chat_relocation_capability"),
            ("externalCodexHistory", "external_codex_history_capability"),
        ],
    );
    result["name"] = nullish(copy(raw, "display_name"), copy(raw, "name"));
    result["startedAt"] = date(raw, "started_at")?;
    result["lastSeenAt"] = date(raw, "last_seen_at")?;
    let seen = raw["last_seen_at"]
        .as_js_string()
        .and_then(wire::date_milliseconds)
        .context("Worker presence date")?;
    result["online"] = Value::Bool(chrono::Utc::now().timestamp_millis() - seen <= 30000);
    Ok(result)
}
pub(crate) fn worktree(raw: &Value, project: &str) -> Result<Value> {
    let mut result = mapped(
        raw,
        &[
            ("id", "id"),
            ("projectSourceId", "project_source_id"),
            ("rootKind", "root_kind"),
            ("workerId", "worker_id"),
            ("name", "name"),
            ("path", "absolute_path"),
            ("displayPath", "display_path"),
            ("isPrimary", "is_primary"),
            ("isDefault", "is_default"),
            ("origin", "origin"),
            ("lifecycleState", "lifecycle_state"),
            ("branch", "branch"),
            ("head", "head"),
            ("detached", "detached"),
            ("locked", "locked"),
            ("lockReason", "lock_reason"),
        ],
    );
    result["projectId"] = Value::String(project.into());
    result["lastScannedAt"] = if raw["last_scanned_at"].is_null() {
        Value::Null
    } else {
        date(raw, "last_scanned_at")?
    };
    dates(&mut result, raw)?;
    Ok(result)
}
pub(super) fn resource(kind: Kind, raw: &Value) -> Result<Value> {
    let mut result = mapped(
        raw,
        &[
            ("id", "id"),
            ("projectId", "project_id"),
            ("titleProtection", "protected_label"),
            ("position", "position"),
        ],
    );
    let fields: &[(&str, &str)] = match kind {
        Kind::Chat => &[
            ("contextKind", "context_kind"),
            ("experience", "experience"),
            ("status", "status"),
            ("activeWorkerId", "active_worker_id"),
            ("activeWorktreeId", "active_worktree_id"),
            ("activeScratchRootId", "active_scratch_root_id"),
            ("placementRevision", "placement_revision"),
            ("worktreeMode", "worktree_mode"),
            ("modelId", "model_id"),
            ("reasoningEffort", "reasoning_effort"),
            ("customSubagentModel", "custom_subagent_model"),
            ("subagentModelId", "subagent_model_id"),
            ("subagentReasoningEffort", "subagent_reasoning_effort"),
            ("permissionProfileId", "permission_profile_id"),
            ("planMode", "plan_mode"),
            ("hasPendingPlanQuestion", "has_pending_plan_question"),
            ("hasUnreadCompletion", "has_unread_completion"),
            ("automationPaused", "automation_paused"),
        ],
        Kind::Terminal => &[
            ("kind", "kind"),
            ("status", "status"),
            ("activeWorkerId", "active_worker_id"),
            ("worktreeId", "worktree_id"),
            ("linkedChatId", "linked_chat_id"),
            ("runConfigurationId", "run_configuration_id"),
            ("runConfigurationRuntimeId", "run_configuration_runtime_id"),
            ("serviceEnabled", "service_enabled"),
            ("stateProtection", "protected_state"),
        ],
        Kind::Explorer => &[
            ("activeWorkerId", "active_worker_id"),
            ("worktreeId", "worktree_id"),
            ("stateProtection", "protected_state"),
            ("fileMode", "file_mode"),
        ],
        Kind::Code => &[
            ("activeWorkerId", "active_worker_id"),
            ("worktreeId", "worktree_id"),
        ],
        Kind::Browser => &[
            ("stateProtection", "protected_state"),
            ("stateRevision", "state_revision"),
        ],
    };
    for (key, value) in mapped(raw, fields).as_object().unwrap() {
        result[key.as_str().unwrap()] = value.clone();
    }
    if matches!(kind, Kind::Chat) {
        result["githubAgentContext"] = if [
            "github_item_kind",
            "github_item_number",
            "github_agent_intent",
            "github_head_sha",
        ]
        .iter()
        .all(|key| coercion::truthy(raw.get(key)))
        {
            mapped(
                raw,
                &[
                    ("kind", "github_item_kind"),
                    ("number", "github_item_number"),
                    ("intent", "github_agent_intent"),
                    ("headSha", "github_head_sha"),
                ],
            )
        } else {
            Value::Null
        };
    }
    dates(&mut result, raw)?;
    if matches!(kind, Kind::Chat) {
        return wire::parse("chatWireSummarySchema", Some(&result))
            .map_err(|_| anyhow::anyhow!("Invalid stored chat wire summary"));
    }
    Ok(result)
}
pub(super) fn remote(raw: &Value, title: Value, state: Value, revision: Value) -> Result<Value> {
    anyhow::ensure!(
        coercion::truthy(Some(&title)),
        "Remote Surface is missing its canonical protected label."
    );
    anyhow::ensure!(
        coercion::truthy(Some(&state)) && coercion::truthy(Some(&revision)),
        "Remote Surface is missing its canonical protected state."
    );
    let mut result = mapped(
        raw,
        &[
            ("id", "id"),
            ("projectId", "project_id"),
            ("workerId", "worker_id"),
            ("kind", "kind"),
            ("status", "status"),
            ("preferredTransport", "preferred_transport"),
            ("configuration", "configuration"),
            ("lastError", "last_error"),
        ],
    );
    result["titleProtection"] = title;
    result["stateProtection"] = state;
    result["stateRevision"] = revision;
    result["lastConnectedAt"] = if raw["last_connected_at"].is_null() {
        Value::Null
    } else {
        date(raw, "last_connected_at")?
    };
    dates(&mut result, raw)?;
    Ok(result)
}
pub(super) fn desktop(view: &Value, raw: &Value) -> Result<Value> {
    anyhow::ensure!(
        raw["configuration"]["kind"] == "desktop",
        "Remote Desktop is not backed by a desktop surface."
    );
    anyhow::ensure!(
        coercion::truthy(raw.get("protected_state")) && coercion::truthy(raw.get("state_revision")),
        "Remote Desktop is missing its protected target state."
    );
    let mut result = mapped(
        view,
        &[
            ("id", "id"),
            ("projectId", "project_id"),
            ("titleProtection", "protected_label"),
            ("position", "position"),
        ],
    );
    for (key, value) in mapped(
        raw,
        &[
            ("workerId", "worker_id"),
            ("stateProtection", "protected_state"),
            ("stateRevision", "state_revision"),
            ("status", "status"),
            ("lastError", "last_error"),
        ],
    )
    .as_object()
    .unwrap()
    {
        result[key.as_str().unwrap()] = value.clone();
    }
    result["createdAt"] = date(view, "created_at")?;
    let view_time = view["updated_at"]
        .as_js_string()
        .and_then(wire::date_milliseconds);
    let surface_time = raw["updated_at"]
        .as_js_string()
        .and_then(wire::date_milliseconds);
    result["updatedAt"] = if view_time.zip(surface_time).is_some_and(|(v, s)| v > s) {
        date(view, "updated_at")?
    } else {
        date(raw, "updated_at")?
    };
    Ok(result)
}
