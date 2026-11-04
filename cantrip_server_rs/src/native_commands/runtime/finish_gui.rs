use crate::{
    native_commands::{Repository, admit::text},
    wire::Value,
    workers::command_bus::LimitedCommandBus,
};
use anyhow::Result;
use std::sync::Arc;

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
        status,
        false,
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
    status: &str,
    transport_ended: bool,
    on_acknowledgment_error: &(dyn Fn(anyhow::Error) + Send + Sync),
) -> Result<bool> {
    let operation = text(&receipt["operationId"])?;
    let generation = text(&receipt["operationGeneration"])?;
    let finished = repository
        .finish_logical_gui_with_transport(
            owner,
            worker,
            &operation,
            &generation,
            status,
            transport_ended,
        )
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
