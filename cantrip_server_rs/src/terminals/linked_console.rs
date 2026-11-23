use super::Repository;
use crate::{projects::targets::terminal_summary, wire::Value};
use anyhow::{Context, Result, bail};

impl Repository {
    /// Separate lookup/insert/read-winner statements preserve the Source race.
    /// The unique linked-chat index chooses the durable console identity.
    pub async fn get_or_create_chat_console(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let rows=self.database.query("SELECT c.project_id,c.active_worktree_id,c.position,w.worker_id,c.cantrip_os_binding_id FROM chats c INNER JOIN projects p ON p.id=c.project_id AND p.owner_id=$1 INNER JOIN project_worktrees w ON w.id=c.active_worktree_id WHERE c.id=$2 AND c.archived_at IS NULL LIMIT 1", &[&owner,&chat]).await?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        let project = row
            .get::<Option<String>>(0)?
            .context("A project Chat requires a project.")?;
        let worktree = row
            .get::<Option<String>>(1)?
            .context("A project Chat requires a worktree.")?;
        let position = row.get::<i32>(2)?;
        let worker = row.get::<String>(3)?;
        let os_binding = row.get::<Option<String>>(4)?;
        let existing = self
            .database
            .query(
                "SELECT to_jsonb(t)::text FROM terminals t WHERE linked_chat_id=$1 LIMIT 1",
                &[&chat],
            )
            .await?;
        if let Some(row) = existing.first() {
            return terminal_summary(&serde_json::from_str(&row.get::<String>(0)?)?).map(Some);
        }
        let (id, title, state) = (
            input["id"].as_str().context("Console id")?,
            input["titleProtection"].stringify(),
            input["stateProtection"].stringify(),
        );
        let captured = self.database.query("SELECT binding_id,binding_generation,attachment_generation,runtime_generation FROM cantrip_os_chat_placements WHERE chat_id=$1", &[&chat]).await?;
        let captured = captured.first();
        if os_binding.is_some() && captured.is_none() {
            bail!("The OS chat placement is unavailable.");
        }
        let binding = captured.map(|row| row.get::<String>(0)).transpose()?;
        let binding_generation = captured.map(|row| row.get::<String>(1)).transpose()?;
        let attachment_generation = captured.map(|row| row.get::<String>(2)).transpose()?;
        let runtime_generation = captured.map(|row| row.get::<String>(3)).transpose()?;
        let created=self.database.query("INSERT INTO terminals(id,project_id,protected_label,protected_state,position,status,active_worker_id,worktree_id,linked_chat_id,kind,cantrip_os_binding_id,os_binding_generation,os_attachment_generation,os_runtime_generation) VALUES($1,$2,$3::text::jsonb,$4::text::jsonb,$5,'running',$6,$7,$8,'chat-console',$9,$10,$11,$12) ON CONFLICT(linked_chat_id) DO NOTHING RETURNING to_jsonb(terminals)::text", &[&id,&project,&title,&state,&position,&worker,&worktree,&chat,&binding,&binding_generation,&attachment_generation,&runtime_generation]).await?;
        if let Some(row) = created.first() {
            return terminal_summary(&serde_json::from_str(&row.get::<String>(0)?)?).map(Some);
        }
        let winner = self
            .database
            .query(
                "SELECT to_jsonb(t)::text FROM terminals t WHERE linked_chat_id=$1",
                &[&chat],
            )
            .await?;
        let Some(row) = winner.first() else {
            bail!("The linked console was removed during creation.");
        };
        terminal_summary(&serde_json::from_str(&row.get::<String>(0)?)?).map(Some)
    }
}
