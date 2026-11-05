//! Durable native command admission, receipts and execution recovery.
pub mod admission;
mod admit;
pub(crate) mod attachments;
pub mod context;
mod control;
mod dispatch;
mod event_context;
pub mod events;
mod inference_resources;
mod logical_completions;
mod logical_inputs;
pub mod managed_queue;
pub mod model_attribution;
mod pending;
pub mod permissions;
pub mod policy;
mod preparation;
mod queue;
pub(crate) use queue::changed as queue_state_changed;
pub mod queued_prompt;
pub mod receipt;
mod recovery;
pub mod runtime;
mod settings_evidence;
mod settings_observations;
pub mod settings_persistence;
pub mod settings_state;
mod settlement;
mod thread_observation;
pub mod transaction;
mod transport_evidence;
pub mod turns;
mod undispatched_gui;
use crate::database::Database;
use std::sync::Arc;
#[cfg(test)]
mod tests;
pub use crate::chats::guard::NativeCommandError as CommandError;

#[derive(Clone)]
pub struct Repository {
    database: Arc<Database>,
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
}
