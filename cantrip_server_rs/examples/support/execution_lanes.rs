use anyhow::{Context, Result};
use cantrip_server::{
    chats::{
        execution_lanes::{self, LaneError, LaneRepository},
        guard::NativeCommandError,
    },
    database::{Database, Transaction},
    wire::Value,
};
use futures::FutureExt;
use std::sync::Arc;
fn failure(error: &anyhow::Error) -> Value {
    let mut result = Value::object([] as [(&str, Value); 0]);
    if let Some(error) = error.downcast_ref::<LaneError>() {
        result["laneError"] = Value::String(error.class_name().into());
    }
    if let Some(error) = error.downcast_ref::<NativeCommandError>() {
        result["commandError"] = Value::String(error.code.as_str().into());
        result["commandStatus"] = Value::from_serialize(&error.status);
    }
    for cause in error.chain() {
        if let Some(pg) = cause.downcast_ref::<tokio_postgres::Error>()
            && let Some(code) = pg.code()
        {
            result["databaseCode"] = Value::String(code.code().into());
        }
        if let Some(pglite::Error::Database { sqlstate, .. }) =
            cause.downcast_ref::<pglite::Error>()
        {
            result["databaseCode"] = Value::String(sqlstate.as_str().into());
        }
    }
    if result.get("databaseCode").is_none() {
        result["message"] = Value::String(error.to_string().into());
    }
    result
}
async fn nested(tx: &Transaction<'_>, input: &Value) -> Result<Value> {
    let chat = input["chat"].as_str().context("Lane Chat")?;
    match input["action"].as_str().context("Lane action")? {
        "start" => Ok(execution_lanes::start_in_transaction(
            tx,
            input["owner"].as_str().context("Lane owner")?,
            chat,
            input["actor"].as_str().unwrap_or("user"),
            input["purpose"]
                .as_str()
                .unwrap_or("Managed native command"),
        )
        .boxed()
        .await?
        .unwrap_or(Value::Null)),
        "finish" => Ok(Value::Bool(
            execution_lanes::finish_in_transaction(
                tx,
                chat,
                input["lane"].as_str().context("Lane ID")?,
                input["status"].as_str().unwrap_or("idle"),
                input.get("options").unwrap_or(&Value::Null),
            )
            .boxed()
            .await?,
        )),
        "runtime" => Ok(Value::Bool(
            execution_lanes::update_runtime_in_transaction(
                tx,
                chat,
                input["lane"].as_str().context("Lane ID")?,
                input["thread"].as_str(),
                input["status"].as_str().unwrap_or("running"),
            )
            .boxed()
            .await?,
        )),
        _ => anyhow::bail!("Unknown lane action"),
    }
}
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    if !matches!(
        input["action"].as_str(),
        Some("start" | "finish" | "runtime")
    ) {
        return super::execution_lane_rest::run(database, input)
            .boxed()
            .await;
    }
    if input["op"] == "native-command-lane-nested" {
        let input = input.clone();
        return database.transaction(|tx|Box::pin(async move {
            let chat=input["chat"].as_str().context("Lane Chat")?;
            tx.query("UPDATE chats SET managed_input_revision=managed_input_revision+7 WHERE id=$1",&[&chat]).await?;
            let result=match nested(tx,&input).await {Ok(value)=>Value::object([("value",value)]),Err(error)=>Value::object([("caught",failure(&error))])};
            tx.query("UPDATE chats SET has_unread_completion=true WHERE id=$1",&[&chat]).await?;
            Ok(result)
        })).await;
    }
    let repository = LaneRepository::new(database);
    let chat = input["chat"].as_str().context("Lane Chat")?;
    match input["action"].as_str().context("Lane action")? {
        "start" => Ok(repository
            .start(
                input["owner"].as_str().context("Lane owner")?,
                chat,
                input["actor"].as_str().unwrap_or("user"),
                input["purpose"]
                    .as_str()
                    .unwrap_or("Managed native command"),
            )
            .boxed()
            .await?
            .unwrap_or(Value::Null)),
        "finish" => Ok(Value::Bool(
            repository
                .finish(
                    chat,
                    input["lane"].as_str().context("Lane ID")?,
                    input["status"].as_str().unwrap_or("idle"),
                    input.get("options").unwrap_or(&Value::Null),
                )
                .boxed()
                .await?,
        )),
        "runtime" => Ok(Value::Bool(
            repository
                .update_runtime(
                    chat,
                    input["lane"].as_str().context("Lane ID")?,
                    input["thread"].as_str(),
                    input["status"].as_str().unwrap_or("running"),
                )
                .boxed()
                .await?,
        )),
        _ => anyhow::bail!("Unknown lane action"),
    }
}
