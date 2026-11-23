//! Run definition APIs; workers retain ownership of project files.
use super::{
    account, body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::{repository::AuditRecord, service::AuthService},
    run_configurations::{definitions, lifecycle::ApiError, retirement::TargetError},
    wire::value::json,
    workers::command_bus::CommandFailure,
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, post},
};
use std::{collections::HashMap, sync::Arc};

fn failure(cause: anyhow::Error) -> Response {
    if let Some(api) = cause.downcast_ref::<ApiError>() {
        return super::json_response(
            StatusCode::from_u16(api.status).unwrap(),
            json!({"code":api.code,"error":api.message}),
        );
    }
    if let Some(target) = cause.downcast_ref::<TargetError>() {
        if !target.worker_unavailable {
            return super::json_response(
                StatusCode::from_u16(target.status).unwrap(),
                json!({"code":if target.status==404 {"not-found"} else {"unavailable"},"error":target.to_string()}),
            );
        }
        return error(target.status, target.to_string());
    }
    error(
        cause
            .downcast_ref::<CommandFailure>()
            .map_or(502, |failure| failure.status(502)),
        crate::settings::operation_error_message(&cause),
    )
}
async fn execute(
    service: Arc<AuthService>,
    ctx: Arc<Context>,
    params: HashMap<String, String>,
    action: &'static str,
    request: Request,
) -> Result<Response> {
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let project = &params["projectId"];
    let raw = if request.method() == Method::GET || request.method() == Method::HEAD {
        Some(account::query(request.uri()))
    } else {
        match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(value) => value,
            Err(response) => return Ok(response),
        }
    };
    let schema = match action {
        "detect" => "runConfigurationDetectQuerySchema",
        "paths" => "runConfigurationPathsQuerySchema",
        "validate" => "runConfigurationApiValidateRequestSchema",
        "flutter-devices" => "runConfigurationApiFlutterDevicesRequestSchema",
        "write" => "runConfigurationApiWriteRequestSchema",
        "delete" => "runConfigurationApiDeleteRequestSchema",
        _ => "runConfigurationListQuerySchema",
    };
    let mut input = match parse(schema, raw.as_ref())? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    if matches!(action, "get" | "delete") {
        let id = json!(params["configurationId"]);
        input["configurationId"] = match parse("runConfigurationIdSchema", Some(&id))? {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
    }
    if action == "write" && input["document"]["id"] != params["configurationId"].as_str() {
        return Ok(super::json_response(
            StatusCode::BAD_REQUEST,
            json!({"code":"configuration-id-mismatch","error":"The route and document configuration IDs must match."}),
        ));
    }
    input["projectId"] = json!(project);
    let resource = if action == "delete" {
        input["configurationId"].clone()
    } else {
        input["document"]["id"].clone()
    };
    let result = if matches!(action, "write" | "delete") {
        definitions::mutate(service.clone(), owner.clone(), action, input).await
    } else {
        definitions::read(&service, &owner, action, &input).await
    };
    let result = match result {
        Ok(value) => value,
        Err(cause) => return Ok(failure(cause)),
    };
    let status = match action {
        "write" if result["result"].get("entry").is_none() => 409,
        "write" if result["result"]["outcome"] == "created" => 201,
        "delete" if result["result"]["outcome"] == "not-found" => 404,
        "delete" if result["result"]["outcome"] == "revision-mismatch" => 409,
        _ => 200,
    };
    let audit = if status >= 400 {
        None
    } else {
        match action {
            "write" => Some(if status == 201 {
                "run.configuration.app.created"
            } else {
                "run.configuration.app.updated"
            }),
            "delete" => Some("run.configuration.app.deleted"),
            "flutter-devices" => Some("run.configuration.app.flutter-devices-inspected"),
            _ => None,
        }
    };
    if let Some(action) = audit
        && let Err(cause) = service
            .repository
            .audit(AuditRecord {
                action,
                result: "succeeded",
                owner: Some(&owner),
                actor: Some(&owner),
                session: ctx.principal.session_id.as_deref(),
                resource_type: "run-configuration",
                resource: resource.as_str(),
                request_id: &ctx.id,
            })
            .await
    {
        use crate::operations::logging::{self, LogCall};
        (logging::server_logger())(LogCall::event(
            "error",
            "Could not append security audit event",
            json!({"action":action,"err":json!({"message":cause.to_string()}),"event":"security.audit-write-failed","requestId":ctx.id}),
        ));
    }
    output(status, definitions::response_schema(action), &result)
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    path: MatchedPath,
    request: Request,
) -> Response {
    let mutation = !matches!(*request.method(), Method::GET | Method::HEAD);
    let action = if params.contains_key("configurationId") {
        match *request.method() {
            Method::PUT => "write",
            Method::DELETE => "delete",
            _ => "get",
        }
    } else {
        match path.as_str().rsplit('/').next().unwrap() {
            "capabilities" => "capabilities",
            "detect" => "detect",
            "paths" => "paths",
            "validate" => "validate",
            "flutter-devices" => "flutter-devices",
            _ => "list",
        }
    };
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let project = params["projectId"].clone();
    let entity = params
        .get("configurationId")
        .cloned()
        .unwrap_or_else(|| project.clone());
    let result = service
        .project_operations
        .own(execute(
            service.clone(),
            ctx.clone(),
            params,
            action,
            request,
        ))
        .await;
    let response = match result {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    };
    if mutation && response.status().as_u16() < 400 {
        let live = service.live.clone();
        super::on_response::completed(response, move || {
            definitions::invalidate(&live, &owner, &project, json!(entity))
        })
    } else {
        response
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/projects/{projectId}/run-configurations", get(handle))
        .route(
            "/api/projects/{projectId}/run-configurations/capabilities",
            get(handle),
        )
        .route(
            "/api/projects/{projectId}/run-configurations/detect",
            get(handle),
        )
        .route(
            "/api/projects/{projectId}/run-configurations/paths",
            get(handle),
        )
        .route(
            "/api/projects/{projectId}/run-configurations/validate",
            post(handle),
        )
        .route(
            "/api/projects/{projectId}/run-configurations/flutter-devices",
            post(handle),
        )
        .route(
            "/api/projects/{projectId}/run-configurations/{configurationId}",
            get(handle).put(handle).delete(handle),
        )
}
