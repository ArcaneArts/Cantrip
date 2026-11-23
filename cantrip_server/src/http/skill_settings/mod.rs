//! Global skill settings: opaque worker content and owned audience metadata.
mod target;
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    operations::shared_failure::downcast_ref,
    settings::{self, repository::SettingsRepository},
    wire::{Value, value::json},
    workers::command_bus::CommandFailure,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{MatchedPath, Request, State},
    http::Method,
    response::Response,
    routing::{get, patch, post, put},
};
use std::sync::Arc;

#[derive(Debug)]
struct TargetError(u16, &'static str);
impl std::fmt::Display for TargetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.1)
    }
}
impl std::error::Error for TargetError {}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Skill settings identity")?
        .lossy()
        .into_owned())
}
fn scope(input: &Value) -> Result<Value> {
    settings::parse_response(
        "customizationContentScopeSchema",
        Some(&json!({
            "workerId":input["workerId"],"projectId":input["projectId"],
            "chatId":Value::Null,"providerId":input["providerId"]
        })),
    )
}
fn publish(service: &AuthService, owner: &str, project: &Value) {
    if project.is_null() {
        service.live.invalidate_resource(owner, "customization");
    } else if service.live.publish_event(json!({"ownerId":owner,
        "scope":json!({"kind":"project","projectId":project}),"resource":"customization",
        "action":"invalidated","entityId":Value::Null,"revision":Value::Null,"payload":Value::Null})).is_err() {
        eprintln!("{}", json!({"event":"live.publication-failed","resource":"customization"}).stringify());
    }
}
fn worker_failure(cause: &anyhow::Error, fallback: u16) -> Response {
    let status = if let Some(target) = downcast_ref::<TargetError>(cause) {
        target.0
    } else if matches!(downcast_ref::<CommandFailure>(cause), Some(CommandFailure::Bridge(e)) if e.unavailable)
    {
        503
    } else {
        fallback
    };
    error(status, settings::operation_error_message(cause))
}
async fn audiences(
    service: &AuthService,
    owner: &str,
    update: bool,
    query: &Value,
    body: Option<&Value>,
) -> Result<Response> {
    let input = match parse(
        if update {
            "skillAudienceUpdateSchema"
        } else {
            "skillAudienceContextSchema"
        },
        if update { body } else { Some(query) },
    )? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let repository = SettingsRepository::new(service.repository.database.clone());
    let result = if update {
        repository.update_skill_audience(owner, &input).await?
    } else {
        repository
            .list_skill_audiences(
                owner,
                &text(&input["workerId"])?,
                &text(&input["providerId"])?,
            )
            .await?
    };
    let Some(result) = result else {
        return Ok(error(404, "Worker or model provider not found."));
    };
    if update {
        publish(service, owner, &Value::Null);
    }
    output(
        200,
        if update {
            "skillAudienceSummarySchema"
        } else {
            "skillAudienceListSchema"
        },
        &result,
    )
}
async fn content(
    service: &AuthService,
    owner: &str,
    path: &str,
    method: &Method,
    query: &Value,
    body: Option<&Value>,
) -> Result<Response> {
    let listing = method == Method::GET || method == Method::HEAD;
    let (operation, invalidate) = if listing {
        ("skills.settings.list", false)
    } else {
        match path {
            "/api/skills/read" => ("skills.settings.read", false),
            "/api/skills/file" => ("skills.settings.write", true),
            "/api/skills/configuration" => ("skills.settings.configure", true),
            _ => ("skills.settings.delete", true),
        }
    };
    let read = if listing {
        let mut context = json!({"projectId":query.get("projectId").filter(|v| !v.is_null()).cloned().unwrap_or(Value::Null)});
        for key in ["workerId", "providerId"] {
            if let Some(value) = query.get(key) {
                context[key] = value.clone();
            }
        }
        let context = match parse("skillSettingsContextSchema", Some(&context))? {
            Ok(v) => v,
            Err(r) => return Ok(r),
        };
        let id =
            match crate::wire::parse("customizationOperationIdSchema", query.get("operationId")) {
                Ok(v) => v,
                Err(_) => return Ok(error(400, "A valid operationId is required.")),
            };
        Some((context, id))
    } else {
        None
    };
    let attempt: Result<Response> = async {
        let protected = if listing {None} else {
            let input = settings::parse_response("protectedCustomizationRequestSchema", body)?;
            anyhow::ensure!(input["operation"] == operation,"Protected customization request targets another operation.");
            Some(input)
        };
        let (context,id) = if let Some((context,id)) = read { (context,id) } else {
            let input=protected.as_ref().unwrap();
            anyhow::ensure!(input["scope"]["chatId"].is_null() && !input["scope"]["providerId"].is_null(),"Protected skill settings scope is invalid.");
            let context=settings::parse_response("skillSettingsContextSchema",Some(&input["scope"]))?;
            (context,input["operationId"].clone())
        };
        let target = target::resolve(service,owner,&context).await?;
        let scope = scope(&context)?;
        if protected.as_ref().is_some_and(|p| p["scope"].stringify()!=scope.stringify()) { return Ok(error(409,"Customization scope changed.")); }
        if operation=="skills.settings.configure" && (target.model.is_null() || target.provider.is_null()) {
            return Err(TargetError(409,"The selected provider needs at least one model route before skills can be configured.").into());
        }
        let mut command=json!({"type":operation,"operationId":id,"serverId":service.server_id,"scope":scope,
            "cwd":target.cwd,"providerId":target.provider_id,"providerKind":target.provider_kind});
        if (listing || operation=="skills.settings.configure") && !target.model.is_null() && !target.provider.is_null() {
            command["model"]=target.model; command["provider"]=target.provider;
        }
        if let Some(protected)=&protected {command["protectedRequest"]=protected["protectedRequest"].clone();}
        let raw=service.workers.commands.request(&target.worker,command,None,None).await?;
        let response=settings::parse_response("protectedCustomizationResponseSchema",raw.as_ref())?;
        anyhow::ensure!(response["operationId"]==id && response["operation"]==operation && response["scope"].stringify()==scope.stringify(),"Protected customization response targets another operation.");
        if invalidate && response["result"]=="succeeded" {publish(service,owner,&context["projectId"]);}
        output(200,"protectedCustomizationResponseSchema",&response)
    }.await;
    match attempt {
        Ok(response) => Ok(response),
        Err(cause) => Ok(worker_failure(&cause, if listing { 502 } else { 409 })),
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    matched: MatchedPath,
    request: Request,
) -> Response {
    let method = request.method().clone();
    let query = super::account::query(request.uri());
    let input = if method != Method::GET && method != Method::HEAD {
        let binary = (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024;
        match body::parse_js_buffer(request, service.config.api_body_limit_bytes, binary).await {
            Ok(v) => v,
            Err(r) => return r,
        }
    } else {
        None
    };
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let path = matched.as_str().to_owned();
    let work = {
        let service = service.clone();
        async move {
            if path == "/api/skill-audiences" {
                audiences(
                    &service,
                    &owner,
                    method == Method::PATCH,
                    &query,
                    input.as_ref(),
                )
                .await
            } else {
                content(&service, &owner, &path, &method, &query, input.as_ref()).await
            }
        }
    };
    match service.scratch_roots.owned(work).await {
        Ok(r) => r,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/skills", get(handle).delete(handle))
        .route("/api/skills/read", post(handle))
        .route("/api/skills/file", put(handle))
        .route("/api/skills/configuration", patch(handle))
        .route("/api/skill-audiences", get(handle).patch(handle))
}
