use anyhow::{Context, Result};
use cantrip_server::{
    database::Database,
    native_commands::{managed_queue::QueueRepository, runtime::gui_queue::GuiQueue},
    wire::Value,
};
use futures::FutureExt;
use std::sync::Arc;
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Managed queue fixture identity")?
        .lossy()
        .into_owned())
}
pub async fn run(database: Arc<Database>, input: &Value) -> Result<Value> {
    let repository = QueueRepository::new(database.clone());
    let owner = text(&input["owner"])?;
    let chat = input.get("chat").map(text).transpose()?.unwrap_or_default();
    let empty = Value::object([] as [(&str, Value); 0]);
    let content = &input["content"];
    if matches!(
        input["action"].as_str(),
        Some("gui-mutate" | "gui-lookup" | "gui-context")
    ) {
        let context = if let Some(context) = input.get("context").filter(|v| !v.is_null()) {
            context.clone()
        } else {
            cantrip_server::chats::Repository::new(database.clone())
                .execution_context(&owner, &chat)
                .boxed()
                .await?
                .context("GUI queue context is unavailable.")?
        };
        let gui = GuiQueue::new(database);
        return match input["action"].as_str().unwrap() {
            "gui-context" => Ok(context),
            "gui-mutate" => {
                gui.mutate(
                    &owner,
                    &context,
                    content,
                    input.get("options").unwrap_or(&empty),
                )
                .boxed()
                .await
            }
            _ => Ok(gui
                .lookup(
                    &owner,
                    &context,
                    content,
                    input.get("options").unwrap_or(&empty),
                )
                .boxed()
                .await?
                .unwrap_or(Value::Null)),
        };
    }
    Ok(
        match input["action"]
            .as_str()
            .context("Managed queue fixture action")?
        {
            "snapshot" => repository.snapshot(&owner, &chat).boxed().await?,
            "read" => {
                repository
                    .read(&owner, &input["worker"], &input["session"])
                    .boxed()
                    .await?
            }
            "mutate" => {
                repository
                    .mutate(&owner, content, input.get("options").unwrap_or(&empty))
                    .boxed()
                    .await?
            }
            "lookup" => repository.lookup(&owner, content).boxed().await?,
            "gui-operation" => {
                repository
                    .gui_operation(&owner, &chat, &text(&input["operation"])?)
                    .boxed()
                    .await?
            }
            "claim-item" => {
                repository
                    .claim_item(
                        &owner,
                        &chat,
                        &input["prompt"],
                        &input["revision"],
                        &input["claimId"],
                    )
                    .boxed()
                    .await?
            }
            "claim-next" => repository
                .claim_next(&owner, &chat)
                .boxed()
                .await?
                .unwrap_or(Value::Null),
            "claim" => repository
                .claim(&owner, &chat, &text(&input["claimId"])?)
                .boxed()
                .await?
                .unwrap_or(Value::Null),
            "release" => Value::Bool(
                repository
                    .release_unadmitted(&owner, &chat, &text(&input["claimId"])?)
                    .boxed()
                    .await?,
            ),
            "start-receipt" => repository
                .start_receipt(
                    &owner,
                    &input["worker"],
                    &input["session"],
                    &text(&input["claimId"])?,
                )
                .boxed()
                .await?
                .unwrap_or(Value::Null),
            "import" => repository.import_native(&owner, content).boxed().await?,
            "ack-import" => {
                repository
                    .acknowledge_import(&owner, content)
                    .boxed()
                    .await?
            }
            "pending-dispatches" => Value::Array(repository.pending_dispatches().boxed().await?),
            "pending-notifications" => Value::Array(
                repository
                    .pending_notifications(input.get("limit").and_then(Value::as_f64))
                    .boxed()
                    .await?,
            ),
            "ack-notification" => {
                repository
                    .acknowledge_notification(
                        &chat,
                        input["revision"]
                            .as_f64()
                            .context("Notification revision")?,
                    )
                    .boxed()
                    .await?;
                Value::Null
            }
            "defer-notification" => {
                repository.defer_notification(&chat).boxed().await?;
                Value::Null
            }
            _ => anyhow::bail!("Unknown managed queue fixture action"),
        },
    )
}
