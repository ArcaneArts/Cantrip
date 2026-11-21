//! Bind Run content to the same server, project and resource keys.
use crate::{
    encryption::{BoundComponentKey, Service},
    protected_content::open_endpoint_content,
};
use anyhow::Result;
use cantrip_crypto::content::encrypt_secret;
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

pub(crate) fn protect_secret_value(
    grant: &BoundComponentKey,
    project: &Value,
    reference: &Value,
    value: &Value,
) -> Result<Value> {
    encrypt_secret(
        &grant.component.key,
        &secret(
            &grant.owner_id,
            project,
            reference,
            grant.component.key_revision,
        ),
        &json!({"version":1,"value":value}),
        SECRET_SCHEMA,
        Some(SECRET_LIMIT),
    )
}

pub(crate) fn open_output(encryption: &Service, server: &Value, wire: &Value) -> Result<Value> {
    let content = open_endpoint_content(
        encryption,
        &output(server, wire, &wire["operationId"]),
        &wire["protectedOutput"],
        OUTPUT_SCHEMA,
    )?;
    Ok(json!({
        "operationId":wire["operationId"],"projectId":wire["projectId"],
        "configurationId":wire["configurationId"],"worktreeId":wire["worktreeId"],
        "generation":wire["generation"],"data":content["data"],"truncated":content["truncated"],
    }))
}
