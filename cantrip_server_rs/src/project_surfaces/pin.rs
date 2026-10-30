use super::{Kind, Repository, now, queries, run, summary};
use crate::{
    database::Executor,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};

impl Repository {
    pub async fn pin_explorer(
        &self,
        owner: &str,
        id: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let (owner, id, input) = (owner.to_owned(), id.to_owned(), input.clone());
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    let executor = Executor::Transaction(tx);
                    let rows = run(
                        executor,
                        "explorer_pin_select",
                        &[json!(owner), json!(id), json!(1)],
                    )
                    .await?;
                    let Some(row) = rows.first() else {
                        return Ok(None);
                    };
                    let project = row.get::<String>(queries::column("explorers", "projectId"))?;
                    if !run(
                        executor,
                        "explorer_members",
                        &[json!(project), json!(format!("explorer:{id}")), json!(1)],
                    )
                    .await?
                    .is_empty()
                    {
                        return summary(row, Kind::Explorer).map(Some);
                    }
                    let rows = run(
                        executor,
                        "explorer_pin",
                        &[
                            input["titleProtection"].clone(),
                            input["stateProtection"].clone(),
                            input["fileMode"].clone(),
                            now(),
                            json!(id),
                        ],
                    )
                    .await?;
                    let row = rows
                        .first()
                        .context("Database returned no row after pinning an explorer.")?;
                    crate::pane_layouts::attach_entity(
                        tx,
                        &project,
                        &json!(id),
                        "project.file",
                        &input,
                    )
                    .await?;
                    summary(row, Kind::Explorer).map(Some)
                })
            })
            .await
    }
}
