//! Owned opaque Run secrets and operation receipts.
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::{repository::AuditRecord, service::AuthService},
    projects::repository::ProjectRepository,
    run_configurations::Repository,
    wire::{Value, value::json},
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::Method,
    response::Response,
    routing::get,
};
use std::sync::Arc;

async fn execute(
    service: &AuthService,
    ctx: &Context,
    project: &str,
    request: Request,
) -> Result<Response> {
    let owner = &ctx.principal.user.as_ref().unwrap().id;
    let read = request.method() == Method::GET || request.method() == Method::HEAD;
    let input = if read {
        None
    } else {
        let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        Some(
            match parse("runConfigurationSecretSetRequestSchema", body.as_ref())? {
                Ok(value) => value,
                Err(response) => return Ok(response),
            },
        )
    };
    if ProjectRepository::new(service.repository.database.clone())?
        .get(owner, project)
        .await?
        .is_none()
    {
        return Ok(error(404, "Project not found."));
    }
    let repository = Repository::new(service.repository.database.clone());
    let Some(input) = input else {
        return output(
            200,
            "runConfigurationSecretListResultSchema",
            &json!({"projectId":project,"secrets":repository.list_secret_summaries(owner,project).await?}),
        );
    };
    let result: Result<Response> = async {
        let result = repository.set_secret(owner, project, &input).await?;
        if let Err(failure) = service.live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":project}),"resource":"run-configuration","action":"invalidated","entityId":Value::Null,"revision":Value::Null,"payload":Value::Null})) {
            use crate::operations::logging::{self,LogCall};
            (logging::server_logger())(LogCall::event("error","Could not publish application live invalidation",json!({"err":json!({"message":failure.to_string()}),"resource":"run-configuration"})));
        }
        let action = "run.configuration.secret.app.set";
        if let Err(failure) = service.repository.audit(AuditRecord { action, result:"succeeded", owner:Some(owner), actor:Some(owner), session:ctx.principal.session_id.as_deref(), resource_type:"run-configuration-secret", resource:input["reference"].as_str(), request_id:&ctx.id }).await {
            use crate::operations::logging::{self,LogCall};
            (logging::server_logger())(LogCall::event("error","Could not append security audit event",json!({"action":action,"err":json!({"message":failure.to_string()}),"event":"security.audit-write-failed","requestId":ctx.id})));
        }
        output(if result["replayed"] == false && result["secret"]["revision"] == json!(1) {201} else {200}, "runConfigurationSecretSetResultSchema", &result)
    }.await;
    match result {
        Ok(value) => Ok(value),
        Err(failure) => Ok(error(
            502,
            crate::settings::operation_error_message(&failure),
        )),
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(project): Path<String>,
    request: Request,
) -> Response {
    let mutation = request.method() == Method::PUT;
    let response = match execute(&service, &ctx, &project, request).await {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    };
    if mutation && response.status().as_u16() < 400 {
        let live = service.live.clone();
        let owner = ctx.principal.user.as_ref().unwrap().id.clone();
        super::on_response::completed(response, move || {
            if let Err(failure) = live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":project}),"resource":"run-configuration","action":"invalidated","entityId":project,"revision":Value::Null,"payload":Value::Null})) {
                use crate::operations::logging::{self,LogCall};
                (logging::server_logger())(LogCall::event("error","Could not publish application live invalidation",json!({"err":json!({"message":failure.to_string()}),"resource":"run-configuration"})));
            }
        })
    } else {
        response
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route(
        "/api/projects/{projectId}/run-configuration-secrets",
        get(handle).put(handle),
    )
}
