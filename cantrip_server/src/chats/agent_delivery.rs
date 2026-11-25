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
    SenderUnavailable,
    OperationConflict,
}
impl std::fmt::Display for DeliveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::ReceiverUnavailable => "The receiving chat is unavailable.",
            Self::ModelRequired => "Choose a model in the receiving chat first.",
            Self::SenderUnavailable => "The sending Council turn is no longer active.",
            Self::OperationConflict => {
                "This Council delivery ID already belongs to another target or delivery mode."
            }
        })
    }
}

pub(crate) struct Delivered {
    pub(crate) received_id: Value,
    pub(crate) input_id: Value,
    pub(crate) messages: Vec<Value>,
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
        project: &Value,
        input: &Value,
        steer: bool,
    ) -> Result<Delivered> {
        let (owner, source, target, project, input) = (
            owner.to_owned(),
            source.clone(),
            target.to_owned(),
            project.clone(),
            input.clone(),
        );
        self.database.transaction(|tx| Box::pin(async move {
            let sender = text(&source["chatId"])?;
            // Use the destination's project lock before locking either chat.
            if tx.query("SELECT id FROM projects WHERE owner_id=$1 AND id=$2 FOR UPDATE", &[&owner,&text(&project)?]).await?.is_empty() {
                return Err(DeliveryError::ReceiverUnavailable.into());
            }
            tx.query("SELECT id FROM chats WHERE owner_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE", &[&owner,&vec![sender.clone(),target.clone()]]).await?;
            let executor = Executor::Transaction(tx);
            let operation = text(&input["operationId"])?;
            let council = source.get("councilAgent").is_some();
            let repository = TransactionRepository::new(tx);
            if council {
                let current = repository.execution_context(&owner, &sender).await?;
                if !current.is_some_and(|current| current.get("councilAgent").is_some()
                    && current["workerId"] == source["workerId"]
                    && current["executionLaneId"] == source["executionLaneId"]
                    && current["threadId"] == source["threadId"]
                    && super::managed_console::permission_profile(&current)["effectiveId"] != ":read-only"
                    && matches!(current["status"].as_str(), Some("running" | "waiting-for-approval"))) {
                    return Err(DeliveryError::SenderUnavailable.into());
                }
                let earlier = tx.query("SELECT target_chat_id,input_message_id,received_message_id,steer_requested FROM council_project_deliveries WHERE source_chat_id=$1 AND operation_id=$2::text::uuid", &[&sender,&operation]).await?;
                if let Some(earlier) = earlier.first() {
                    if earlier.get::<&str>(0)? != target || earlier.get::<bool>(3)? != steer { return Err(DeliveryError::OperationConflict.into()); }
                    return Ok(Delivered {input_id:json!(earlier.get::<&str>(1)?),received_id:json!(earlier.get::<&str>(2)?),messages:Vec::new()});
                }
            }
            let key = format!("agent-chat:{sender}:{target}:{operation}");
            let received = message_writes::owned_key(executor,&owner,&target,&format!("{key}:received"),MessageKind::Encrypted).await?;
            let sent = message_writes::owned_key(executor,&owner,&sender,&format!("{key}:sent"),MessageKind::Encrypted).await?;
            if let (Some(received), Some(sent)) = (received, sent) {
                return Ok(Delivered {received_id: received["id"].clone(),input_id:input["turn"]["message"]["id"].clone(),messages:vec![received,sent]});
            }
            let current = receiver(repository.execution_context(&owner,&target).await?,&project)?;
            let configuration = &current["modelConfiguration"];
            let model = if configuration["modelId"].is_null() {
                Value::from_serialize(&crate::settings::repository::SettingsRepository::user_settings_with(
                    executor,&owner,Some((super::mcp_read_queries::sql("settings"),&[json!(owner),json!(1)]))
                ).await?["defaultModelId"])
            } else { configuration["modelId"].clone() };
            if !truthy(Some(&model)) { return Err(DeliveryError::ModelRequired.into()); }
            let mut pending = input["turn"]["message"].clone();
            let input_id = pending["id"].clone();
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
                (Some(received),Some(sent)) => {
                    let received_id = received["id"].clone();
                    if council {
                        tx.query("INSERT INTO council_project_deliveries(source_chat_id,target_chat_id,operation_id,input_message_id,received_message_id,queued_prompt_id,steer_requested) VALUES($1,$2,$3::text::uuid,$4,$5,$6,$7)", &[&sender,&target,&operation,&text(&input_id)?,&text(&received_id)?,&text(&prompt["id"])?,&steer]).await?;
                    }
                    Ok(Delivered { input_id,received_id,messages:vec![received,sent] })
                }
                _ => anyhow::bail!("Agent message history could not be saved."),
            }
        })).await
    }
}
