use anyhow::{Context, Result};
use cantrip_server::{
    database::Database, native_commands::queued_prompt::PromptRepository, wire::Value,
};
use futures::FutureExt;
use std::sync::Arc;
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Queue fixture string")?
        .lossy()
        .into_owned())
}
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let repository = PromptRepository::new(database);
    let owner = text(&input["owner"])?;
    let chat = input.get("chat").map(text).transpose()?.unwrap_or_default();
    let prompt = input
        .get("prompt")
        .map(text)
        .transpose()?
        .unwrap_or_default();
    let empty = Value::Array(Vec::new());
    let attachments = input.get("attachments").unwrap_or(&empty);
    Ok(
        match input["action"].as_str().context("Queue fixture action")? {
            "list-encrypted" => {
                Value::Array(repository.list_encrypted(&owner, &chat).boxed().await?)
            }
            "get-encrypted" => repository
                .get_encrypted(&owner, &prompt)
                .boxed()
                .await?
                .unwrap_or(Value::Null),
            "create-encrypted" => repository
                .create_encrypted(&owner, &chat, &input["content"], attachments)
                .boxed()
                .await?
                .unwrap_or(Value::Null),
            "replace-encrypted" => repository
                .replace_encrypted(&owner, &input["prompt"], &input["content"], attachments)
                .boxed()
                .await?
                .unwrap_or(Value::Null),
            "list-visible" => Value::Array(repository.list_visible(&owner, &chat).boxed().await?),
            "get-visible" => repository
                .get_visible(&owner, &prompt)
                .boxed()
                .await?
                .unwrap_or(Value::Null),
            "key-visible" => repository
                .visible_by_key(&owner, &chat, &text(&input["key"])?)
                .boxed()
                .await?
                .unwrap_or(Value::Null),
            "create-visible" => repository
                .create_visible(
                    &owner,
                    &chat,
                    &input["content"],
                    &text(&input["model"])?,
                    attachments,
                )
                .boxed()
                .await?
                .unwrap_or(Value::Null),
            "update-visible" => repository
                .update_visible(&owner, &prompt, &input["content"], input.get("attachments"))
                .boxed()
                .await?
                .unwrap_or(Value::Null),
            "delete" => repository
                .delete(&owner, &prompt)
                .boxed()
                .await?
                .unwrap_or(Value::Null),
            "reorder" => Value::Bool(
                repository
                    .reorder(&owner, &chat, &input["content"])
                    .boxed()
                    .await?,
            ),
            _ => anyhow::bail!("Unknown queued prompt operation"),
        },
    )
}
