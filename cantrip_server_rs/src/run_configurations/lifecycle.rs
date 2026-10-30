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
        message: message.into(),
    }
    .into()
}
fn conflict(message: impl Into<String>) -> anyhow::Error {
    api(409, "conflict", message)
}
fn invalidate(service: &AuthService, owner: &str, runtime: &Value) -> Result<()> {
    service.live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":runtime["projectId"]}),"resource":"run","action":"invalidated","entityId":runtime["id"],"revision":Value::Null,"payload":Value::Null}))?;
    Ok(())
}
async fn definition(service: &AuthService, owner: &str, input: &Value) -> Result<Value> {
    let targets = TargetRepository::new(service.repository.database.clone());
    let project = text(input, "projectId")?;
    let source = targets
        .observation_source(owner, project, &|id| {
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
    let worker = text(&source, "workerId")?;
    if !service.workers.bridge.is_connected(worker) {
        return Err(api(
            503,
            "unavailable",
            "The project Primary worker is offline.",
        ));
    }
    service.run_configuration_observations.subscribe(worker);
    let response=service.workers.commands.request(worker,json!({"type":"project.run-configuration-definitions.get","operationId":input["operationId"],"projectId":input["projectId"],"sourcePath":source["cwd"],"configurationId":input["configurationId"]}),None,None).await?;
    let mut result =
        crate::settings::parse_response("runConfigurationGetResponseSchema", response.as_ref())?;
    if result["operationId"] != input["operationId"] || result["projectId"] != input["projectId"] {
        bail!("The Run configuration read response was misrouted.");
    }
    let references = if result["result"]["found"] == true
        && result["result"]["entry"]["status"] == "ready"
        && !result["result"]["entry"]["document"].is_null()
    {
        secrets::references(&result["result"]["entry"]["document"])?
    } else {
        Vec::new()
    };
    result["secretReferences"] = Value::Array(
        Repository::new(service.repository.database.clone())
            .secret_statuses(owner, project, &references)
            .await?,
    );
    crate::settings::parse_response("runConfigurationGetResponseSchema", Some(&result))
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
    if let Some(replay) = repository
        .operation_result(&owner, text(&input, "operationId")?)
        .await?
    {
        if ["projectId", "configurationId", "operation"]
            .iter()
            .any(|key| replay["operation"][*key] != input[*key])
            || (!input["targetWorktreeId"].is_null()
                && replay["operation"]["worktreeId"] != input["targetWorktreeId"])
        {
            return Err(conflict(
                "The Run configuration operation ID is already bound to another request.",
            ));
        }
        return crate::settings::parse_response(
            "runConfigurationRuntimeOperationResultSchema",
            Some(&replay),
        );
    }
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
    let target = targets
        .worktree_context(&owner, project, &target)
        .await?
        .filter(|v| v["worktree"]["lifecycleState"] == "ready")
        .ok_or_else(|| {
            api(
                404,
                "not-found",
                "The Run configuration target worktree is not ready.",
            )
        })?;
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
        let definition = definition(&service, &owner, &input).await?;
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
    let mut durable=repository.request_operation(&owner,&json!({"operationId":input["operationId"],"projectId":input["projectId"],"configurationId":input["configurationId"],"worktreeId":target["worktree"]["id"],"workerId":worker,"operation":input["operation"],"definitionRevision":revision,"codexEnvironmentRevision":codex_revision})).await?;
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
    let mut command = json!({"type":format!("project.run-configuration-runtime.{}",text(&input,"operation")?),"identity":identity});
    if input["operation"] != "stop" {
        command["rootKind"] = json!(if target["worktree"]["rootKind"] == "folder-root" {
            "folder-root"
        } else {
            "git-root"
        });
        command["sourcePath"] = target["sourcePath"].clone();
        command["targetPath"] = target["worktree"]["path"].clone();
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
            let observation = failed(
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
        mark_failed(
            &service,
            &owner,
            worker,
            &failed(&identity, &runtime, "reconcile", code, message.into())?,
            false,
        )
        .await?;
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
        mark_failed(
            &service,
            &owner,
            worker,
            &failed(
                &identity,
                &runtime,
                "reconcile",
                "worker-invalid-transition",
                message.into(),
            )?,
            false,
        )
        .await?;
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
