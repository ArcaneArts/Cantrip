//! Bind worker and CLI Run content to the same server, project and resource keys.
use cantrip_wire::{JsString, Value, value::json};

pub(crate) const SECRET_SCHEMA: &str = "runConfigurationSecretValueContentSchema";
pub(crate) const SECRET_LIMIT: usize = 64 * 1024 + 128;
pub(crate) const OUTPUT_SCHEMA: &str = "runConfigurationRuntimeOutputContentSchema";

pub(crate) fn secret(owner: &JsString, project: &Value, reference: &Value, revision: u64) -> Value {
    json!({
        "ownerId":owner,"component":"run-content","table":"run_configuration_secrets",
        "rowId":json!([project, reference]).stringify(),"field":"protected_value","keyRevision":revision,
    })
}

pub(crate) fn output(server: &Value, target: &Value, operation: &Value) -> Value {
    json!({
        "domain":"run-content","workerId":Value::Null,"serverId":server,
        "scopeId":json!([&target["projectId"], &target["worktreeId"]]).stringify(),
        "operationId":operation,"operation":"run.configuration.output","direction":"response","sequence":0,
    })
}
