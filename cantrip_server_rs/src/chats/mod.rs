//! Durable Chat catalogs, state, retention and execution bindings.
pub mod account_failover;
mod archive;
pub mod automatic_title;
pub mod automation_pause;
pub mod catalog;
mod context;
pub mod eligibility;
pub mod execution_lanes;
pub mod execution_services;
pub mod forks;
pub mod goals;
pub mod guard;
pub mod live_mutations;
pub mod managed_console;
pub mod managed_preparation;
mod mcp;
pub mod message_queries;
pub mod message_writes;
mod messages;
mod model_configuration;
mod native_history;
pub mod protect_input;
pub mod recovery;
pub mod roots;
pub mod routing;
mod runtime;
pub mod runtime_quota;
pub mod runtime_telemetry;
mod state;
mod summary;
pub mod task_recovery;
pub mod turn_behavior;
pub mod turn_configuration;
pub mod turn_placement;
pub mod turn_runtime;
pub mod turn_storage;
mod worktree_selection;
pub use runtime::RuntimeUpdate;

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
