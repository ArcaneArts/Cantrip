//! Durable Chat catalogs, state, retention and execution bindings.
mod archive;
pub mod catalog;
mod context;
pub mod eligibility;
pub mod forks;
pub mod guard;
pub mod managed_console;
mod mcp;
mod messages;
pub mod roots;
pub mod routing;
mod runtime;
mod state;
mod summary;
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
