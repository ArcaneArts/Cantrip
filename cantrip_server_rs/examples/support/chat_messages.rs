use anyhow::{Context, Result};
use cantrip_server::{
    chats::{Repository, message_queries::MessageKind},
    database::Database,
    wire::Value,
};
use std::sync::Arc;
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let repo = Repository::new(database);
    let owner = input["owner"].as_str().context("Message owner")?;
    let chat = input["chat"].as_str().context("Message Chat")?;
    Ok(match input["op"].as_str().context("Message operation")? {
        "message-history" => {
            repo.read_native_history_turns(owner, chat, &input["input"])
                .await?
        }
        "message-append" | "message-upsert" => {
            let attribution = input.get("attribution").filter(|v| !v.is_null());
            let append = input["op"] == "message-append";
            match (input["kind"].as_str(), append) {
                (Some("plain"), true) => {
                    repo.append_message(owner, chat, &input["input"], attribution)
                        .await?
                }
                (Some("plain"), false) => {
                    repo.upsert_message(owner, chat, &input["input"], attribution)
                        .await?
                }
                (Some("encrypted"), true) => {
                    repo.append_encrypted_message(owner, chat, &input["input"], attribution)
                        .await?
                }
                (Some("encrypted"), false) => {
                    repo.upsert_encrypted_message(owner, chat, &input["input"], attribution)
                        .await?
                }
                (Some("task"), true) => {
                    repo.append_task_message(owner, chat, &input["input"], attribution)
                        .await?
                }
                (Some("task"), false) => {
                    repo.upsert_task_message(owner, chat, &input["input"], attribution)
                        .await?
                }
                _ => anyhow::bail!("Unknown message write kind"),
            }
            .unwrap_or(Value::Null)
        }
        "message-key" => repo
            .message_by_idempotency_key(
                owner,
                chat,
                input["key"].as_str().context("Idempotency key")?,
                kind(input)?,
            )
            .await?
            .unwrap_or(Value::Null),
        "message-model" => repo
            .set_message_model_route(
                owner,
                input["message"].as_str().context("Message ID")?,
                input["modelId"].as_str().context("Message model")?,
                &input["runtime"],
                input.get("reasoning").filter(|v| !v.is_null()),
                kind(input)?,
            )
            .await?
            .unwrap_or(Value::Null),
        "message-list" => Value::Array(
            repo.list_messages(
                owner,
                chat,
                match input["kind"].as_str() {
                    Some("plain") => MessageKind::Plain,
                    Some("encrypted") => MessageKind::Encrypted,
                    Some("task") => MessageKind::Task,
                    Some("wire") => MessageKind::AgentWire,
                    _ => anyhow::bail!("Unknown message kind"),
                },
            )
            .await?,
        ),
        "message-page" => {
            let query =
                cantrip_server::wire::parse("chatMessagePageQuerySchema", Some(&input["query"]))
                    .map_err(|error| match error {
                        cantrip_server::wire::ValidationError::Invalid(issues) => {
                            anyhow::anyhow!(Value::Array(issues).stringify_pretty())
                        }
                        cantrip_server::wire::ValidationError::Operation => {
                            anyhow::anyhow!("Protocol coercion failed.")
                        }
                    })?;
            repo.opaque_message_page(owner, chat, input["task"] == true, &query)
                .await?
        }
        "message-latest" => repo
            .latest_encrypted_user_message(owner, chat)
            .await?
            .unwrap_or(Value::Null),
        "message-trim" => Value::Bool(
            repo.trim_latest_encrypted_turn(
                owner,
                chat,
                input["message"].as_str().context("Message ID")?,
            )
            .await?,
        ),
        "message-headers" => Value::Array(repo.message_headers(owner, chat).await?),
        _ => anyhow::bail!("Unknown message fixture operation"),
    })
}
fn kind(input: &Value) -> Result<MessageKind> {
    Ok(match input["kind"].as_str() {
        Some("plain") => MessageKind::Plain,
        Some("encrypted") => MessageKind::Encrypted,
        Some("task") => MessageKind::Task,
        _ => anyhow::bail!("Unknown message kind"),
    })
}
