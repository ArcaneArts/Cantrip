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
        let (worker, tree) = if kind == Kind::Explorer && !input["cantripOsBindingId"].is_null() {
            let selected = crate::cantrip_os::chats::select(
                self.executor(),
                owner,
                project,
                input["cantripOsBindingId"].as_str().context("OS binding")?,
            )
            .await?;
            anyhow::ensure!(
                input["target"].is_null()
                    && (input["worktreeId"].is_null()
                        || input["worktreeId"]
                            == Value::from_serialize(&selected["selected"]["worktree"]["id"])),
                "OS source and worktree selection differ."
            );
            (
                Value::from_serialize(&selected["selected"]["workerId"]),
                Value::from_serialize(&selected["selected"]["worktree"]["id"]),
            )
        } else if kind == Kind::View {
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
        let (owner, project, input) = (owner.to_owned(), project.to_owned(), input.clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let capture =
                        if kind == Kind::Explorer && !input["cantripOsBindingId"].is_null() {
                            Some(
                                crate::cantrip_os::files::capture(
                                    Executor::Transaction(tx),
                                    &owner,
                                    &project,
                                    tree.as_str().context("OS worktree")?,
                                    input["cantripOsBindingId"].as_str().unwrap(),
                                    input["cantripOsRuntimeGeneration"].as_str().unwrap_or(""),
                                )
                                .await?,
                            )
                        } else {
                            None
                        };
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
                    let rows = if let Some(captured) = capture {
                        for key in [
                            "binding_id",
                            "binding_generation",
                            "attachment_generation",
                            "runtime_generation",
                        ] {
                            parameters.push(Value::from_serialize(&captured[key]));
                        }
                        super::queries::run_captured(Executor::Transaction(tx), &parameters).await?
                    } else {
                        run(Executor::Transaction(tx), &kind.key("create"), &parameters).await?
                    };
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
