use anyhow::{Context, Result};
use cantrip_server::{chats::Repository, database::Database, wire::Value};
use std::sync::{Arc, Mutex};
macro_rules! json {($($tokens:tt)*)=>{Value::from_serialize(&serde_json::json!($($tokens)*))};}

pub async fn run(
    database: Arc<Database>,
    request: &Value,
    trace: Arc<Mutex<Vec<Value>>>,
) -> Result<Value> {
    let repo = Repository::new(database.clone());
    let owner = request["owner"].as_str().context("Fork owner")?;
    let chat = request["chat"].as_str().context("Fork source Chat")?;
    let input = request["input"].clone();
    let control = request.clone();
    let callback_trace = trace.clone();
    let protect = move |messages: Vec<Value>| async move {
        callback_trace
            .lock()
            .unwrap()
            .push(Value::Array(messages.clone()));
        if let Some(statements) = control.get("mutations").and_then(Value::as_array) {
            for statement in statements {
                database
                    .execute(statement.as_str().context("Fork SQL mutation")?)
                    .await?;
            }
        }
        if let Some(message) = control.get("throw") {
            anyhow::bail!("{}", message.as_str().context("Fork callback error")?)
        }
        if let Some(copies) = control.get("copies") {
            return Ok(copies.as_array().context("Fork callback copies")?.clone());
        }
        messages.iter().enumerate().map(|(index,message)|Ok(json!({"id":control["copyIds"].as_array().and_then(|ids|ids.get(index)).context("Fork copy ID")?,"classification":json!({"role":message["role"],"mode":message["mode"],"attachmentIds":message["attachmentIds"]}),"protectedContent":control.get("protectedContent").unwrap_or(&message["protectedContent"]),"reasoningEffort":control.get("reasoningEffort").unwrap_or(&Value::Null),"idempotencyKey":format!("fork:{}",message["id"].as_str().context("Source message ID")?)}))).collect::<Result<Vec<_>>>()
    };
    let result = if request["op"] == "fork-project" {
        repo.fork_project(owner, chat, &input, protect).await?
    } else {
        repo.fork_standalone(
            owner,
            chat,
            &input,
            |id| {
                request["connected"]
                    .as_array()
                    .is_some_and(|values| values.iter().any(|v| v == id))
            },
            protect,
        )
        .await?
    };
    Ok(json!({"result":result,"trace":Value::Array(trace.lock().unwrap().clone())}))
}
