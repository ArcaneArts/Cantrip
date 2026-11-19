//! The CLI can see its authorized Run inputs and output. Core receives envelopes.
use super::server::Relay;
use crate::{
    encryption::Service, http::checked, protected_content::open_endpoint_content,
    run_runtime::protection,
};
use anyhow::{Context, Result, anyhow};
use cantrip_crypto::content::encrypt_secret;
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
    let server_id = encryption.server_identity()?;
    let content = open_endpoint_content(
        encryption,
        &protection::output(&server_id, &wire, &wire["operationId"]),
        &wire["protectedOutput"],
        protection::OUTPUT_SCHEMA,
    )?;
    result["data"] = json!({
        "operationId":wire["operationId"],"projectId":wire["projectId"],"configurationId":wire["configurationId"],
        "worktreeId":wire["worktreeId"],"generation":wire["generation"],"data":content["data"],"truncated":content["truncated"],
    });
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
    let protected = encrypt_secret(
        &grant.component.key,
        &protection::secret(
            &grant.owner_id,
            project,
            &json!(reference),
            grant.component.key_revision,
        ),
        &secret,
        protection::SECRET_SCHEMA,
        Some(protection::SECRET_LIMIT),
    )?;
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
