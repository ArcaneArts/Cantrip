//! Drives actual native settings repositories against disposable connector state.
use anyhow::{Context, Result, bail};
use cantrip_server::{
    database::Database,
    native_commands::{
        context, model_attribution,
        settings_persistence::{self as persistence, SettingsRepository},
    },
    wire::Value,
};
use futures::FutureExt;
use std::sync::{Arc, Mutex};

pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let repository = SettingsRepository::new(database.clone());
    let owner = input["owner"].as_str().context("Settings owner")?;
    let chat = input["chat"].as_str().context("Settings Chat")?;
    let op = input["op"].as_str().context("Settings operation")?;
    if op == "native-command-settings-model-inventory" {
        return Ok(
            cantrip_server::settings::repository::SettingsRepository::new(database)
                .read_native_model_inventory(owner, &input["input"])
                .boxed()
                .await?
                .unwrap_or(Value::Null),
        );
    }
    match op {
        "native-command-settings-get" => {
            return Ok(repository.get(owner, chat).await?.unwrap_or(Value::Null));
        }
        "native-command-settings-resolve" => {
            return repository
                .resolve_write_binding(owner, chat, &input["bindingId"])
                .boxed()
                .await;
        }
        "native-command-settings-observe" => {
            return repository.observe(owner, &input["input"]).boxed().await;
        }
        "native-command-settings-refresh" => {
            let reads = Arc::new(Mutex::new(Vec::new()));
            let trace = reads.clone();
            let (owner, chat) = (owner.to_owned(), chat.to_owned());
            let (nested_owner, nested_chat) = (owner.clone(), chat.clone());
            let input = input.clone();
            let db = database.clone();
            let state =
                repository
                    .refresh(&owner, &chat, move |scope| async move {
                        trace.lock().unwrap().push(scope);
                        if let Some(message) = input.get("readFailure").and_then(Value::as_str) {
                            bail!("{message}");
                        }
                        if let Some(statements) = input["afterReadSql"].as_array() {
                            for statement in statements {
                                db.execute(statement.as_str().context("Settings read mutation")?)
                                    .await?;
                            }
                        }
                        if let Some(snapshot) = input.get("publishDuringRead") {
                            let snapshot = snapshot.clone();
                            SettingsRepository::new(db)
                                .refresh(&nested_owner, &nested_chat, move |_| async move {
                                    Ok(snapshot)
                                })
                                .boxed()
                                .await?;
                        }
                        Ok(input["snapshot"].clone())
                    })
                    .boxed()
                    .await?;
            return Ok(Value::object([
                ("state", state),
                ("reads", Value::Array(reads.lock().unwrap().clone())),
            ]));
        }
        _ => {}
    }
    let (owner, chat, input) = (owner.to_owned(), chat.to_owned(), input.clone());
    database
        .transaction(|tx| {
            Box::pin(async move {
                context::lock_chat(tx, &owner, &chat).await?;
                let op = input["op"].as_str().context("Settings operation")?;
                if op == "native-command-settings-assert-source" {
                    return persistence::assert_write_binding(
                        tx,
                        &owner,
                        &chat,
                        &input["bindingId"],
                        input.get("source"),
                    )
                    .await;
                }
                if op == "native-command-settings-scope-model" {
                    return model_attribution::scoped(
                        tx,
                        &owner,
                        &input["scope"],
                        &input["snapshot"],
                    )
                    .await;
                }
                if op == "native-command-settings-change" {
                    return persistence::change(tx, &chat, |_| Ok(input["state"].clone())).await;
                }
                let operation = input["operation"]
                    .as_str()
                    .context("Settings journal operation")?;
                let rows = tx
                    .query(
                        "SELECT to_jsonb(n)::text FROM native_commands n WHERE operation_id=$1",
                        &[&operation],
                    )
                    .await?;
                let command: Value = serde_json::from_str(
                    &rows
                        .first()
                        .context("Settings journal row")?
                        .get::<String>(0)?,
                )?;
                match op {
                    "native-command-settings-admit" => {
                        persistence::admit_state(tx, &command).await?
                    }
                    "native-command-settings-settle" => {
                        persistence::settle_state(
                            tx,
                            &command,
                            input["outcome"].as_str().context("Settings settlement")?,
                        )
                        .await?
                    }
                    "native-command-settings-transport" => {
                        persistence::settle_transport(tx, &command).await?
                    }
                    _ => bail!("Unknown native settings fixture operation"),
                }
                Ok(Value::Null)
            })
        })
        .await
}
