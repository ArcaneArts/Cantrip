//! Worker endpoint identity, authenticated grants and owned refresh lifetime.
mod identity;
mod service;
mod state;
use cantrip_wire::JsString;
pub use identity::{Identity, IdentityError};
pub use service::{RequestedGrant, Service};
pub use state::ComponentKey;

#[derive(Clone, Debug)]
pub struct ServiceError {
    pub code: Option<&'static str>,
    pub message: JsString,
}
impl ServiceError {
    pub fn new(code: &'static str, message: impl Into<JsString>) -> Self {
        Self {
            code: Some(code),
            message: message.into(),
        }
    }
    pub fn stopped() -> Self {
        Self::new("server-unavailable", "Worker encryption refresh stopped.")
    }
}
impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message.lossy())
    }
}
impl std::error::Error for ServiceError {}
impl From<anyhow::Error> for ServiceError {
    fn from(error: anyhow::Error) -> Self {
        Self {
            code: error.downcast_ref::<IdentityError>().map(|e| e.code),
            message: error.to_string().into(),
        }
    }
}
