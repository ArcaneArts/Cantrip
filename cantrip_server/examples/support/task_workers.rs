use anyhow::{Context, Result};
use cantrip_server::{
    database::Database,
    task_scheduling::{Conflict, Repository},
    wire::{self, ValidationError, Value},
};
use std::sync::Arc;
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let repository = Repository::new(database);
    let owner = input["owner"].as_str().context("Task Worker owner")?;
    let id = input["worker"].as_str().unwrap_or("");
    let project = input["project"].as_str().unwrap_or("");
    let action = input["action"].as_str().context("Task Worker action")?;
    let schema = match action {
        "create" => Some("taskWorkerCreateSchema"),
        "update" => Some("taskWorkerUpdateSchema"),
        "order" => Some("taskWorkerOrderUpdateSchema"),
        "pause" => Some("projectTaskPauseUpdateSchema"),
        _ => None,
    };
    let data = if input["raw"] != true
        && let Some(schema) = schema
    {
        wire::parse(schema, input.get("input")).map_err(|e| match e {
            ValidationError::Invalid(issues) => {
                anyhow::anyhow!(Value::Array(issues).stringify_pretty())
            }
            ValidationError::Operation => {
                anyhow::anyhow!("Task Worker validation operation failed")
            }
        })?
    } else {
        input["input"].clone()
    };
    let result: Result<Value> = async {
        Ok(match action {
            "list" => repository.list_workers(owner).await?,
            "create" => repository.create_worker(owner, &data).await?,
            "update" => repository
                .update_worker(owner, id, &data)
                .await?
                .unwrap_or(Value::Null),
            "delete" => Value::from_serialize(
                &repository
                    .delete_worker(owner, id, &input["rowVersion"])
                    .await?,
            ),
            "order" => repository.reorder_workers(owner, &data).await?,
            "get-pause" => repository
                .project_pause(owner, project)
                .await?
                .unwrap_or(Value::Null),
            "pause" => repository
                .set_project_pause(owner, project, &data)
                .await?
                .unwrap_or(Value::Null),
            _ => anyhow::bail!("Task Worker fixture action"),
        })
    }
    .await;
    match result {
        Ok(value) => Ok(Value::object([("value", value)])),
        Err(error) => match error.downcast_ref::<Conflict>() {
            Some(e) => Ok(Value::object([(
                "error",
                Value::object([
                    ("code", Value::from_serialize(&e.code)),
                    ("message", Value::from_serialize(&e.message)),
                ]),
            )])),
            None => Err(error),
        },
    }
}
