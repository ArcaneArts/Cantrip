//! Existing first-party communication and Task payload formats. No grant or network policy.
use super::{aad, authenticate, decode_json, encode_json, open_field, seal_field};
use crate::{checked, decryption_error};
use anyhow::Result;
use cantrip_wire::{Value, value::json};

#[derive(Clone, Copy)]
pub enum Communication {
    Message,
    Task,
    TaskPlanningRound,
    TaskMessage,
    TaskGoalObjective,
    QueuedPrompt,
    ComposerDraft,
    Plan,
    InteractionRequest,
    InteractionResponse,
}
struct Format {
    component: &'static str,
    table: &'static str,
    field: &'static str,
    id: &'static str,
    content: &'static str,
    envelope: &'static str,
    classification: Option<&'static str>,
    limit: usize,
}
impl Communication {
    fn format(self) -> Format {
        let (component, table, field, id, content, envelope, classification, limit) = match self {
            Self::Message => (
                "chat-content",
                "chat_messages",
                "protected_content",
                "messageId",
                "chatMessageProtectedContentSchema",
                "encryptedChatMessageProtectedContentSchema",
                Some("chatMessageProtectedClassificationSchema"),
                2 * 1024 * 1024,
            ),
            Self::Task => (
                "task-content",
                "tasks",
                "protected_content",
                "chatId",
                "taskProtectedContentSchema",
                "encryptedTaskProtectedContentSchema",
                Some("taskProtectedClassificationSchema"),
                4 * 1024 * 1024,
            ),
            Self::TaskPlanningRound => (
                "task-content",
                "task_planning_rounds",
                "protected_content",
                "roundId",
                "taskPlanningRoundProtectedContentSchema",
                "encryptedTaskPlanningRoundProtectedContentSchema",
                Some("taskPlanningRoundProtectedClassificationSchema"),
                6 * 1024 * 1024,
            ),
            Self::TaskMessage => (
                "task-content",
                "chat_messages",
                "task_protected_content",
                "messageId",
                "taskMessageProtectedContentSchema",
                "encryptedTaskMessageProtectedContentSchema",
                Some("taskMessageProtectedClassificationSchema"),
                2 * 1024 * 1024,
            ),
            Self::TaskGoalObjective => (
                "task-content",
                "task_goal_snapshots",
                "objective",
                "threadId",
                "taskGoalObjectiveProtectedContentSchema",
                "encryptedTaskGoalObjectiveSchema",
                Some("taskGoalObjectiveProtectedClassificationSchema"),
                512 * 1024,
            ),
            Self::QueuedPrompt => (
                "chat-content",
                "queued_prompts",
                "protected_content",
                "promptId",
                "queuedPromptProtectedContentSchema",
                "encryptedQueuedPromptProtectedContentSchema",
                Some("queuedPromptProtectedClassificationSchema"),
                512 * 1024,
            ),
            Self::ComposerDraft => (
                "chat-content",
                "chats",
                "protected_composer_draft",
                "chatId",
                "chatComposerDraftProtectedContentSchema",
                "encryptedChatComposerDraftProtectedContentSchema",
                None,
                2 * 1024 * 1024,
            ),
            Self::Plan => (
                "chat-content",
                "chats",
                "protected_plan",
                "chatId",
                "chatPlanProtectedContentSchema",
                "encryptedChatPlanProtectedContentSchema",
                Some("chatPlanProtectedClassificationSchema"),
                1024 * 1024,
            ),
            Self::InteractionRequest => (
                "interaction-content",
                "agent_interaction_requests",
                "protected_payload",
                "requestKey",
                "interactionRequestProtectedContentSchema",
                "encryptedInteractionRequestContentSchema",
                Some("interactionProtectedClassificationSchema"),
                1024 * 1024,
            ),
            Self::InteractionResponse => (
                "interaction-content",
                "agent_interaction_requests",
                "protected_response",
                "requestKey",
                "interactionResponseProtectedContentSchema",
                "encryptedInteractionResponseContentSchema",
                Some("interactionProtectedClassificationSchema"),
                1024 * 1024,
            ),
        };
        Format {
            component,
            table,
            field,
            id,
            content,
            envelope,
            classification,
            limit,
        }
    }
}
pub fn communication_associated_data(kind: Communication, context: &Value) -> Result<Value> {
    let format = kind.format();
    let goal_row;
    let row = if matches!(kind, Communication::TaskGoalObjective) {
        goal_row =
            json!(json!([context["chatId"].clone(), context["threadId"].clone()]).stringify());
        &goal_row
    } else {
        &context[format.id]
    };
    aad(
        context,
        &json!(format.component),
        &json!(format.table),
        row,
        &json!(format.field),
    )
}
pub fn encrypt_communication(
    kind: Communication,
    component_key: &[u8],
    context: &Value,
    content: &Value,
) -> Result<Value> {
    let format = kind.format();
    let associated_data = communication_associated_data(kind, context)?;
    let bytes = encode_json(
        format.content,
        content,
        format.limit,
        if format.component == "task-content" {
            "Protected Task content exceeds its encoded byte limit."
        } else {
            "Protected communication content exceeds its byte limit."
        },
    )?;
    let envelope = seal_field(component_key, &associated_data, &bytes)?;
    checked(
        format.envelope,
        &json!({"formatVersion":1,"keyRevision":associated_data["keyRevision"],"envelope":envelope}),
    )
}
pub fn decrypt_communication(
    kind: Communication,
    component_key: &[u8],
    context: &Value,
    raw: &Value,
    public_classification: Option<&Value>,
) -> Result<Value> {
    let format = kind.format();
    // Public AAD validation precedes the normalized envelope boundary in Source.
    let associated_data = communication_associated_data(kind, context)?;
    let encrypted = authenticate(|| {
        let encrypted = checked(format.envelope, raw)?;
        if encrypted["keyRevision"] != associated_data["keyRevision"] {
            return Err(decryption_error());
        }
        Ok(encrypted)
    })?;
    let bytes = open_field(component_key, &associated_data, &encrypted["envelope"])?;
    let content = decode_json(format.content, &bytes, format.limit)?;
    if let Some(schema) = format.classification {
        authenticate(|| {
            let inner = checked(schema, &content["classification"])?;
            let outer = cantrip_protocol::response::parse_response(schema, public_classification)?;
            if inner.stringify() != outer.stringify() {
                return Err(decryption_error());
            }
            Ok(())
        })?;
    }
    Ok(content)
}
