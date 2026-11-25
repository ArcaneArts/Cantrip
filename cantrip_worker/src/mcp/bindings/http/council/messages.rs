use super::{Authorized, Service, resource_id};
use crate::chat_content::Scope;
use anyhow::{Context, Result, ensure};
use cantrip_history::content::Encryption;
use cantrip_wire::{Value, value::json};
use std::sync::Arc;
use uuid::Uuid;

pub(super) fn protect(
    service: Arc<Service>,
    authorization: &Authorized,
    chat: &Value,
    input: &Value,
) -> Result<Value> {
    let scope = Scope::new(service)?;
    let identity = scope.identity()?;
    ensure!(
        identity == authorization.identity,
        "The worker binding changed before posting a Council message."
    );
    let operation = input["operationId"]
        .as_str()
        .context("Council message operation")?;
    let id = resource_id(
        identity.0.as_str().context("Council owner")?,
        chat.as_str().context("Council chat")?,
        Uuid::parse_str(operation)?,
        "council-message",
    )
    .to_string();
    let phase = (input["kind"] == "progress").then_some("commentary");
    let message = scope.protect(&json!({
        "id":id,"role":"assistant","idempotencyKey":format!("council-message:{operation}"),
        "content":vec![json!({"type":"text","text":input["text"],"phase":phase})],
    }))?;
    scope.identity()?;
    Ok(json!({"operationId":operation,"notify":input["notify"],"message":message}))
}
