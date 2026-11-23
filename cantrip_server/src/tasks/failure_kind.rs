use crate::wire::Value;
pub use cantrip_protocol::task_retry::classify;

pub fn for_error(error: &anyhow::Error) -> &'static str {
    use crate::wire::value::json;
    use crate::{operations::shared_failure::downcast_ref, workers::command_bus::CommandFailure};
    if let Some(error) = crate::operations::shared_failure::downcast_ref::<
        crate::settings::reasoning::ConfigurationFailure,
    >(error)
    {
        return classify(&json!({"name":"ModelConfigurationResolutionError","failure":error.0}));
    }
    let mut value = json!({"message":crate::settings::operation_error_message(error)});
    if let Some(CommandFailure::Owner(error)) = downcast_ref::<CommandFailure>(error) {
        return for_error(error);
    }
    let bridge = match downcast_ref::<CommandFailure>(error) {
        Some(CommandFailure::Bridge(e)) => Some(e),
        _ => downcast_ref::<crate::workers::bridge::CommandError>(error),
    };
    if let Some(error) = bridge {
        value["code"] = error.code.as_ref().map(|v| json!(v)).unwrap_or(Value::Null);
    }
    if let Some(error) = downcast_ref::<crate::native_commands::CommandError>(error) {
        value["code"] = json!(error.code);
    }
    classify(&value)
}
