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
