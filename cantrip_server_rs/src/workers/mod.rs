pub mod bridge;
pub mod command_bus;
pub mod credentials;
pub mod limits;
pub mod maintenance;
mod notifications;
pub mod repository;
pub mod request;
mod rows;
pub mod service;

use std::fmt;

#[derive(Debug)]
pub struct WorkerEnrollmentError(pub &'static str);
impl fmt::Display for WorkerEnrollmentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for WorkerEnrollmentError {}

pub const DEFAULT_CREDENTIAL_SCOPES: [&str; 4] = [
    "worker:connect",
    "worker:heartbeat",
    "worker:automations",
    "worker:agent-tools",
];
