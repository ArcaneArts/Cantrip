use super::{Kind, Repository, now, queries::run, summary};
use crate::{
    database::Executor,
    projects::targets::TargetRepository,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};

impl Repository {
    pub async fn update(
        &self,
        kind: Kind,
        owner: &str,
        id: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let owned = if kind == Kind::View {
            !run(
                self.executor(),
                "view_owned",
                &[json!(owner), json!(id), json!(1)],
            )
            .await?
            .is_empty()
        } else {
            self.context(kind, owner, id).await?.is_some()
        };
        if !owned {
            return Ok(None);
        }
        let empty = kind == Kind::Code && !truthy(input.get("titleProtection"));
        let key = kind.key(if empty { "update_empty" } else { "update" });
        let parameters = if empty {
            vec![now(), json!(id)]
        } else {
            vec![input["titleProtection"].clone(), now(), json!(id)]
        };
        run(self.executor(), &key, &parameters)
            .await?
            .first()
            .map(|row| summary(row, kind))
            .transpose()
    }
    pub async fn update_explorer_state(
        &self,
        owner: &str,
        id: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        if self.context(Kind::Explorer, owner, id).await?.is_none() {
            return Ok(None);
        }
        run(
            self.executor(),
            "explorer_state",
            &[
                input["stateProtection"].clone(),
                input["fileMode"].clone(),
                now(),
                json!(id),
            ],
        )
        .await?
        .first()
        .map(|row| summary(row, Kind::Explorer))
        .transpose()
    }
    pub async fn update_worktree(
        &self,
        kind: Kind,
        owner: &str,
        id: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let context = if kind == Kind::Code {
            self.context(kind, owner, id).await?
        } else {
            self.selected(kind, owner, id).await?
        };
        let Some(context) = context else {
            return Ok(None);
        };
        if kind == Kind::View && context["kind"] == "remote-desktop" {
            anyhow::bail!("Remote Desktop views do not use worktrees.");
        }
        let project = if kind == Kind::Code {
            &context["codeTab"]["projectId"]
        } else {
            &context["projectId"]
        };
        let Some(target) = TargetRepository::new(self.database.clone())
            .ready_worktree(
                owner,
                project.as_str().context("Surface project")?,
                &input["worktreeId"],
            )
            .await?
        else {
            return Ok(None);
        };
        let values = match kind {
            Kind::Explorer => vec![
                input["stateProtection"].clone(),
                target["workerId"].clone(),
                target["id"].clone(),
                json!("preview"),
                now(),
                json!(id),
            ],
            Kind::Code => vec![
                target["workerId"].clone(),
                target["id"].clone(),
                now(),
                json!(id),
                context["workerId"].clone(),
                context["worktreeId"].clone(),
            ],
            Kind::View => vec![target["id"].clone(), now(), json!(id)],
        };
        run(self.executor(), &kind.key("worktree"), &values)
            .await?
            .first()
            .map(|row| summary(row, kind))
            .transpose()
    }
    /// Return the original execution context; callers preserve each route's
    /// boolean, no-content or resource-retirement behavior.
    pub async fn delete(&self, kind: Kind, owner: &str, id: &str) -> Result<Option<Value>> {
        let Some(context) = self.context(kind, owner, id).await? else {
            return Ok(None);
        };
        let project = if kind == Kind::Code {
            &context["codeTab"]["projectId"]
        } else {
            &context["projectId"]
        }
        .as_str()
        .context("Surface project")?
        .to_owned();
        let (tab_kind, definition) = match kind {
            Kind::Explorer => ("explorer".to_owned(), "project.explorer".to_owned()),
            Kind::Code => ("code".to_owned(), "project.code".to_owned()),
            Kind::View => {
                let kind = context["kind"].as_str().context("Project view kind")?;
                let definition = super::view_definition(kind)?;
                ("view".to_owned(), definition.to_owned())
            }
        };
        let (owner, id) = (owner.to_owned(), id.to_owned());
        let deleted = self
            .database
            .transaction(|tx| {
                Box::pin(async move {
                    crate::workspaces::remove_resource(tx, &owner, &project, &definition, &id)
                        .await?;
                    crate::project_layout::detach_resource(tx, &project, &tab_kind, &id).await?;
                    let executor = Executor::Transaction(tx);
                    if kind == Kind::View {
                        run(executor, "view_surface_delete", &[json!(id)]).await?;
                    }
                    let rows = run(executor, &kind.key("delete"), &[json!(id)]).await?;
                    Ok(kind == Kind::Code || rows.len() == 1)
                })
            })
            .await?;
        Ok(deleted.then_some(context))
    }
}
