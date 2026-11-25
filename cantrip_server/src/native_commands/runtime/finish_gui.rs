use crate::{
    native_commands::{Repository, admit::text},
    wire::Value,
    workers::command_bus::LimitedCommandBus,
};
use anyhow::Result;
use std::sync::Arc;

/// Outcome and transport evidence for one logical GUI closure.
pub struct GuiClosure<'a> {
    pub status: &'a str,
    pub transport_ended: bool,
    pub reply: Option<GuiReply<'a>>,
}

/// The protected final answer carried by the same worker outcome as the turn ID.
#[derive(Clone, Copy)]
pub struct GuiReply<'a> {
    pub thread_id: &'a str,
    pub turn_id: &'a str,
    pub message: &'a Value,
}

impl<'a> GuiReply<'a> {
    pub fn from_outcome(result: &'a Value, message: &'a Value) -> Option<Self> {
        Some(Self {
            thread_id: result["threadId"].as_str()?,
            turn_id: result["turnId"].as_str()?,
            message,
        })
    }
}

/// Commit the logical GUI closure before releasing its native successors.
pub async fn finish_managed_gui(
    repository: &Repository,
    commands: &Arc<LimitedCommandBus>,
    owner: &str,
    worker: &str,
    receipt: &Value,
    status: &str,
    on_acknowledgment_error: &(dyn Fn(anyhow::Error) + Send + Sync),
) -> Result<bool> {
    finish_managed_gui_with_transport(
        repository,
        commands,
        owner,
        worker,
        receipt,
        GuiClosure {
            status,
            transport_ended: false,
            reply: None,
        },
        on_acknowledgment_error,
    )
    .await
}

pub async fn finish_managed_gui_with_transport(
    repository: &Repository,
    commands: &Arc<LimitedCommandBus>,
    owner: &str,
    worker: &str,
    receipt: &Value,
    closure: GuiClosure<'_>,
    on_acknowledgment_error: &(dyn Fn(anyhow::Error) + Send + Sync),
) -> Result<bool> {
    let operation = text(&receipt["operationId"])?;
    let generation = text(&receipt["operationGeneration"])?;
    let finished = repository
        .finish_logical_gui_outcome(owner, worker, &operation, &generation, closure)
        .await?;
    let acknowledgment = async {
        if let Some(entry) = repository
            .get_logical_completion(
                owner,
                worker,
                &text(&receipt["chatId"])?,
                &operation,
                &generation,
            )
            .await?
        {
            super::logical_delivery::deliver(commands, &entry).await?;
            repository
                .acknowledge_logical_completion(
                    &text(&entry["ownerId"])?,
                    &text(&entry["workerId"])?,
                    &text(&entry["chatId"])?,
                    &text(&entry["rootOperationId"])?,
                    &text(&entry["rootOperationGeneration"])?,
                )
                .await?;
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;
    if let Err(error) = acknowledgment {
        on_acknowledgment_error(error);
    }
    Ok(finished)
}
