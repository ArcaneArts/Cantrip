use anyhow::{Context, Result};
use cantrip_server::{
    database::Database,
    tasks::{Conflict, Repository, policy::StateTransitionError},
    wire::Value,
};
use std::sync::Arc;
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let repository = Repository::new(database);
    let owner = input["owner"].as_str().context("Task fixture owner")?;
    let chat = input["chat"].as_str().unwrap_or("");
    let operation = input["operation"].as_str().unwrap_or("");
    let result: Result<Value> = async {
        Ok(
            match input["action"].as_str().context("Task fixture action")? {
                "get" => repository.get(owner, chat).await?.unwrap_or(Value::Null),
                "list" => Value::Array(
                    repository
                        .list(owner, input["project"].as_str().unwrap_or(""))
                        .await?,
                ),
                "rounds" => Value::Array(repository.list_rounds(owner, chat).await?),
                "lookup" => repository
                    .get_operation_context(owner, chat, &input["lookup"])
                    .await?
                    .unwrap_or(Value::Null),
                "draft" => repository
                    .update_draft(owner, chat, &input["input"])
                    .await?
                    .unwrap_or(Value::Null),
                "plan" => repository
                    .update_plan(owner, chat, &input["input"])
                    .await?
                    .unwrap_or(Value::Null),
                "begin" => repository
                    .begin_operation(owner, chat, &input["input"])
                    .await?
                    .unwrap_or(Value::Null),
                "complete" => repository
                    .complete_operation(
                        owner,
                        chat,
                        operation,
                        &input["input"],
                        input["turn"].as_str(),
                    )
                    .await?
                    .unwrap_or(Value::Null),
                "finalize" => repository
                    .complete_finalization_operation(owner, chat, operation)
                    .await?
                    .unwrap_or(Value::Null),
                "fail" => repository
                    .fail_operation(owner, chat, operation, input.get("failure"))
                    .await?
                    .unwrap_or(Value::Null),
                "sync" => repository
                    .sync_implementation_state(owner, chat, &input["input"])
                    .await?
                    .unwrap_or(Value::Null),
                "attach" => repository
                    .attach_operation_execution(owner, chat, operation, &input["input"])
                    .await?
                    .unwrap_or(Value::Null),
                "assistant" => repository
                    .attach_operation_assistant_message(
                        owner,
                        chat,
                        operation,
                        input["message"].as_str().context("Task assistant ID")?,
                    )
                    .await?
                    .unwrap_or(Value::Null),
                "reconcile" => {
                    Value::from_serialize(&repository.reconcile_interrupted_operations().await?)
                }
                "resume" => repository
                    .resume_finalization_goal_launch(owner, chat)
                    .await?
                    .unwrap_or(Value::Null),
                "delete" => repository
                    .delete_owned(owner, chat)
                    .await?
                    .unwrap_or(Value::Null),
                _ => anyhow::bail!("Unknown Task fixture action"),
            },
        )
    }
    .await;
    match result {
        Ok(value) => Ok(Value::object([("value", value)])),
        Err(error) => {
            let (code, transition) = if let Some(conflict) = error.downcast_ref::<Conflict>() {
                (Value::from_serialize(&conflict.code), Value::Null)
            } else if let Some(transition) = error.downcast_ref::<StateTransitionError>() {
                (
                    Value::Null,
                    Value::object([
                        ("from", Value::from_serialize(&transition.from)),
                        ("to", Value::from_serialize(&transition.to)),
                    ]),
                )
            } else {
                return Err(error);
            };
            Ok(Value::object([(
                "error",
                Value::object([
                    ("code", code),
                    ("stateTransition", transition),
                    ("message", Value::from_serialize(&error.to_string())),
                ]),
            )]))
        }
    }
}
