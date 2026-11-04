use super::{Repository, chats, text};
use crate::{database::Executor, wire};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

impl Repository {
    pub async fn selected_run(
        &self,
        owner: &str,
        project: &str,
        selection: &Value,
        worktree: Option<&str>,
    ) -> Result<Value> {
        if selection["kind"] == "runtime" {
            let captured = crate::run_configurations::Repository::new(self.database.clone())
                .captured(owner, text(selection, "runtimeId")?)
                .await?
                .context("The captured Linux Run was not found for this target.")?;
            let captured: Value = serde_json::from_str(&captured.stringify())?;
            ensure!(
                !captured["osExecution"].is_null()
                    && captured["runtime"]["projectId"] == project
                    && worktree.is_none_or(|id| captured["runtime"]["worktreeId"] == id),
                "The captured Linux Run was not found for this target."
            );
            return Ok(captured);
        }
        let selected = chats::select(
            Executor::Database(&self.database),
            owner,
            project,
            text(selection, "bindingId")?,
        )
        .await?;
        let source = &selected["source"];
        ensure!(
            source["binding"]["bindingGeneration"] == selection["bindingGeneration"]
                && source["instance"]["attachmentGeneration"] == selection["attachmentGeneration"]
                && source["instance"]["runtimeGeneration"] == selection["runtimeGeneration"],
            "The selected Linux Run source changed or is unavailable; no host fallback was attempted."
        );
        let definitions = self
            .run_primary(
                owner,
                project,
                text(selection, "bindingId")?,
                text(selection, "runtimeGeneration")?,
            )
            .await?;
        let mut target = definitions.clone();
        if let Some(worktree) = worktree.filter(|id| definitions["scope"]["worktreeId"] != *id) {
            let bindings = self.bindings(owner, project).await?;
            let candidates: Vec<_> = bindings
                .iter()
                .filter(|binding| {
                    binding["worktreeId"] == worktree
                        && binding["projectSourceId"] == source["binding"]["projectSourceId"]
                        && binding["workspaceId"] == source["workspace"]["id"]
                })
                .collect();
            ensure!(
                candidates.len() == 1,
                "This worktree needs one explicit binding in the selected Linux source and workspace."
            );
            let context = chats::select(
                Executor::Database(&self.database),
                owner,
                project,
                text(candidates[0], "id")?,
            )
            .await?;
            let actual = &context["source"];
            ensure!(
                actual["instance"]["attachmentGeneration"] == selection["attachmentGeneration"]
                    && actual["instance"]["runtimeGeneration"] == selection["runtimeGeneration"],
                "The selected Linux Run target changed."
            );
            target = chats::execution_for_source(
                owner,
                actual,
                &json!({"binding_generation":actual["binding"]["bindingGeneration"],"attachment_generation":selection["attachmentGeneration"],"runtime_generation":selection["runtimeGeneration"]}),
            )?;
        }
        let roots = json!({"definitions":definitions,"target":target});
        let execution_key =
            crate::run_configurations::execution::key(&wire::Value::from_serialize(&roots))?;
        Ok(json!({"runtime":null,"osExecution":roots,"executionKey":execution_key}))
    }
}
