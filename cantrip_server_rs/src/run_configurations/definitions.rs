//! Primary-worker Run definitions, serialized with runtime/worktree mutations.
use super::{Repository, lifecycle::ApiError, secrets, text};
use crate::{
    auth::service::AuthService,
    projects::targets::TargetRepository,
    wire::{Value, value::json},
};
use anyhow::{Result, bail};
use futures::{FutureExt, future::BoxFuture};
use std::sync::Arc;

pub async fn source(service: &AuthService, owner: &str, project: &str) -> Result<Value> {
    let source = TargetRepository::new(service.repository.database.clone())
        .observation_source(owner, project, &|id| {
            service.workers.bridge.is_connected(id)
        })
        .await?
        .ok_or_else(|| ApiError {
            status: 404,
            code: "not-found",
            message: "The project Primary source was not found.".into(),
        })?;
    let worker = text(&source, "workerId")?;
    if !service.workers.bridge.is_connected(worker) {
        return Err(ApiError {
            status: 503,
            code: "unavailable",
            message: "The project Primary worker is offline.".into(),
        }
        .into());
    }
    service.run_configuration_observations.subscribe(worker);
    Ok(source)
}
pub fn response_schema(action: &str) -> &'static str {
    match action {
        "list" => "runConfigurationListResponseSchema",
        "get" => "runConfigurationGetResponseSchema",
        "capabilities" => "runConfigurationCapabilitiesResponseSchema",
        "detect" => "runConfigurationDetectResponseSchema",
        "paths" => "runConfigurationPathsResponseSchema",
        "validate" => "runConfigurationValidateResponseSchema",
        "flutter-devices" => "runConfigurationFlutterDevicesResponseSchema",
        "write" => "runConfigurationWriteResponseSchema",
        "delete" => "runConfigurationDeleteResponseSchema",
        _ => unreachable!("registered definition action"),
    }
}
async fn dispatch(
    service: &AuthService,
    source: &Value,
    action: &str,
    input: &Value,
) -> Result<Value> {
    let mut command = json!({"type":format!("project.run-configuration-definitions.{action}"),"operationId":input["operationId"],"projectId":input["projectId"],"sourcePath":source["cwd"]});
    match action {
        "get" => command["configurationId"] = input["configurationId"].clone(),
        "detect" => command["providerKind"] = input.get("provider").cloned().unwrap_or(Value::Null),
        "paths" => {
            command["purpose"] = input["purpose"].clone();
            command["query"] = input["query"].clone();
        }
        "validate" | "flutter-devices" => command["document"] = input["document"].clone(),
        "write" => {
            command["request"] =
                json!({"expectedRevision":input["expectedRevision"],"document":input["document"]})
        }
        "delete" => {
            command["request"] =
                json!({"id":input["configurationId"],"expectedRevision":input["expectedRevision"]})
        }
        _ => {}
    }
    let response = service
        .workers
        .commands
        .request(text(source, "workerId")?, command, None, None)
        .await?;
    let result = crate::settings::parse_response(response_schema(action), response.as_ref())?;
    let routed =
        result["operationId"] == input["operationId"] && result["projectId"] == input["projectId"];
    let details = match action {
        "paths" => result["purpose"] == input["purpose"] && result["query"] == input["query"],
        "validate" => {
            result["validation"]["configurationId"] == input["document"]["id"]
                && result["validation"]["provider"] == input["document"]["provider"]
        }
        "flutter-devices" => result["configurationId"] == input["document"]["id"],
        _ => true,
    };
    if !routed || !details {
        let message = match action {
            "get" => "read",
            "capabilities" => "capability",
            "detect" => "detection",
            "paths" => "path",
            "validate" => "validation",
            other => other,
        };
        if action == "flutter-devices" {
            bail!("The Flutter device inspection response was misrouted.");
        }
        bail!("The Run configuration {message} response was misrouted.");
    }
    Ok(result)
}
pub async fn read(
    service: &AuthService,
    owner: &str,
    action: &str,
    input: &Value,
) -> Result<Value> {
    let project = text(input, "projectId")?;
    let source = source(service, owner, project).await?;
    let mut result = dispatch(service, &source, action, input).await?;
    if action == "get" {
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
        return crate::settings::parse_response(response_schema(action), Some(&result));
    }
    Ok(result)
}
pub fn mutate(
    service: Arc<AuthService>,
    owner: String,
    action: &'static str,
    input: Value,
) -> BoxFuture<'static, Result<Value>> {
    let project = input["projectId"].as_str().unwrap().to_owned();
    service.project_operations.clone().serialize(&owner.clone(),&project,false,move || async move {
        let project = text(&input,"projectId")?;
        let source = source(&service,&owner,project).await?;
        if action == "delete" {
            let mut query = input.clone();
            query["operationId"] = json!(uuid::Uuid::new_v4().to_string());
            let current = read(&service,&owner,"get",&query).await?;
            let found = current["result"]["found"] == true;
            let revision = if found { current["result"]["entry"]["revision"].clone() } else {Value::Null};
            if !found || revision != input["expectedRevision"] {
                return crate::settings::parse_response(response_schema("delete"),Some(&json!({"operation":"delete","operationId":input["operationId"],"projectId":project,"result":json!({"outcome":if found {"revision-mismatch"} else {"not-found"},"id":input["configurationId"],"currentRevision":revision})})));
            }
            super::retirement::retire(&service,&owner,project,Some(text(&input,"configurationId")?),None).await?;
        }
        let result = dispatch(&service,&source,action,&input).await?;
        if action == "delete" && result["result"]["outcome"] == "deleted" {
            invalidate(&service.live,&owner,project,input["configurationId"].clone());
        }
        Ok(result)
    }.boxed())
}
pub fn invalidate(live: &crate::live::LiveService, owner: &str, project: &str, entity: Value) {
    if let Err(failure) = live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":project}),"resource":"run-configuration","action":"invalidated","entityId":entity,"revision":Value::Null,"payload":Value::Null})) {
        use crate::operations::logging::{self,LogCall};
        (logging::server_logger())(LogCall::event("error","Could not publish application live invalidation",json!({"err":json!({"message":failure.to_string()}),"resource":"run-configuration"})));
    }
}
