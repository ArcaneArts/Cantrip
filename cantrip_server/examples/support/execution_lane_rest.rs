use anyhow::{Context, Result};
use cantrip_server::{chats::execution_lanes::LaneRepository, database::Database, wire::Value};
use futures::FutureExt;
use std::sync::Arc;
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let repository = LaneRepository::new(database);
    let owner = input["owner"].as_str().context("Lane owner")?;
    let chat = input["chat"].as_str().context("Lane Chat")?;
    let lane = input["lane"].as_str().unwrap_or("");
    Ok(match input["action"].as_str().context("Lane action")? {
        "list-chat" => Value::Array(repository.list_chat(owner, chat).boxed().await?),
        "list-project" => Value::Array(
            repository
                .list_project(
                    owner,
                    input["project"].as_str().context("Lane project")?,
                    input["includeHistory"].as_bool().unwrap_or(false),
                )
                .boxed()
                .await?,
        ),
        "context" => repository
            .lane_context(owner, chat, lane)
            .boxed()
            .await?
            .unwrap_or(Value::Null),
        "recovery" => repository
            .recovery_context(owner, chat, lane)
            .boxed()
            .await?
            .unwrap_or(Value::Null),
        "reset" => {
            repository.reset_interrupted().boxed().await?;
            Value::Null
        }
        "release" => repository
            .release(
                owner,
                chat,
                lane,
                input["returnToPrimary"].as_bool().unwrap_or(false),
            )
            .boxed()
            .await?
            .unwrap_or(Value::Null),
        "schedule" => repository
            .schedule_transition(
                owner,
                chat,
                &input["expectedLane"],
                &input["target"],
                input["kind"].as_str().unwrap_or("switch"),
                input["purpose"].as_str().unwrap_or("Transition fixture"),
            )
            .boxed()
            .await?
            .unwrap_or(Value::Null),
        "pending" => repository
            .pending_transition(owner, chat)
            .boxed()
            .await?
            .unwrap_or(Value::Null),
        "pending-chats" => Value::from_serialize(
            &repository
                .pending_transition_chat_ids(
                    owner,
                    input["worker"].as_str().context("Transition worker")?,
                )
                .boxed()
                .await?,
        ),
        "cancel" => Value::Bool(
            repository
                .cancel_transition(owner, chat, lane)
                .boxed()
                .await?,
        ),
        "apply" => repository
            .apply_transition(owner, chat, lane)
            .boxed()
            .await?
            .unwrap_or(Value::Null),
        _ => anyhow::bail!("Unknown lane action"),
    })
}
