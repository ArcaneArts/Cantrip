//! Server identity, singleton, and application error adapters.
use crate::wire::{Value, value::json};
pub use cantrip_logging::logging::*;
use std::sync::{Arc, OnceLock};

pub fn server() -> &'static Arc<Emitter> {
    static LOGGER: OnceLock<Arc<Emitter>> = OnceLock::new();
    LOGGER.get_or_init(|| {
        Emitter::with_console_context(
            "server".into(),
            Arc::new(|| chrono::Utc::now().timestamp_millis() as f64),
            Arc::new(super::log_runtime::capture_with_undefined),
        )
    })
}
pub fn server_logger() -> Logger {
    Arc::new(|call| {
        server()
            .dispatch(call)
            .expect("valid server operational record")
    })
}
pub fn error_details(error: &anyhow::Error) -> Value {
    use crate::workers::command_bus::CommandFailure;
    let bridge = match error.downcast_ref::<CommandFailure>() {
        Some(CommandFailure::Bridge(error)) => Some(error),
        _ => error.downcast_ref::<crate::workers::bridge::CommandError>(),
    };
    let name =
        if let Some(error) = error.downcast_ref::<crate::config::ConfigError>() {
            error.name
        } else if bridge.is_some_and(|error| error.encoding_error.is_some())
            || super::shared_failure::downcast_ref::<crate::settings::ResponseValidationError>(
                error,
            )
            .is_some()
        {
            "ZodError"
        } else if super::shared_failure::downcast_ref::<
            crate::settings::reasoning::ConfigurationFailure,
        >(error)
        .is_some()
        {
            "ModelConfigurationResolutionError"
        } else {
            "Error"
        };
    let mut raw = json!({"name":name,"message":crate::settings::operation_error_message(error)});
    if let Some(code) = bridge.and_then(|error| error.code.as_ref()) {
        raw["code"] = json!(code);
    }
    super::log_sanitize::error(Some(&raw))
}
