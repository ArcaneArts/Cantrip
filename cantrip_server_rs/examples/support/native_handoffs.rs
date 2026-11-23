//! Actual durable handoff repository on the same databases as native admission.
use anyhow::{Context, Result};
use cantrip_server::{database::Database, native_handoffs::Repository, wire::Value};
use futures::FutureExt;
use std::sync::Arc;
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    if input["action"] == "service" {
        return super::native_handoff_service::run(database, input)
            .boxed()
            .await;
    }
    let repository = Repository::new(database.clone());
    let owner = input["owner"].as_str().context("Handoff owner")?;
    let worker = input["worker"].as_str().unwrap_or("alpha");
    let chat = input["chat"].as_str().unwrap_or("chat");
    let operation = input["operation"].as_str().unwrap_or("");
    match input["action"].as_str().unwrap_or("") {
        "configuration" => {
            let state = repository
                .get(owner, chat, operation)
                .await?
                .context("Handoff fixture configuration state")?;
            let routing = cantrip_server::chats::routing::ModelRouting::with_dependencies(
                database.clone(),
                Arc::new(|_| true),
                Arc::new(|_, _| async { Ok(false) }.boxed()),
                Arc::new(|| chrono::Utc::now().timestamp_millis() as f64),
            );
            let console = cantrip_server::chats::managed_console::ManagedConsole::with_request(
                database,
                routing,
                Arc::new(|_, _, _| {
                    async {
                        anyhow::bail!("Unexpected worker request during handoff configuration")
                    }
                    .boxed()
                }),
            );
            repository
                .configuration(
                    owner,
                    &state,
                    input["side"].as_str().unwrap_or("source"),
                    &console,
                )
                .await
        }
        "guard" => {
            let input = input.clone();
            let (owner, chat) = (owner.to_owned(), chat.to_owned());
            database
                .transaction(|tx| {
                    Box::pin(async move {
                        cantrip_server::native_commands::context::lock_chat(tx, &owner, &chat)
                            .await?;
                        cantrip_server::chats::guard::assert_runtime_writable(
                            tx,
                            &chat,
                            input["runtime"].as_str(),
                            input["epoch"].as_str(),
                            if input["access"] == "attach" {
                                cantrip_server::chats::guard::Access::Attach
                            } else {
                                cantrip_server::chats::guard::Access::Write
                            },
                        )
                        .await?;
                        Ok(Value::Null)
                    })
                })
                .await
        }
        "begin" => repository.begin(owner, chat, &input["input"]).await,
        "get" => Ok(repository
            .get(owner, chat, operation)
            .await?
            .unwrap_or(Value::Null)),
        "inventory" => Ok(repository
            .inventory(owner, chat)
            .await?
            .unwrap_or(Value::Null)),
        "active" => Ok(Value::Array(
            repository.active_for_worker(owner, worker).await?,
        )),
        "cancel" => {
            repository
                .request_cancellation(owner, chat, operation)
                .await
        }
        "prepared" => {
            repository
                .prepared(
                    owner,
                    worker,
                    operation,
                    &input["prepared"],
                    input.get("expectedRuntime"),
                    input.get("expectedEpoch"),
                )
                .await
        }
        "commit" => repository.commit(owner, worker, operation).await,
        "recover" => {
            repository
                .recover(
                    owner,
                    worker,
                    operation,
                    input["side"].as_str().context("Recovery side")?,
                    &input["expectedBindingId"],
                    &input["recovered"],
                )
                .await
        }
        "finish" => {
            repository
                .finish(
                    owner,
                    worker,
                    operation,
                    input["outcome"].as_str().context("Handoff outcome")?,
                )
                .await
        }
        "failure" => {
            repository
                .failure(
                    owner,
                    worker,
                    operation,
                    input["errorCode"].as_str().context("Handoff diagnostic")?,
                )
                .await
        }
        _ => anyhow::bail!("Unknown native handoff fixture action"),
    }
}
