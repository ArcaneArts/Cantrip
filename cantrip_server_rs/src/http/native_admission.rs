//! Native operation admission/preparation/dispatch share worker authentication.
use super::{
    body, json_response,
    middleware::{self, Context},
};
use crate::{
    auth::service::AuthService,
    native_commands::{CommandError, Repository},
    wire::{self, Value, coercion::truthy, value::json},
    workers::credentials,
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Request, State},
    http::StatusCode,
    response::Response,
    routing::post,
};
use std::sync::Arc;
fn code(status: u16, key: &str) -> Response {
    json_response(StatusCode::from_u16(status).unwrap(), json!({"code":key}))
}
fn invalidation(service: &AuthService, owner: &str, scope: Value, entity: &Value) {
    let _=service.live.publish_event(json!({"ownerId":owner,"scope":scope,"resource":"chat","action":"invalidated","entityId":entity,"revision":Value::Null,"payload":Value::Null}));
}
fn authority(service: &AuthService, owner: &str, mut result: Value) -> Result<Value> {
    let receipt = &result["receipt"];
    let context = &result["execution"];
    let value = if matches!(receipt["status"].as_str(), Some("accepted" | "dispatched"))
        && truthy(context.get("computerUseEnabled"))
        && truthy(receipt.get("executionLaneId"))
    {
        let profile = crate::chats::managed_console::permission_profile(context);
        let mut authority = crate::settings::parse_response(
            "cuaPreviewAuthoritySchema",
            Some(
                &json!({"ownerId":owner,"serverId":service.server_id,"workerId":context["workerId"],"chatId":context["chatId"],"projectId":context["projectId"],"contextKind":context["contextKind"],"placementId":if context["contextKind"]=="project" {context["worktreeId"].clone()} else {context["scratchRootId"].clone()},"generation":context["computerUseAuthorityGeneration"],"profile":json!({"selectedId":profile["selectedId"],"effectiveId":profile["effectiveId"],"forcedByWorktreePolicy":profile["forcedByWorktreePolicy"],"usesDefault":profile["usesDefault"]})}),
            ),
        )?;
        authority["executionLaneId"] = receipt["executionLaneId"].clone();
        authority
    } else {
        Value::Null
    };
    result["computerUseAuthority"] = value;
    Ok(result)
}
async fn apply(
    service: Arc<AuthService>,
    owner: String,
    input: Value,
    phase: String,
) -> Result<Value> {
    let repo = Repository::new(service.repository.database.clone());
    if phase == "continue" {
        return authority(
            &service,
            &owner,
            repo.continue_execution(&owner, &input).await?,
        );
    }
    if phase == "settings-evidence" {
        let result = repo.record_settings_evidence(&owner, &input).await?;
        let worker = input["workerId"]
            .as_js_string()
            .unwrap()
            .lossy()
            .into_owned();
        let operation = input["operationId"]
            .as_js_string()
            .unwrap()
            .lossy()
            .into_owned();
        if let Some(receipt) = repo.lookup(&owner, &worker, &operation).await? {
            invalidation(
                &service,
                &owner,
                json!({"kind":"chat","chatId":receipt["chatId"]}),
                &Value::Null,
            );
        }
        return Ok(result);
    }
    if phase == "bind-preparation" {
        return Ok(json!({"receipt":repo.bind_preparation(&owner,&input).await?}));
    }
    let result = if phase == "admit" {
        repo.admit(&owner, &input, &Value::Null).await?
    } else {
        repo.dispatch(&owner, &input).await?
    };
    if phase == "admit" && truthy(result.get("execution")) {
        let execution = &result["execution"];
        let scope = if truthy(execution.get("projectId")) {
            json!({"kind":"project","projectId":execution["projectId"]})
        } else {
            json!({"kind":"current-user"})
        };
        invalidation(&service, &owner, scope, &execution["chatId"]);
    }
    if result["receipt"]["method"] == "thread/settings/update" {
        let chat = &result["receipt"]["chatId"];
        invalidation(
            &service,
            &owner,
            json!({"kind":"chat","chatId":chat}),
            &Value::Null,
        );
    }
    authority(&service, &owner, result)
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let phase = request.uri().path().rsplit('/').next().unwrap().to_owned();
    let authorization = middleware::value(request.headers(), "authorization");
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let input = match wire::parse(
        match phase.as_str() {
            "admit" => "nativeCommandAdmissionSchema",
            "continue" => "nativeCommandContinuationSchema",
            "settings-evidence" => "nativeSettingsEvidenceSchema",
            _ => "nativeCommandDispatchSchema",
        },
        body.as_ref(),
    ) {
        Ok(v) => v,
        Err(_) => return code(400, "invalid-native-command"),
    };
    let worker = input["workerId"]
        .as_js_string()
        .unwrap()
        .lossy()
        .into_owned();
    let authentication = match credentials::authenticate(
        &service.workers.repository,
        &service.config,
        authorization.as_deref(),
        &worker,
        "worker:agent-tools",
    )
    .await
    {
        Ok(Some(a)) => a,
        Ok(None) => return code(401, "unauthorized"),
        Err(cause) => return middleware::failure(&service, &ctx.id, &cause),
    };
    let owner = authentication.credential.owner_id;
    match service.workers.repository.get_worker(&owner, &worker).await {
        Ok(Some(_)) => {}
        Ok(None) => return code(404, "worker-not-found"),
        Err(cause) => return middleware::failure(&service, &ctx.id, &cause),
    };
    match service
        .scratch_roots
        .owned(apply(service.clone(), owner, input, phase))
        .await
    {
        Ok(v) => json_response(StatusCode::OK, v),
        Err(cause) => {
            if let Some(e) = cause.downcast_ref::<CommandError>() {
                code(e.status, &e.code)
            } else {
                middleware::failure(&service, &ctx.id, &cause)
            }
        }
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/internal/native-commands/admit", post(handle))
        .route("/api/internal/native-commands/dispatch", post(handle))
        .route("/api/internal/native-commands/continue", post(handle))
        .route(
            "/api/internal/native-commands/settings-evidence",
            post(handle),
        )
        .route(
            "/api/internal/native-commands/bind-preparation",
            post(handle),
        )
}
