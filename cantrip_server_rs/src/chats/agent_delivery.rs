//! One owned transaction admits the recipient input and both opaque history copies.
use super::{Repository, message_queries::MessageKind, message_writes};
use crate::{
    database::Executor,
    native_commands::transaction::TransactionRepository,
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context, Result};

fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Delivery identity")?
        .lossy()
        .into_owned())
}

#[derive(Debug)]
pub(crate) enum DeliveryError {
    ReceiverUnavailable,
    ModelRequired,
}
impl std::fmt::Display for DeliveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::ReceiverUnavailable => "The receiving chat is unavailable.",
            Self::ModelRequired => "Choose a model in the receiving chat first.",
        })
    }
}
impl std::error::Error for DeliveryError {}

pub(crate) fn receiver(context: Option<Value>, project: &Value) -> Result<Value> {
    context
        .filter(|c| {
            c["contextKind"] == "project"
                && c["projectId"] == *project
                && c["experience"] == "agent"
        })
        .ok_or_else(|| DeliveryError::ReceiverUnavailable.into())
}
impl Repository {
    pub(crate) async fn deliver_agent_message(
        &self,
        owner: &str,
        source: &Value,
        target: &str,
        input: &Value,
    ) -> Result<(Value, Value)> {
        let (owner, source, target, input) = (
            owner.to_owned(),
            source.clone(),
            target.to_owned(),
            input.clone(),
        );
        self.database.transaction(|tx| Box::pin(async move {
            let sender = text(&source["chatId"])?;
            // Source locks the owning project first, then the owned chat IDs in
            // stable order. Opposite-direction deliveries serialize on the project.
            tx.query("WITH locked_project AS MATERIALIZED (SELECT projects.id FROM projects INNER JOIN chats ON chats.project_id=projects.id WHERE projects.owner_id=$1 AND chats.id=$2 FOR UPDATE OF projects) SELECT chats.id FROM locked_project INNER JOIN chats ON chats.project_id=locked_project.id WHERE chats.id=$2 FOR UPDATE OF chats", &[&owner,&sender]).await?;
            tx.query("SELECT id FROM chats WHERE owner_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE", &[&owner,&vec![sender.clone(),target.clone()]]).await?;
            let executor = Executor::Transaction(tx);
            let key = format!("agent-chat:{sender}:{target}:{}", text(&input["operationId"])?);
            let received = message_writes::owned_key(executor,&owner,&target,&format!("{key}:received"),MessageKind::Encrypted).await?;
            let sent = message_writes::owned_key(executor,&owner,&sender,&format!("{key}:sent"),MessageKind::Encrypted).await?;
            if let (Some(received), Some(sent)) = (received, sent) {
                return Ok((received, sent));
            }
            let repository = TransactionRepository::new(tx);
            let current = receiver(repository.execution_context(&owner,&target).await?,&source["projectId"])?;
            let configuration = &current["modelConfiguration"];
            let model = if configuration["modelId"].is_null() {
                Value::from_serialize(&crate::settings::repository::SettingsRepository::user_settings_with(
                    executor,&owner,Some((super::mcp_read_queries::sql("settings"),&[json!(owner),json!(1)]))
                ).await?["defaultModelId"])
            } else { configuration["modelId"].clone() };
            if !truthy(Some(&model)) { return Err(DeliveryError::ModelRequired.into()); }
            let mut pending = input["turn"]["message"].clone();
            pending["reasoningEffort"] = configuration["reasoningEffort"].clone();
            let mut prompt = input["turn"]["queuedPrompt"].clone();
            for (key,value) in configuration.as_object().context("Receiver model configuration")? {
                prompt[key.as_str().context("Model configuration key")?] = value.clone();
            }
            prompt["modelId"] = model;
            prompt["pendingMessage"] = pending;
            let queued = repository.add_gui_prompt(&owner,&current,&prompt,&json!({"operationId":format!("agent-chat:queue:{sender}:{target}:{}",text(&input["operationId"])?),"resumeAutonomy":false})).await?;
            let queued = if queued["acceptedItem"].is_null() {
                repository.encrypted_prompt(&owner,&text(&prompt["id"])?).await?
            } else { Some(queued["acceptedItem"].clone()) };
            anyhow::ensure!(queued.is_some(), "The receiving chat could not queue the message.");
            let received = message_writes::append_for_mcp(tx,&owner,&target,&input["receivedMessage"]).await?;
            let sent = message_writes::append_for_mcp(tx,&owner,&sender,&input["sentMessage"]).await?;
            match (received,sent) {
                (Some(received),Some(sent)) => Ok((received,sent)),
                _ => anyhow::bail!("Agent message history could not be saved."),
            }
        })).await
    }
}
