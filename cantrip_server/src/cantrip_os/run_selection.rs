use super::{Repository, chats, text};
use crate::{database::Executor, wire};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};

#[derive(Debug)]
pub(crate) struct CapturedRunReadFailure(anyhow::Error);
impl std::fmt::Display for CapturedRunReadFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.0, formatter)
    }
}
impl std::error::Error for CapturedRunReadFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.0.as_ref())
    }
}

impl Repository {
    pub async fn run_sources(&self, owner: &str, project: &str) -> Result<Vec<Value>> {
        let mut sources = Vec::new();
        for binding in self.bindings(owner, project).await? {
            let context = self.context(owner, project, text(&binding, "id")?).await?;
            let available = chats::available(&context).is_ok()
                && context["runTarget"]["lifecycleState"] == "ready";
            sources.push(super::checked("cantripOsRunSourceSchema", json!({
                "binding":context["binding"],"instance":context["instance"],"workspace":context["workspace"],
                "target":context["runTarget"],"available":available,
            }))?);
        }
        Ok(sources)
    }

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
                .await
                .map_err(CapturedRunReadFailure)?
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
