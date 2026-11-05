//! Owned Run status and opaque worker output. Output is never decrypted here.
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    run_configurations::Repository,
    wire::{Value, value::json},
    workers::command_bus::CommandFailure,
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{MatchedPath, Request, State},
    http::StatusCode,
    response::Response,
    routing::post,
};
use std::sync::Arc;

fn coded_error(status: StatusCode, code: &str, message: &str) -> Response {
    super::json_response(status, json!({"code":code,"error":message}))
}
async fn execute(
    service: &AuthService,
    owner: &str,
    status: bool,
    request: Request,
) -> Result<Response> {
    let body = match body::parse_js(request, 1_048_576).await {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let schema = if status {
        "runConfigurationRuntimeStatusQuerySchema"
    } else {
        "runConfigurationRuntimeOutputQuerySchema"
    };
    let input = match parse(schema, body.as_ref())? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let repository = Repository::new(service.repository.database.clone());
    let project = input["projectId"].as_str().unwrap();
    if status && let Some(runtime_id) = input["runtimeId"].as_str() {
        if !input["osSource"].is_null() {
            return Ok(coded_error(
                StatusCode::CONFLICT,
                "conflict",
                "Choose a runtime ID or a Run source.",
            ));
        }
        let captured = repository.captured(owner, runtime_id).await?;
        let runtimes: Vec<_> = captured
            .iter()
            .map(|capture| &capture["runtime"])
            .filter(|runtime| {
                runtime["projectId"] == project
                    && (input["configurationId"].is_null()
                        || runtime["configurationId"] == input["configurationId"])
                    && (input["targetWorktreeId"].is_null()
                        || runtime["worktreeId"] == input["targetWorktreeId"])
            })
            .cloned()
            .collect();
        return output(
            200,
            "runConfigurationRuntimeStatusResultSchema",
            &json!({"operationId":input["operationId"],"projectId":project,"runtimes":runtimes}),
        );
    }
    let os_source = if input["osSource"].is_null() {
        None
    } else {
        let selection: serde_json::Value = serde_json::from_str(&input["osSource"].stringify())?;
        let worktree = if status {
            input["targetWorktreeId"].as_str()
        } else {
            input["worktreeId"].as_str()
        };
        let selected = match crate::cantrip_os::Repository::new(service.repository.database.clone())
            .selected_run(owner, project, &selection, worktree)
            .await
        {
            Ok(selected) => selected,
            Err(error) => {
                return Ok(coded_error(
                    StatusCode::CONFLICT,
                    "conflict",
                    &error.to_string(),
                ));
            }
        };
        let selected = Value::from_serialize(&selected);
        if !selected["runtime"].is_null()
            && !input["configurationId"].is_null()
            && selected["runtime"]["configurationId"] != input["configurationId"]
        {
            return Ok(coded_error(
                StatusCode::CONFLICT,
                "conflict",
                "The captured Linux Run belongs to another configuration.",
            ));
        }
        Some(selected)
    };
    if status {
        let rows = if let Some(source) = os_source.as_ref() {
            if !source["runtime"].is_null() {
                vec![source["runtime"].clone()]
            } else {
                repository
                    .list_in_definition(
                        owner,
                        project,
                        input["configurationId"].as_str(),
                        input["targetWorktreeId"].as_str(),
                        input["limit"].as_f64().unwrap() as i64,
                        &source["osExecution"]["definitions"]["scope"],
                    )
                    .await?
            }
        } else {
            repository
                .list(
                    owner,
                    project,
                    input["configurationId"].as_str(),
                    input["targetWorktreeId"].as_str(),
                    input["limit"].as_f64().unwrap() as i64,
                )
                .await?
        };
        return output(
            200,
            "runConfigurationRuntimeStatusResultSchema",
            &json!({"operationId":input["operationId"],"projectId":project,"runtimes":rows}),
        );
    }
    let result: Result<Response> = async {
        let runtime = if let Some(source) = os_source.as_ref() {
            if !source["runtime"].is_null() {
                Some(source["runtime"].clone())
            } else {
                repository
                    .get_in_execution(
                        owner,
                        project,
                        input["configurationId"].as_str().unwrap(),
                        input["worktreeId"].as_str().unwrap(),
                        source["executionKey"].as_str().unwrap(),
                    )
                    .await?
            }
        } else {
            repository
                .get(
                    owner,
                    project,
                    input["configurationId"].as_str().unwrap(),
                    input["worktreeId"].as_str().unwrap(),
                )
                .await?
        };
        let result = crate::run_configurations::output::read(
            service,
            runtime.as_ref(),
            &input,
            os_source.as_ref(),
        )
        .await?;
        output(
            200,
            "protectedRunConfigurationRuntimeOutputResultSchema",
            &result,
        )
    }
    .await;
    match result {
        Ok(response) => Ok(response),
        Err(failure) if failure.is::<crate::run_configurations::lifecycle::ApiError>() => {
            let api = failure
                .downcast_ref::<crate::run_configurations::lifecycle::ApiError>()
                .unwrap();
            Ok(coded_error(
                StatusCode::from_u16(api.status)?,
                api.code,
                &api.message,
            ))
        }
        Err(failure) => Ok(error(
            failure
                .downcast_ref::<CommandFailure>()
                .map_or(502, |failure| failure.status(502)),
            crate::settings::operation_error_message(&failure),
        )),
    }
}
async fn lifecycle_handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let owned_service = service.clone();
    let owned_context = ctx.clone();
    let result: Result<Response> = service.project_operations.own(async move {
        let service = owned_service;
        let ctx = owned_context;
        let body = match body::parse_js(request, 1_048_576).await { Ok(value)=>value, Err(response)=>return Ok(response) };
        let input = match parse("runConfigurationRuntimeLifecycleRequestSchema",body.as_ref())? { Ok(value)=>value,Err(response)=>return Ok(response) };
        let operation = input["operation"].as_str().unwrap().to_owned();
        let configuration = input["configurationId"].as_str().unwrap().to_owned();
        let result = crate::run_configurations::lifecycle::operate(service.clone(),owner.clone(),input).await;
        match result {
            Ok(result)=> {
                let action=format!("run.configuration.app.{operation}");
                if let Err(error)=service.repository.audit(crate::auth::repository::AuditRecord { action:&action,result:"succeeded",owner:Some(&owner),actor:Some(&owner),session:ctx.principal.session_id.as_deref(),resource_type:"run-configuration-runtime",resource:Some(&configuration),request_id:&ctx.id }).await {
                    use crate::operations::logging::{self,LogCall};
                    (logging::server_logger())(LogCall::event("error","Could not append security audit event",json!({"action":action,"err":json!({"message":error.to_string()}),"event":"security.audit-write-failed","requestId":ctx.id})));
                }
                output(if result["operation"]["outcome"]=="accepted" && result["replayed"]==false {202} else {200},"runConfigurationRuntimeOperationResultSchema",&result)
            },
            Err(failure)=> {
                if let Some(error)=failure.downcast_ref::<crate::run_configurations::lifecycle::ApiError>() { return Ok(coded_error(StatusCode::from_u16(error.status).unwrap(),error.code,&error.message)); }
                Ok(error(failure.downcast_ref::<CommandFailure>().map_or(502,|failure|failure.status(502)),crate::settings::operation_error_message(&failure)))
            }
        }
    }).await;
    match result {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    route: MatchedPath,
    request: Request,
) -> Response {
    let owner = &ctx.principal.user.as_ref().unwrap().id;
    match execute(
        &service,
        owner,
        route.as_str().ends_with("/status"),
        request,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/run-configuration-runtimes/operations",
            post(lifecycle_handle),
        )
        .route("/api/run-configuration-runtimes/status", post(handle))
        .route("/api/run-configuration-runtimes/output", post(handle))
}
