//! Execution evidence comes only from an authenticated correlated worker response.
use crate::{
    operations::shared_failure::downcast_ref,
    wire::Value,
    workers::{bridge::CommandError, command_bus::CommandFailure},
};

pub(crate) fn evidence(error: &anyhow::Error) -> Option<&Value> {
    let command = downcast_ref::<CommandFailure>(error)
        .and_then(|failure| match failure {
            CommandFailure::Bridge(command) => Some(command),
            _ => None,
        })
        .or_else(|| downcast_ref::<CommandError>(error))?;
    if command.unavailable
        || command.request_id.is_none()
        || command.code.as_deref() == Some("worker-command-timeout")
    {
        return None;
    }
    // The bridge attaches this validated field only to actual chat.turn replies.
    command.inference.as_deref()
}
