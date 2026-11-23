use crate::wire::Value;

/// Observed command transport closure; it says nothing about native execution.
pub(super) fn is_transport_closure(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(fields)) if fields.len() == 2)
        && value.is_some_and(|v| v["kind"] == "transport-ended" && v["source"] == "worker-command")
}
