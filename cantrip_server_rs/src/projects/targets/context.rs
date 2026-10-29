use super::reads::{self, Kind, Reads, copy, json, parse, sql_text};
use crate::wire::Value;
use anyhow::Result;

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
        let repository = crate::chats::Repository::new(self.database.clone());
        Ok(repository.execution_context(owner, &id).await?.map(|chat| {
            context(
                chat["projectId"].clone(),
                chat["workerId"].clone(),
                chat["worktreeId"].clone(),
            )
        }))
    }
    pub async fn remote_context(&self, owner: &str, id: &Value) -> Result<Option<Value>> {
        Ok(self
            .remote_execution_context(owner, id)
            .await?
            .map(|context| context["surface"].clone()))
    }
    pub async fn remote_execution_context(&self, owner: &str, id: &Value) -> Result<Option<Value>> {
        let id = sql_text(id)?;
        let rows=self.database.query("SELECT to_jsonb(r)::text,b.protected_label::text,b.protected_state::text,b.state_revision,v.protected_label::text,w.remote_surface_capabilities::text FROM remote_surfaces r INNER JOIN projects p ON p.id=r.project_id AND p.owner_id=$2 LEFT JOIN browsers b ON b.id=r.id LEFT JOIN project_views v ON v.id=r.id INNER JOIN workers w ON w.id=r.worker_id AND w.owner_id=$2 WHERE r.id=$1 LIMIT 1",&[&id,&owner]).await?;
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
        let surface = reads::remote(&raw, title, state, revision)?;
        Ok(Some(Value::object([
            ("remoteSurfaceCapabilities", parse(row.get(5)?)?),
            ("workerId", raw["worker_id"].clone()),
            ("surface", surface),
        ])))
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
