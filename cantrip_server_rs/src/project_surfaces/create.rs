use super::{Kind, Repository, run, summary};
use crate::{
    database::Executor,
    projects::{
        placement::{Connected, PlacementRepository},
        targets::TargetRepository,
    },
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};

impl Repository {
    pub async fn create(
        &self,
        kind: Kind,
        owner: &str,
        project: &str,
        input: &Value,
        connected: Connected<'_>,
    ) -> Result<Option<Value>> {
        let (worker, tree) = if kind == Kind::View {
            let tree = if truthy(input.get("worktreeId")) {
                TargetRepository::new(self.database.clone())
                    .ready_worktree(owner, project, &input["worktreeId"])
                    .await?
                    .map(|v| v["id"].clone())
            } else {
                run(
                    self.executor(),
                    "view_source",
                    &[json!(true), json!(project), json!(owner), json!("ready")],
                )
                .await?
                .first()
                .map(|row| row.get::<String>(3).map(|v| json!(v)))
                .transpose()?
            };
            let Some(tree) = tree else {
                return Ok(None);
            };
            (Value::Null, tree)
        } else {
            let target = input.get("target").filter(|v| !v.is_null()).cloned().or_else(|| truthy(input.get("worktreeId")).then(|| json!({"kind":"worktree","projectId":project,"worktreeId":input["worktreeId"]})));
            let placement = PlacementRepository::new(self.database.clone())?
                .resolve(
                    owner,
                    project,
                    "explorer",
                    target.as_ref(),
                    connected,
                    false,
                )
                .await?;
            (
                placement["placement"]["workerId"].clone(),
                placement["placement"]["worktreeId"].clone(),
            )
        };
        let position = crate::project_layout::next_position(&self.database, project).await?;
        let (project, input) = (project.to_owned(), input.clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let mut parameters = vec![
                        input["id"].clone(),
                        json!(project),
                        input["titleProtection"].clone(),
                    ];
                    match kind {
                        Kind::Explorer => parameters.extend([
                            input["stateProtection"].clone(),
                            json!(position),
                            worker,
                            tree,
                            input
                                .get("fileMode")
                                .filter(|v| !v.is_null())
                                .cloned()
                                .unwrap_or_else(|| json!("preview")),
                        ]),
                        Kind::Code => parameters.extend([json!(position), worker, tree]),
                        Kind::View => {
                            parameters.extend([input["kind"].clone(), tree, json!(position)])
                        }
                    }
                    let rows =
                        run(Executor::Transaction(tx), &kind.key("create"), &parameters).await?;
                    let row = rows.first().context(match kind {
                        Kind::Explorer => "Database returned no row after creating an explorer.",
                        Kind::Code => "Database returned no row after creating a Code tab.",
                        Kind::View => "Database returned no row after creating a project view.",
                    })?;
                    if kind != Kind::Explorer || input["attachToTabLayout"] != false {
                        let definition = match kind {
                            Kind::Explorer => "project.explorer",
                            Kind::Code => "project.code",
                            Kind::View => super::view_definition(
                                input["kind"].as_str().context("Project view kind")?,
                            )?,
                        };
                        crate::pane_layouts::attach_entity(
                            tx,
                            &project,
                            &input["id"],
                            definition,
                            &input,
                        )
                        .await?;
                    }
                    summary(row, kind).map(Some)
                })
            })
            .await
    }
}
