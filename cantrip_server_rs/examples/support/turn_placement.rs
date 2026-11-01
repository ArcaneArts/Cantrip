use anyhow::{Context, Result};
use cantrip_server::{
    chats::{Repository, turn_placement::TurnPlacement},
    database::Database,
    wire::Value,
};
use futures::FutureExt;
use std::sync::{Arc, Mutex};
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let owner = input["owner"].as_str().context("Placement fixture owner")?;
    let chat = input["chat"].as_str().context("Placement fixture chat")?;
    let chats = Repository::new(database.clone());
    if input["op"] == "native-command-gui-worktree" {
        return Ok(chats
            .update_worktree(owner, chat, &input["input"], input.get("expected"))
            .await?
            .unwrap_or(Value::Null));
    }
    let context = match input.get("context") {
        Some(value) => value.clone(),
        None => chats
            .execution_context(owner, chat)
            .await?
            .context("Placement fixture context")?,
    };
    let calls = Arc::new(Mutex::new(Vec::new()));
    let connected = input["connected"] != false;
    let service =
        TurnPlacement::with_dependencies(database.clone(), Arc::new(move |_| connected), {
            let (input, calls) = (input.clone(), calls.clone());
            Arc::new(move |worker, command| {
                let (input, calls, database) = (input.clone(), calls.clone(), database.clone());
                async move {
                    calls.lock().unwrap().push(Value::object([
                        ("worker", Value::from_serialize(&worker)),
                        ("command", command),
                    ]));
                    anyhow::ensure!(
                        input["failRequest"] != true,
                        "Controlled worktree inventory failure"
                    );
                    if let Some(sql) = input["inventorySql"].as_str() {
                        database.execute(sql).await?;
                    }
                    Ok(input.get("inventory").cloned())
                }
                .boxed()
            })
        });
    let result = service.reconcile(owner, &context).await?;
    Ok(Value::object([
        ("context", result),
        ("calls", Value::Array(calls.lock().unwrap().clone())),
    ]))
}
