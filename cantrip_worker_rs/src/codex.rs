//! Native Codex integration. Discovery does not admit execution or model input.
pub(crate) mod account_auth;
pub mod admission;
pub mod catalog;
pub mod diagnostics;
pub mod discovery;
pub mod managed;
pub(crate) mod observation;
pub mod private_inference;
pub mod process_transport;
pub mod provider_errors;
pub mod rpc_client;
pub mod rpc_protocol;
pub mod rpc_requests;
pub mod session;
pub mod startup;
