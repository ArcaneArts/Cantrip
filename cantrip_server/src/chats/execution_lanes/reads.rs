use super::{LaneRepository, iso, raw, text};
use crate::{
    database::Executor,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Result, bail};

pub(super) fn summary(row: &Value, contextual: bool) -> Result<Value> {
    let project = truthy(row.get("worktree_id"));
    if !project && !contextual {
        bail!("Standalone execution lanes are unavailable until standalone execution is enabled.");
    }
    if !project && !truthy(row.get("scratch_root_id")) {
        bail!("Execution lane has no execution root.");
    }
    let mut result = Value::object([] as [(&str, Value); 0]);
    for (field, column) in [
        ("id", "id"),
        ("chatId", "chat_id"),
        ("workerId", "worker_id"),
        ("acquiringActor", "acquiring_actor"),
        ("exclusive", "exclusive"),
        ("purpose", "purpose"),
        ("state", "state"),
        ("baseRevision", "base_revision"),
        ("startingHead", "starting_head"),
        ("runtimeSessionId", "runtime_session_id"),
        ("codexThreadId", "codex_thread_id"),
        ("transitionKind", "transition_kind"),
    ] {
        result[field] = row[column].clone();
    }
    for (field, column) in [
        ("createdAt", "created_at"),
        ("activatedAt", "activated_at"),
        ("releasedAt", "released_at"),
        ("updatedAt", "updated_at"),
    ] {
        result[field] = if row[column].is_null() {
            Value::Null
        } else {
            iso(&row[column])?
        };
    }
    result["contextKind"] = json!(if project { "project" } else { "standalone" });
    result["worktreeId"] = if project {
        row["worktree_id"].clone()
    } else {
        Value::Null
    };
    result["scratchRootId"] = if project {
        Value::Null
    } else {
        row["scratch_root_id"].clone()
    };
    Ok(result)
}
pub(super) async fn context(
    ex: Executor<'_, '_>,
    owner: &str,
    chat: &str,
    lane: &str,
) -> Result<Option<Value>> {
    let rows=ex.query("SELECT jsonb_build_object('chat',to_jsonb(c),'lane',to_jsonb(l),'sourcePath',s.absolute_path,'worktree',to_jsonb(w))::text FROM chat_execution_lanes l INNER JOIN chats c ON c.id=l.chat_id INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 INNER JOIN project_worktrees w ON w.id=l.worktree_id INNER JOIN project_sources s ON s.id=w.project_source_id WHERE l.id=$2 AND l.chat_id=$3 LIMIT 1",&[&owner,&lane,&chat]).await?;
    rows.first().map(|r|{let r=raw(r)?;let project=text(&r["chat"]["project_id"])?;if project.is_empty(){bail!("Project Chat operation received a standalone Chat.");}Ok(json!({"chat":super::super::summary::wire_summary(&r["chat"])?,"lane":summary(&r["lane"],false)?,"sourcePath":r["sourcePath"],"worktree":crate::projects::targets::worktree_summary(&r["worktree"],&project)?}))}).transpose()
}
impl LaneRepository {
    pub async fn list_chat(&self, owner: &str, chat: &str) -> Result<Vec<Value>> {
        self.database.query("SELECT to_jsonb(l)::text FROM chat_execution_lanes l INNER JOIN chats c ON c.id=l.chat_id INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE l.chat_id=$2 ORDER BY l.created_at DESC",&[&owner,&chat]).await?.iter().map(|r|summary(&raw(r)?,false)).collect()
    }
    pub async fn list_project(
        &self,
        owner: &str,
        project: &str,
        include_history: bool,
    ) -> Result<Vec<Value>> {
        self.database.query("SELECT to_jsonb(l)::text FROM chat_execution_lanes l INNER JOIN chats c ON c.id=l.chat_id INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE c.project_id=$2 AND ($3 OR l.state<>'released') ORDER BY l.updated_at DESC",&[&owner,&project,&include_history]).await?.iter().map(|r|summary(&raw(r)?,false)).collect()
    }
    pub async fn lane_context(&self, owner: &str, chat: &str, lane: &str) -> Result<Option<Value>> {
        context(Executor::Database(&self.database), owner, chat, lane).await
    }
    pub async fn recovery_context(
        &self,
        owner: &str,
        chat: &str,
        lane: &str,
    ) -> Result<Option<Value>> {
        if let Some(project) = self.lane_context(owner, chat, lane).await? {
            return Ok(Some(project));
        }
        let rows=self.database.query("SELECT jsonb_build_object('chat',to_jsonb(c),'lane',to_jsonb(l),'root',to_jsonb(r))::text FROM chat_execution_lanes l INNER JOIN chats c ON c.id=l.chat_id INNER JOIN standalone_chat_roots r ON r.id=l.scratch_root_id WHERE l.id=$1 AND l.chat_id=$2 AND c.owner_id=$3 AND c.context_kind='standalone' LIMIT 1",&[&lane,&chat,&owner]).await?;
        let Some(row) = rows.first().map(raw).transpose()? else {
            return Ok(None);
        };
        if !truthy(row["root"].get("protected_path_handle")) {
            return Ok(None);
        }
        let lane = summary(&row["lane"], true)?;
        if lane["contextKind"] != "standalone" {
            return Ok(None);
        }
        Ok(Some(
            json!({"chat":super::super::summary::wire_summary(&row["chat"])?,"lane":lane,"root":json!({"id":row["root"]["id"],"pathHandle":row["root"]["protected_path_handle"],"workerId":row["root"]["worker_id"]})}),
        ))
    }
    pub async fn pending_transition(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        let rows=self.database.query("SELECT l.id FROM chat_execution_lanes l INNER JOIN chats c ON c.id=l.chat_id INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE l.chat_id=$2 AND l.state='delivering' LIMIT 1",&[&owner,&chat]).await?;
        match rows.first() {
            Some(row) => self.lane_context(owner, chat, &row.get::<String>(0)?).await,
            None => Ok(None),
        }
    }
    pub async fn pending_transition_chat_ids(
        &self,
        owner: &str,
        worker: &str,
    ) -> Result<Vec<String>> {
        self.database.query("SELECT l.chat_id FROM chat_execution_lanes l INNER JOIN chats c ON c.id=l.chat_id INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 WHERE l.worker_id=$2 AND l.state='delivering'",&[&owner,&worker]).await?.iter().map(|r|r.get::<String>(0)).collect()
    }
}
