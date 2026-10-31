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
pub mod native_inventory;
pub mod ollama;
pub mod openrouter;
mod providers;
mod query_error;
pub mod quota;
mod quota_query_error;
mod raw_identifiers;
pub mod reasoning;
pub mod repository;
pub mod telemetry;
pub mod zai;

pub use providers::normalize_responses_base_url;
pub(crate) use query_error::SettingsQueryError;

// These callers already require finite, nonnegative values. Windows GNU CI
// observed f64::round mapping the number immediately below 0.5 to 1. Compare
// the remainder without adding 0.5, which can lose that distinction. The source
// uses Math.round.
pub(super) fn round_nonnegative(value: f64) -> f64 {
    let lower = value.floor();
    if value - lower < 0.5 {
        lower
    } else {
        lower + 1.0
    }
}

pub(crate) fn operation_error_message(error: &anyhow::Error) -> crate::wire::JsString {
    use crate::{
        wire::{ValidationError, Value},
        workers::command_bus::CommandFailure,
    };
    match error.downcast_ref::<CommandFailure>() {
        Some(CommandFailure::Bridge(error)) => match error.encoding_error.as_deref() {
            Some(ValidationError::Invalid(issues)) => {
                Value::Array(issues.clone()).stringify_pretty().into()
            }
            _ => error.message.clone(),
        },
        Some(command) => command.message(),
        None => error
            .downcast_ref::<SettingsQueryError>()
            .map(|error| error.message.clone())
            .unwrap_or_else(|| error.to_string().into()),
    }
}

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
