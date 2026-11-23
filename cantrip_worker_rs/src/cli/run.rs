//! The CLI can see its authorized Run inputs and output. Core receives envelopes.
use super::server::Relay;
use crate::{encryption::Service, http::checked, run_runtime::protection};
use anyhow::{Context, Result, anyhow};
use cantrip_wire::{Value, value::json};

pub(super) async fn logs(
    server: &Relay<'_>,
    encryption: &Service,
    request: Value,
    id: &str,
) -> Result<Value> {
    let mut result = server.execute(request, id).await?;
    let wire = checked(
        "protectedRunConfigurationRuntimeOutputResultSchema",
        &result["data"],
    )?;
    result["data"] = protection::open_output(encryption, &encryption.server_identity()?, &wire)?;
    checked("cantripCliCommandResultSchema", &result)
}

pub(super) async fn set_secret(
    server: &Relay<'_>,
    encryption: &Service,
    request: Value,
    id: &str,
) -> Result<Value> {
    let reference = request["arguments"]["reference"]
        .as_js_string()
        .filter(|reference| (1..=256).contains(&reference.units().len()))
        .context("The Run secret reference is invalid.")?;
    let secret = checked(
        protection::SECRET_SCHEMA,
        &json!({
            "version":1,"value":request["arguments"]["value"],
        }),
    )?;
    let context = server
        .execute(
            json!({"command":"status","context":request["context"],"arguments":json!({})}),
            &format!("{id}:context"),
        )
        .await?;
    let project = match context["target"]["projectId"] {
        Value::Null => &context["data"]["context"]["projectId"],
        ref project => project,
    };
    if project.is_null() {
        return Err(anyhow!(
            "Cantrip project context is required to store a secret."
        ));
    }
    let grant = encryption
        .bound_component("run-content", None)
        .map_err(|_| anyhow!("Run encryption is unavailable."))?;
    let protected =
        protection::protect_secret_value(&grant, project, &json!(reference), &secret["value"])?;
    let args = checked(
        "runConfigurationSecretSetRequestSchema",
        &json!({
            "operationId":id,"reference":reference,"protectedValue":protected,
        }),
    )?;
    server.execute(
        json!({
            "command":"run.secret-set","context":request["context"],
            "arguments":json!({"reference":args["reference"], "protectedValue":args["protectedValue"],"expectedProjectId":project}),
        }),
        id,
    ).await
}
