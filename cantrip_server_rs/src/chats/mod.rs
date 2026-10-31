//! Durable chat execution bindings shared by Live and managed consoles.
pub mod catalog;
mod context;
pub mod eligibility;
pub mod guard;
pub mod managed_console;
mod mcp;
pub mod roots;
pub mod routing;
mod runtime;
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
