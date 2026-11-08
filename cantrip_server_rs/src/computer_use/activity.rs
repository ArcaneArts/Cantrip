use super::Service;
use crate::{
    chats::{live_mutations::MessageOptions, message_queries::MessageKind},
    wire::Value,
};
use anyhow::{Result, ensure};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

pub struct Activity {
    service: Arc<Service>,
    owner: String,
    chat: String,
    operation: String,
    domain: Option<&'static str>,
    published: AtomicBool,
}
impl Activity {
    pub fn new(
        service: Arc<Service>,
        owner: String,
        chat: String,
        operation: String,
        domain: Option<&'static str>,
    ) -> Self {
        Self {
            service,
            owner,
            chat,
            operation,
            domain,
            published: AtomicBool::new(false),
        }
    }
    pub async fn publish(&self, event: &Value) -> Result<()> {
        let event = crate::settings::parse_response("computerUseActivityEventSchema", Some(event))?;
        let nested = &event["event"];
        let task = nested["type"] == "agent.protected-task-message";
        let domain = if task { "task" } else { "chat" };
        ensure!(
            event["operationId"] == self.operation.as_str()
                && self.domain.is_none_or(|expected| expected == domain)
                && nested["telemetry"]["kind"] == "activity"
                && nested["telemetry"]["activityType"] == "computerUse"
                && nested["telemetry"]["turnId"] == Value::Null
                && nested["message"]["classification"]["role"] == "assistant"
                && nested["message"]["classification"]["attachmentIds"]
                    .as_array()
                    .is_some_and(|items| items.is_empty())
                && !self.published.swap(true, Ordering::AcqRel),
            "Invalid computer-use activity publication."
        );
        let saved = self
            .service
            .mutations
            .write_message(
                &self.owner,
                &self.chat,
                &nested["message"],
                MessageOptions {
                    attribution: None,
                    kind: if task {
                        MessageKind::Task
                    } else {
                        MessageKind::Encrypted
                    },
                    upsert: true,
                    routing: None,
                },
            )
            .await?;
        ensure!(
            saved.is_some(),
            "Computer-use activity publication was rejected."
        );
        Ok(())
    }
}
