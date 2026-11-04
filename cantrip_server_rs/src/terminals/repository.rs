use crate::{
    database::{Database, query_error},
    projects::{
        placement::{Connected, PlacementRepository},
        targets::{TargetRepository, terminal_summary},
    },
    wire::Value,
};
use anyhow::{Context, Result, bail};
use std::sync::{Arc, OnceLock};

#[derive(serde::Deserialize)]
struct Queries {
    context: String,
    update: String,
    service: String,
    worktree_select: String,
    worktree_update: String,
    delete: String,
    runtime_clear: String,
    runtime_active: String,
}
fn queries() -> &'static Queries {
    static QUERIES: OnceLock<Queries> = OnceLock::new();
    QUERIES.get_or_init(|| {
        serde_json::from_str(include_str!("queries.json")).expect("embedded terminal queries")
    })
}
#[derive(Clone)]
pub struct Repository {
    pub(super) database: Arc<Database>,
}
impl Repository {
    pub async fn delete(&self, owner: &str, terminal: &str) -> Result<Option<Value>> {
        // Removal authorizes the durable resource even when its OS capture is
        // stale. This metadata-only projection is never used to execute work.
        let captured=self.database.query("SELECT t.id,t.project_id,t.active_worker_id,t.kind FROM terminals t JOIN projects p ON p.id=t.project_id AND p.owner_id=$1 WHERE t.id=$2 AND t.cantrip_os_binding_id IS NOT NULL LIMIT 1",&[&owner,&terminal]).await?;
        let context = if let Some(row) = captured.first() {
            Some(Value::object([
                ("terminalId", Value::String(row.get::<String>(0)?.into())),
                ("projectId", Value::String(row.get::<String>(1)?.into())),
                ("workerId", Value::String(row.get::<String>(2)?.into())),
                ("kind", Value::String(row.get::<String>(3)?.into())),
            ]))
        } else {
            self.context(owner, terminal).await?
        };
        let Some(context) = context else {
            return Ok(None);
        };
        if context["kind"]=="run-configuration" && !query_error::context(self.database.query("SELECT state FROM run_configuration_runtimes WHERE owner_id=$1 AND terminal_id=$2 AND state IN ('starting','running','restarting','stopping') LIMIT 1",&[&owner,&terminal]).await,&queries().runtime_active,&[Value::String(owner.into()),Value::String(terminal.into()),Value::Number(1.0)])?.is_empty() {
            bail!("Stop the active Run configuration before closing its terminal.");
        }
        let owner = owner.to_owned();
        let terminal = terminal.to_owned();
        let project = context["projectId"]
            .as_str()
            .context("Terminal project")?
            .to_owned();
        self.database.transaction(|tx|Box::pin(async move {
            crate::workspaces::remove_resource(tx,&owner,&project,"project.terminal",&terminal).await?;
            let at=crate::auth::now();
            query_error::context(tx.query("UPDATE run_configuration_runtimes SET terminal_id=NULL,updated_at=$1 WHERE owner_id=$2 AND terminal_id=$3",&[&at,&owner,&terminal]).await,&queries().runtime_clear,&[Value::Null,Value::String(crate::auth::iso(at).into()),Value::String(owner.clone().into()),Value::String(terminal.clone().into())])?;
            super::layout::detach_terminal(tx,&project,&terminal).await?;
            query_error::context(tx.query("DELETE FROM terminals WHERE id=$1",&[&terminal]).await,&queries().delete,&[Value::String(terminal.into())])?;
            Ok(())
        })).await?;
        Ok(Some(context))
    }
    pub async fn update_worktree(
        &self,
        owner: &str,
        terminal: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        // The reference authorizes the terminal without joining its old worktree.
        // Keep this separate from context(), including its validation order.
        let rows = query_error::context(self.database.query(
            "SELECT to_jsonb(t)::text FROM terminals t INNER JOIN projects p ON p.id=t.project_id AND p.owner_id=$1 WHERE t.id=$2 LIMIT 1",
            &[&owner, &terminal]).await, &queries().worktree_select,
            &[Value::String(owner.into()), Value::String(terminal.into()), Value::Number(1.0)])?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let raw: Value = serde_json::from_str(&row.get::<String>(0)?)?;
        if raw["kind"] == "run-configuration" {
            bail!("Run configuration terminals cannot change worktrees.");
        }
        if crate::wire::coercion::truthy(raw.get("linked_chat_id")) {
            bail!("Linked Codex consoles inherit their parent chat worktree.");
        }
        if raw["status"] == "running" {
            bail!("Stop the terminal before changing its worktree.");
        }
        let project = raw["project_id"].as_str().context("Terminal project")?;
        let Some(target) = TargetRepository::new(self.database.clone())
            .ready_worktree(owner, project, &input["worktreeId"])
            .await?
        else {
            return Ok(None);
        };
        let worker = target["workerId"].as_str().context("Target worker")?;
        let tree = target["id"].as_str().context("Target worktree")?;
        let at = crate::auth::now();
        let rows = query_error::context(self.database.query(
            "UPDATE terminals SET active_worker_id=$1,worktree_id=$2,updated_at=$3 WHERE id=$4 RETURNING to_jsonb(terminals)::text",
            &[&worker, &tree, &at, &terminal]).await, &queries().worktree_update,
            &[Value::String(worker.into()), Value::String(tree.into()), Value::String(crate::auth::iso(at).into()), Value::String(terminal.into())])?;
        rows.first()
            .map(|row| terminal_summary(&serde_json::from_str::<Value>(&row.get::<String>(0)?)?))
            .transpose()
    }
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn list(&self, owner: &str, project: &str) -> Result<Vec<Value>> {
        TargetRepository::new(self.database.clone())
            .terminals(owner, project)
            .await
    }
    pub async fn context(&self, owner: &str, terminal: &str) -> Result<Option<Value>> {
        let rows=query_error::context(self.database.query(
            "SELECT to_jsonb(t)::text,to_jsonb(w)::text FROM terminals t INNER JOIN projects p ON p.id=t.project_id AND p.owner_id=$1 INNER JOIN project_worktrees w ON w.id=t.worktree_id WHERE t.id=$2 LIMIT 1",&[&owner,&terminal]).await,
            &queries().context,&[Value::String(owner.into()),Value::String(terminal.into()),Value::Number(1.0)])?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let t: Value = serde_json::from_str(&row.get::<String>(0)?)?;
        let w: Value = serde_json::from_str(&row.get::<String>(1)?)?;
        let captured = serde_json::json!({"binding_id":t["cantrip_os_binding_id"].as_str(),"binding_generation":t["os_binding_generation"].as_str(),"attachment_generation":t["os_attachment_generation"].as_str(),"runtime_generation":t["os_runtime_generation"].as_str()});
        let root = crate::cantrip_os::files::root(
            crate::database::Executor::Database(&self.database),
            owner,
            t["project_id"].as_str().context("Terminal project")?,
            w["id"].as_str().context("Terminal worktree")?,
            w["worker_id"].as_str().context("Terminal worker")?,
            &captured,
        )
        .await?;
        let result = Value::object([
            ("terminalId", t["id"].clone()),
            ("projectId", t["project_id"].clone()),
            ("kind", t["kind"].clone()),
            ("rootKind", w["root_kind"].clone()),
            ("workerId", t["active_worker_id"].clone()),
            ("worktreeId", w["id"].clone()),
            ("worktreePath", root),
            ("linkedChatId", t["linked_chat_id"].clone()),
            ("runConfigurationId", t["run_configuration_id"].clone()),
            (
                "runConfigurationRuntimeId",
                t["run_configuration_runtime_id"].clone(),
            ),
            ("serviceEnabled", t["service_enabled"].clone()),
            ("stateProtection", t["protected_state"].clone()),
            ("status", t["status"].clone()),
        ]);
        Ok(Some(result))
    }
    pub async fn update(
        &self,
        owner: &str,
        terminal: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let Some(context) = self.context(owner, terminal).await? else {
            return Ok(None);
        };
        if context["kind"] == "run-configuration" {
            bail!("Run configuration terminal titles come from their shared definition.")
        }
        let title = input["titleProtection"].stringify();
        let at = crate::auth::now();
        let rows=query_error::context(self.database.query(
            "UPDATE terminals SET protected_label=$1::text::jsonb,updated_at=$2 WHERE id=$3 RETURNING to_jsonb(terminals)::text",&[&title,&at,&terminal]).await,
            &queries().update,&[Value::String(title.into()),Value::String(crate::auth::iso(at).into()),Value::String(terminal.into())])?;
        rows.first()
            .map(|row| terminal_summary(&serde_json::from_str::<Value>(&row.get::<String>(0)?)?))
            .transpose()
    }
    pub async fn configure_service(
        &self,
        owner: &str,
        terminal: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let Some(context) = self.context(owner, terminal).await? else {
            return Ok(None);
        };
        if context["kind"] == "run-configuration" {
            bail!("Run configuration terminals are controlled by their runtime.")
        }
        if context["worktreePath"].is_object() && input["enabled"] == true {
            bail!("Linux terminal services require their delegated service lifecycle.");
        }
        if crate::wire::coercion::truthy(context.get("linkedChatId")) {
            bail!("Linked Codex consoles cannot run terminal services.")
        }
        let state = input["stateProtection"].stringify();
        let enabled = input["enabled"].as_bool().context("Terminal enabled")?;
        let at = crate::auth::now();
        let rows=query_error::context(self.database.query(
            "UPDATE terminals SET protected_state=$1::text::jsonb,service_enabled=$2,updated_at=$3 WHERE id=$4 RETURNING to_jsonb(terminals)::text",&[&state,&enabled,&at,&terminal]).await,
            &queries().service,&[Value::String(state.into()),Value::Bool(enabled),Value::String(crate::auth::iso(at).into()),Value::String(terminal.into())])?;
        rows.first()
            .map(|row| terminal_summary(&serde_json::from_str::<Value>(&row.get::<String>(0)?)?))
            .transpose()
    }
    pub async fn create(
        &self,
        owner: &str,
        project: &str,
        input: &Value,
        connected: Connected<'_>,
    ) -> Result<Option<Value>> {
        let fallback = input
            .get("worktreeId")
            .filter(|v| crate::wire::coercion::truthy(Some(v)))
            .map(|id| {
                Value::object([
                    ("kind", Value::String("worktree".into())),
                    ("projectId", Value::String(project.into())),
                    ("worktreeId", id.clone()),
                ])
            });
        let target = input
            .get("target")
            .filter(|v| !v.is_null())
            .or(fallback.as_ref());
        let placement = if let Some(binding) = input["cantripOsBindingId"].as_str() {
            let selected = crate::cantrip_os::chats::select(
                crate::database::Executor::Database(&self.database),
                owner,
                project,
                binding,
            )
            .await?;
            let worktree = Value::from_serialize(&selected["selected"]["worktree"]["id"]);
            anyhow::ensure!(
                input["target"].is_null()
                    && (input["worktreeId"].is_null() || input["worktreeId"] == worktree),
                "OS terminal source and worktree selection differ."
            );
            Value::object([(
                "placement",
                Value::object([
                    (
                        "workerId",
                        Value::from_serialize(&selected["selected"]["workerId"]),
                    ),
                    ("worktreeId", worktree),
                ]),
            )])
        } else {
            PlacementRepository::new(self.database.clone())?
                .resolve(owner, project, "terminal", target, connected, false)
                .await?
        };
        let placement = &placement["placement"];
        let worker = placement["workerId"]
            .as_str()
            .context("Terminal worker")?
            .to_owned();
        let tree = placement["worktreeId"]
            .as_str()
            .context("Terminal worktree")?
            .to_owned();
        let position = super::layout::next_position(&self.database, project).await?;
        let id = input["id"]
            .as_str()
            .context("Terminal identity")?
            .to_owned();
        let label = input["titleProtection"].stringify();
        let state = input["stateProtection"].stringify();
        let owner = owner.to_owned();
        let project = project.to_owned();
        let input = input.clone();
        self.database.transaction(|tx|Box::pin(async move{
            let captured = if let Some(binding) = input["cantripOsBindingId"].as_str() {
                crate::cantrip_os::files::capture(crate::database::Executor::Transaction(tx),&owner,&project,&tree,binding,input["cantripOsRuntimeGeneration"].as_str().unwrap_or("")).await?
            } else { serde_json::Value::Null };
            let binding=captured["binding_id"].as_str();let binding_generation=captured["binding_generation"].as_str();let attachment_generation=captured["attachment_generation"].as_str();let runtime_generation=captured["runtime_generation"].as_str();
            let rows=tx.query("INSERT INTO terminals (id,project_id,protected_label,protected_state,position,active_worker_id,worktree_id,cantrip_os_binding_id,os_binding_generation,os_attachment_generation,os_runtime_generation) VALUES ($1,$2,$3::text::jsonb,$4::text::jsonb,$5::bigint::integer,$6,$7,$8,$9,$10,$11) RETURNING to_jsonb(terminals)::text",
                &[&id,&project,&label,&state,&position,&worker,&tree,&binding,&binding_generation,&attachment_generation,&runtime_generation]).await?;
            let raw:Value=serde_json::from_str(&rows.first().context("Database returned no row after creating a terminal.")?.get::<String>(0)?)?;
            super::layout::attach_terminal(tx,&project,&id,&input).await?;
            Ok(Some(terminal_summary(&raw)?))
        })).await
    }
}
