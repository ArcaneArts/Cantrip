//! Opaque output uses the exact owned durable runtime and worker identity.
use super::lifecycle::ApiError;
use crate::{
    auth::service::AuthService,
    wire::{Value, value::json},
};
use anyhow::{Context, Result, bail};

pub async fn read(
    service: &AuthService,
    runtime: Option<&Value>,
    input: &Value,
    os_source: Option<&Value>,
) -> Result<Value> {
    let runtime = runtime
        .filter(|row| !row["terminalId"].is_null())
        .ok_or_else(|| ApiError {
            status: 404,
            code: "not-found",
            mcp_code: None,
            message: "Run configuration runtime not found.".into(),
        })?;
    let worker = runtime["workerId"].as_str().context("Run worker")?;
    if !service.workers.bridge.is_connected(worker) {
        return Err(ApiError {
            status: 503,
            code: "unavailable",
            mcp_code: None,
            message: "The Run configuration worker is offline.".into(),
        }
        .into());
    }
    let mut identity = Value::Object(Default::default());
    for (key, field) in [
        ("runtimeId", "id"),
        ("projectId", "projectId"),
        ("configurationId", "configurationId"),
        ("worktreeId", "worktreeId"),
        ("workerId", "workerId"),
        ("definitionRevision", "definitionRevision"),
        ("codexEnvironmentRevision", "codexEnvironmentRevision"),
        ("generation", "generation"),
        ("operationId", "requestedOperationId"),
        ("terminalId", "terminalId"),
    ] {
        identity[key] = runtime[field].clone();
    }
    let mut command = json!({"type":"project.run-configuration-runtime.output","requestOperationId":input["operationId"],"serverId":service.server_id,"identity":identity,"tail":input["tail"]});
    if let Some(source) = os_source {
        command["type"] = json!("cantrip-os.run-runtime.output");
        command["definitions"] = source["osExecution"]["definitions"].clone();
        command["target"] = source["osExecution"]["target"].clone();
    }
    let response = service
        .workers
        .commands
        .request(worker, command, None, None)
        .await?;
    let response = crate::settings::parse_response(
        "protectedRunConfigurationRuntimeWorkerOutputSchema",
        response.as_ref(),
    )?;
    if response["requestOperationId"] != input["operationId"] || response["identity"] != identity {
        bail!("The Run configuration output response was misrouted.");
    }
    crate::settings::parse_response(
        "protectedRunConfigurationRuntimeOutputResultSchema",
        Some(
            &json!({"operationId":input["operationId"],"projectId":runtime["projectId"],"configurationId":runtime["configurationId"],"worktreeId":runtime["worktreeId"],"generation":runtime["generation"],"protectedOutput":response["protectedOutput"]}),
        ),
    )
}
