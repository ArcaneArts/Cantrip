pub mod bridge;
pub mod command_bus;
pub(crate) use cantrip_transport::command_deadline;
pub mod coordinated;
pub mod credentials;
pub(crate) use cantrip_transport::frames;
pub(crate) mod inference_failure;
pub mod limits;
pub mod maintenance;
pub mod management;
pub(crate) use cantrip_transport::notifications;
pub(crate) use cantrip_transport::offline;
pub(crate) use cantrip_transport::output;
pub mod repository;
pub mod request;
pub(crate) mod resource_revocations;
mod rows;
pub mod service;
pub mod transport;

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
