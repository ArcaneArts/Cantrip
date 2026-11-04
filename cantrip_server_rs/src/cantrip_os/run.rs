use super::{Repository, chats, decode, text};
use crate::database::Executor;
use anyhow::{Result, ensure};
use serde_json::json;

impl Repository {
    /// Resolve Primary within the selected source and workspace, never through
    /// the active chat or the project's default worker-local replica.
    pub async fn run_primary(
        &self,
        owner: &str,
        project: &str,
        binding: &str,
        runtime: &str,
    ) -> Result<serde_json::Value> {
        let ex = Executor::Database(&self.database);
        let selected = chats::select(ex, owner, project, binding).await?;
        let source = &selected["source"];
        ensure!(
            source["instance"]["runtimeGeneration"] == runtime,
            "The selected Linux Run source changed or is unavailable; no host fallback was attempted."
        );
        let rows = decode(ex.query("SELECT jsonb_build_object('id',b.id)::text FROM cantrip_os_source_bindings b JOIN project_worktrees t ON t.id=b.worktree_id AND t.project_source_id=$3 AND t.is_primary=true WHERE b.owner_id=$1 AND b.project_id=$2 AND b.project_source_id=$3 AND b.workspace_id=$4 AND b.retired_at IS NULL", &[&owner, &project, &text(&source["binding"], "projectSourceId")?, &text(&source["workspace"], "id")?]).await?)?;
        ensure!(
            rows.len() == 1,
            "This Linux source needs one explicitly bound Primary in the selected workspace."
        );
        let selected_primary = chats::select(ex, owner, project, text(&rows[0], "id")?).await?;
        let primary = &selected_primary["source"];
        ensure!(
            primary["instance"]["runtimeGeneration"] == runtime
                && primary["instance"]["id"] == source["instance"]["id"]
                && primary["instance"]["attachmentGeneration"]
                    == source["instance"]["attachmentGeneration"],
            "The selected Linux source's Primary is unavailable; no host fallback was attempted."
        );
        chats::execution_for_source(
            owner,
            primary,
            &json!({
                "binding_generation": primary["binding"]["bindingGeneration"],
                "attachment_generation": primary["instance"]["attachmentGeneration"],
                "runtime_generation": runtime,
            }),
        )
    }
}
