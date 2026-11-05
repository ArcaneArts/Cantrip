//! Serialized Run admission, Primary definition resolution and worker reconciliation.
use super::{Repository, secrets, text};
use crate::{
    auth::service::AuthService,
    projects::targets::TargetRepository,
    wire::{JsString, Value, value::json},
};
use anyhow::{Context, Result, bail};
use futures::{FutureExt, future::BoxFuture};
use std::{sync::Arc, time::Duration};

#[derive(Debug)]
pub struct ApiError {
    pub status: u16,
    pub code: &'static str,
    // The public API folds execution-lane conflicts into its conflict code.
    // MCP retains Source's distinct binding classification.
    pub mcp_code: Option<&'static str>,
    pub message: String,
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ApiError {}
fn api(status: u16, code: &'static str, message: impl Into<String>) -> anyhow::Error {
    ApiError {
        status,
        code,
        mcp_code: None,
        message: message.into(),
    }
    .into()
}
fn conflict(message: impl Into<String>) -> anyhow::Error {
    ApiError {
        status: 409,
        code: "conflict",
        mcp_code: Some("stale-binding"),
        message: message.into(),
    }
    .into()
}
fn invalidate(service: &AuthService, owner: &str, runtime: &Value) -> Result<()> {
    service.live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":runtime["projectId"]}),"resource":"run","action":"invalidated","entityId":runtime["id"],"revision":Value::Null,"payload":Value::Null}))?;
    Ok(())
}
async fn definition(service: &AuthService, owner: &str, input: &Value) -> Result<Value> {
    super::definitions::read(service, owner, "get", input).await
}

fn failed(
    identity: &Value,
    runtime: &Value,
    phase: &str,
    code: &str,
    message: JsString,
) -> Result<Value> {
    let mut observation = identity.clone();
    for (key,value) in json!({"state":"failed","startedAt":runtime["startedAt"],"endedAt":crate::auth::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"exitCode":Value::Null,"signal":Value::Null,"failure":json!({"phase":phase,"code":code,"message":message,"retryable":true})}).as_object().unwrap().iter() { observation[key.as_str().unwrap()]=value.clone(); }
    crate::settings::parse_response(
        "runConfigurationRuntimeWorkerObservationSchema",
        Some(&observation),
    )
}
async fn mark_failed(
    service: &AuthService,
    owner: &str,
    worker: &str,
    observation: &Value,
    always: bool,
) -> Result<()> {
    let applied = Repository::new(service.repository.database.clone())
        .observe(owner, worker, observation)
        .await?;
    if let Some(applied) = applied
        && (always || applied["applied"] == true)
        && !applied["runtime"]["terminalId"].is_null()
    {
        service
            .worker_maintenance
            .record_status(owner, text(&applied["runtime"], "terminalId")?, "failed")
            .await?;
        if !always {
            invalidate(service, owner, &applied["runtime"])?;
        }
    }
    Ok(())
}
pub fn operate(
    service: Arc<AuthService>,
    owner: String,
    input: Value,
) -> BoxFuture<'static, Result<Value>> {
    let coordinator = service.project_operations.clone();
    let project = input["projectId"].as_str().unwrap().to_owned();
    coordinator.serialize(&owner.clone(), &project, false, move || {
        execute(service, owner, input).boxed()
    })
}
async fn execute(service: Arc<AuthService>, owner: String, input: Value) -> Result<Value> {
    let repository = Repository::new(service.repository.database.clone());
    let project = text(&input, "projectId")?;
    let os_source = if input["osSource"].is_null() {
        None
    } else {
        let selection: serde_json::Value = serde_json::from_str(&input["osSource"].stringify())?;
        let selected = crate::cantrip_os::Repository::new(service.repository.database.clone())
            .selected_run(
                &owner,
                project,
                &selection,
                input["targetWorktreeId"].as_str(),
            )
            .await
            .map_err(|error| conflict(error.to_string()))?;
        let selected = Value::from_serialize(&selected);
        if !selected["runtime"].is_null()
            && selected["runtime"]["configurationId"] != input["configurationId"]
        {
            return Err(conflict(
                "The captured Linux Run belongs to another configuration.",
            ));
        }
        Some(selected)
    };
    let execution_key = os_source
        .as_ref()
        .map(|source| text(source, "executionKey"))
        .transpose()?
        .unwrap_or("worker");
    if let Some(replay) = repository
        .operation_result_in_execution(&owner, text(&input, "operationId")?, execution_key)
        .await?
    {
        if ["projectId", "configurationId", "operation"]
            .iter()
            .any(|key| replay["operation"][*key] != input[*key])
            || (!input["targetWorktreeId"].is_null()
                && replay["operation"]["worktreeId"] != input["targetWorktreeId"])
        {
            return Err(api(
                409,
                "conflict",
                "The Run configuration operation ID is already bound to another request.",
            ));
        }
        return crate::settings::parse_response(
            "runConfigurationRuntimeOperationResultSchema",
            Some(&replay),
        );
    }
    let target = if let Some(source) = os_source.as_ref() {
        json!({"workerId":source["osExecution"]["target"]["scope"]["workerId"],"worktree":json!({"id":source["osExecution"]["target"]["scope"]["worktreeId"]})})
    } else {
        let targets = TargetRepository::new(service.repository.database.clone());
        let target = if let Some(target) = input["targetWorktreeId"].as_str() {
            target.to_owned()
        } else {
            let primary = targets
                .observation_source(&owner, project, &|id| {
                    service.workers.bridge.is_connected(id)
                })
                .await?
                .ok_or_else(|| {
                    api(
                        404,
                        "not-found",
                        "The project Primary source was not found.",
                    )
                })?;
            text(&primary, "worktreeId")?.to_owned()
        };
        targets
            .worktree_context(&owner, project, &target)
            .await?
            .filter(|v| v["worktree"]["lifecycleState"] == "ready")
            .ok_or_else(|| {
                api(
                    404,
                    "not-found",
                    "The Run configuration target worktree is not ready.",
                )
            })?
    };
    let worker = text(&target, "workerId")?;
    if !service.workers.bridge.is_connected(worker) {
        return Err(api(
            503,
            "unavailable",
            "The Run configuration target worker is offline.",
        ));
    }
    service.run_configuration_observations.subscribe(worker);
    let mut revision = Value::Null;
    let mut codex_revision = Value::Null;
    let mut protected = Vec::new();
    if input["operation"] != "stop" {
        let definition = if let Some(source) = os_source.as_ref() {
            let d = &source["osExecution"]["definitions"]["scope"];
            let request = serde_json::json!({"runtimeGeneration":text(d,"runtimeGeneration")?,"request":{"type":"project.run-configuration-definitions.get","operationId":text(&input,"operationId")?,"projectId":project,"configurationId":text(&input,"configurationId")?}});
            let response = crate::cantrip_os::coordinator::Coordinator::new(service.clone())
                .run_definition(&owner, project, text(d, "bindingId")?, &request)
                .await?;
            crate::settings::parse_response(
                "runConfigurationGetResponseSchema",
                Some(&Value::from_serialize(&response["result"])),
            )?
        } else {
            definition(&service, &owner, &input).await?
        };
        if definition["result"]["found"] != true {
            return Err(api(
                404,
                "not-found",
                "The Run configuration definition was not found in Primary.",
            ));
        }
        let entry = &definition["result"]["entry"];
        if entry["status"] != "ready" || entry["revision"].is_null() || entry["document"].is_null()
        {
            return Err(conflict(
                entry["diagnostics"]
                    .as_array()
                    .and_then(|v| v.first())
                    .and_then(|v| v["message"].as_str())
                    .unwrap_or("The Run configuration definition is invalid."),
            ));
        }
        revision = entry["revision"].clone();
        protected = repository
            .protected_secrets(&owner, project, &secrets::references(&entry["document"])?)
            .await?;
        for secret in &mut protected {
            *secret = Value::object(
                secret
                    .as_object()
                    .unwrap()
                    .iter()
                    .filter(|(key, _)| key.as_str() != Some("updatedAt"))
                    .map(|(key, value)| (key.clone(), value.clone())),
            );
        }
        if definition["codexEnvironment"]["enabled"] == true {
            if definition["codexEnvironment"]["valid"] != true {
                return Err(conflict(
                    definition["codexEnvironment"]["diagnostics"]
                        .as_array()
                        .and_then(|v| v.first())
                        .and_then(|v| v["message"].as_str())
                        .unwrap_or("The Codex environment source is invalid."),
                ));
            }
            codex_revision = definition["codexEnvironment"]["revision"].clone();
        }
    }
    let mut admission = json!({"operationId":input["operationId"],"projectId":input["projectId"],"configurationId":input["configurationId"],"worktreeId":target["worktree"]["id"],"workerId":worker,"operation":input["operation"],"definitionRevision":revision,"codexEnvironmentRevision":codex_revision});
    if let Some(source) = os_source.as_ref() {
        admission["osExecution"] = source["osExecution"].clone();
    }
    let mut durable = repository
        .request_operation(&owner, &admission)
        .await
        .map_err(|error| {
            if let Some(conflict_error) =
                error.downcast_ref::<super::execution::PlacementConflict>()
            {
                conflict(conflict_error.to_string())
            } else {
                error
            }
        })?;
    if durable["operation"]["outcome"] != "accepted" {
        return crate::settings::parse_response(
            "runConfigurationRuntimeOperationResultSchema",
            Some(&durable),
        );
    }
    let runtime = durable["runtime"].clone();
    if runtime["terminalId"].is_null() {
        bail!("The accepted Run configuration runtime has no terminal binding.");
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
    let mut command = if let Some(source) = os_source.as_ref() {
        json!({"type":format!("cantrip-os.run-runtime.{}",text(&input,"operation")?),"identity":identity,"definitions":source["osExecution"]["definitions"],"target":source["osExecution"]["target"]})
    } else {
        json!({"type":format!("project.run-configuration-runtime.{}",text(&input,"operation")?),"identity":identity})
    };
    if input["operation"] != "stop" {
        if os_source.is_none() {
            command["rootKind"] = json!(if target["worktree"]["rootKind"] == "folder-root" {
                "folder-root"
            } else {
                "git-root"
            });
            command["sourcePath"] = target["sourcePath"].clone();
            command["targetPath"] = target["worktree"]["path"].clone();
        }
        command["protectedSecrets"] = Value::Array(protected);
    }
    let result: Result<Value> = async {
        let response = service
            .workers
            .commands
            .request(worker, command, Some(Duration::from_secs(30)), None)
            .await?;
        crate::settings::parse_response(
            "runConfigurationRuntimeWorkerOperationResultSchema",
            response.as_ref(),
        )
    }
    .await;
    let result = match result {
        Ok(value) => value,
        Err(error) => {
            let message = crate::settings::operation_error_message(&error);
            let mut observation = failed(
                &identity,
                &runtime,
                if input["operation"] == "stop" {
                    "stop"
                } else {
                    "spawn"
                },
                "worker-request-failed",
                JsString::new(message.units().iter().copied().take(1000).collect()),
            )?;
            if os_source.is_some() {
                observation["state"] = json!("lost");
                observation["failure"] = json!({"phase":"reconcile","code":"linux-worker-outcome-unknown","message":"Linux Run delivery or termination was not confirmed. No command was repeated.","retryable":true});
            }
            mark_failed(&service, &owner, worker, &observation, true).await?;
            invalidate(&service, &owner, &runtime)?;
            return Err(error);
        }
    };
    if !matches!(result["outcome"].as_str(), Some("accepted" | "replayed")) {
        let (code, message) = if result["outcome"] == "not-found" {
            (
                "worker-runtime-not-found",
                "The worker no longer has this Run configuration runtime.",
            )
        } else {
            (
                "worker-runtime-stale",
                "The worker rejected stale Run configuration lifecycle state.",
            )
        };
        let mut rejected = failed(&identity, &runtime, "reconcile", code, message.into())?;
        if os_source.is_some() {
            rejected["state"] = json!("lost");
        }
        mark_failed(&service, &owner, worker, &rejected, false).await?;
        return Err(conflict(message));
    }
    if result["observation"].is_null() {
        bail!("The worker omitted the Run configuration runtime observation.");
    }
    let applied = repository
        .observe(&owner, worker, &result["observation"])
        .await?
        .context("The Run configuration runtime observation was unauthorized.")?;
    if applied["reason"] == "invalid-transition" {
        let message = "The worker returned an invalid Run configuration state transition.";
        let mut invalid = failed(
            &identity,
            &runtime,
            "reconcile",
            "worker-invalid-transition",
            message.into(),
        )?;
        if os_source.is_some() {
            invalid["state"] = json!("lost");
        }
        mark_failed(&service, &owner, worker, &invalid, false).await?;
        return Err(conflict(message));
    }
    let runtime = &applied["runtime"];
    if let Some(terminal) = runtime["terminalId"].as_str() {
        let status = match runtime["state"].as_str() {
            Some("starting" | "running" | "restarting" | "stopping") => "running",
            Some("failed") => "failed",
            _ => "exited",
        };
        service
            .worker_maintenance
            .record_status(&owner, terminal, status)
            .await?;
    }
    invalidate(&service, &owner, runtime)?;
    durable["runtime"] = runtime.clone();
    crate::settings::parse_response(
        "runConfigurationRuntimeOperationResultSchema",
        Some(&durable),
    )
}
