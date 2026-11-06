//! Durable Chat catalogs, state, retention and execution bindings.
pub mod account_failover;
pub(crate) mod agent_delivery;
mod archive;
pub mod automatic_title;
pub mod automation_pause;
pub mod catalog;
pub(crate) mod computer_use_authority;
mod context;
pub mod conversations;
pub mod eligibility;
pub mod execution_lanes;
pub mod execution_services;
pub mod forks;
pub mod goals;
pub mod guard;
pub mod hydration;
pub mod imports;
pub mod live_mutations;
pub mod managed_console;
pub mod managed_preparation;
mod mcp;
mod mcp_delivery_queries;
pub(crate) mod mcp_read_queries;
pub mod message_queries;
pub mod message_writes;
mod messages;
mod model_configuration;
mod native_history;
pub mod native_suspensions;
pub mod protect_input;
pub mod recovery;
pub mod relocations;
pub mod roots;
pub mod routing;
mod runtime;
pub mod runtime_quota;
pub mod runtime_telemetry;
mod state;
mod summary;
pub mod task_creation;
mod task_pause;
pub mod task_recovery;
pub mod thread_sync;
pub mod turn_behavior;
pub mod turn_configuration;
pub mod turn_placement;
pub mod turn_runtime;
pub mod turn_storage;
mod worktree_selection;
pub use runtime::RuntimeUpdate;
pub(crate) use runtime::update_in_transaction as update_runtime_in_transaction;

use crate::database::Database;
use std::sync::Arc;

#[derive(Clone)]
pub struct Repository {
    database: Arc<Database>,
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
}
