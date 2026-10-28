//! Settings, provider and model state. Stored secrets remain opaque envelopes.
mod account_catalog;
mod account_observations;
pub mod account_service;
pub mod accounts;
pub mod agent_time;
pub mod authentication;
pub mod catalog;
mod catalog_hash;
pub mod catalog_runtime;
pub mod chatgpt;
pub mod credential_migrations;
pub mod enrichment;
pub mod grok;
pub mod lifecycle;
mod models;
pub mod ollama;
pub mod openrouter;
mod providers;
mod query_error;
pub mod quota;
mod raw_identifiers;
pub mod reasoning;
pub mod repository;
pub mod zai;

pub use providers::normalize_responses_base_url;
pub(crate) use query_error::SettingsQueryError;

pub(crate) fn parse_response(
    schema: &str,
    value: Option<&crate::wire::Value>,
) -> anyhow::Result<crate::wire::Value> {
    crate::wire::parse(schema, value).map_err(response_error)
}
pub(crate) fn response_error(error: crate::wire::ValidationError) -> anyhow::Error {
    match error {
        crate::wire::ValidationError::Invalid(issues) => {
            anyhow::Error::msg(crate::wire::Value::Array(issues).stringify_pretty())
        }
        crate::wire::ValidationError::Operation => {
            anyhow::anyhow!("Settings response validation failed.")
        }
    }
}
