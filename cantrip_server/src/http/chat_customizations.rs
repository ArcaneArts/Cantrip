//! Operation-bound customization content remains opaque to the server.
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output},
};
use crate::{
    auth::service::AuthService,
    chats,
    operations::shared_failure::downcast_ref,
    wire::{self, Value, value::json},
    workers::command_bus::CommandFailure,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Request, State},
    http::Method,
    response::Response,
    routing::{get, patch, post, put},
};
use std::sync::Arc;

fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Customization identity")?
        .lossy()
        .into_owned())
}
struct Operation {
    name: &'static str,
    choose: &'static str,
    thread: bool,
    invalidate: bool,
    status: u16,
}
fn operation(path: &str) -> Operation {
    let (name, choose, thread, invalidate, status) = match path {
        "/api/chats/{chatId}/skills" => ("skills.list", "listing skills", false, false, 200),
        "/api/chats/{chatId}/customizations" => (
            "customization.inventory.read",
            "listing customizations",
            true,
            false,
            200,
        ),
        "/api/chats/{chatId}/customizations/external-preview" => (
            "customization.external.preview",
            "previewing imports",
            false,
            false,
            200,
        ),
        "/api/chats/{chatId}/customizations/mcp-resource" => (
            "customization.mcp.resource.read",
            "reading MCP resources",
            true,
            false,
            200,
        ),
        "/api/chats/{chatId}/customizations/skill" => (
            "customization.skill.configure",
            "configuring skills",
            false,
            true,
            200,
        ),
        "/api/chats/{chatId}/customizations/skill-roots" => (
            "customization.skill-roots.set",
            "configuring skill roots",
            false,
            true,
            200,
        ),
        "/api/chats/{chatId}/customizations/mcp-oauth" => (
            "customization.mcp.oauth.start",
            "authorizing MCP servers",
            false,
            false,
            200,
        ),
        "/api/chats/{chatId}/customizations/mcp-oauth/status" => (
            "customization.mcp.oauth.status",
            "checking MCP OAuth",
            false,
            false,
            200,
        ),
        "/api/chats/{chatId}/customizations/mcp-reload" => (
            "customization.mcp.reload",
            "reloading MCP servers",
            false,
            true,
            200,
        ),
        "/api/chats/{chatId}/customizations/external-import" => (
            "customization.external.apply",
            "importing external configuration",
            false,
            false,
            202,
        ),
        "/api/chats/{chatId}/customizations/external-import/status" => (
            "customization.external.status",
            "checking an external import",
            false,
            false,
            200,
        ),
        _ => unreachable!("Registered customization route"),
    };
    Operation {
        name,
        choose,
        thread,
        invalidate,
        status,
    }
}
fn scope(context: &Value, runtime: &Value) -> Result<Value> {
    crate::settings::parse_response(
        "customizationContentScopeSchema",
        Some(&json!({
            "workerId":context["workerId"],"projectId":context["projectId"],
            "chatId":context["chatId"],"providerId":runtime["provider"]["id"]
        })),
    )
}
async fn execute(
    service: Arc<AuthService>,
    owner: String,
    chat: String,
    path: String,
    method: Method,
    query: Value,
    body: Option<Value>,
) -> Result<Response> {
    let target = path.ends_with("/target");
    let spec = (!target).then(|| operation(&path));
    let repository = chats::Repository::new(service.repository.database.clone());
    // Source's project-context hook runs after body parsing and before handler
    // schema validation. Keep its separate lookup: the handler resolves the
    // current context again after validating the operation identity.
    if repository
        .execution_context(&owner, &chat)
        .await?
        .is_some_and(|context| context["contextKind"] == "standalone")
    {
        return Ok(error(
            409,
            "This IDE-only Chat feature is unavailable in standalone Chat.",
        ));
    }
    let input = if method != Method::GET && method != Method::HEAD {
        match wire::parse("protectedCustomizationRequestSchema", body.as_ref()) {
            Ok(value) if value["operation"] == spec.as_ref().unwrap().name => Some(value),
            _ => return Ok(error(400, "Invalid protected request.")),
        }
    } else {
        None
    };
    let id = if target {
        Value::Null
    } else if let Some(input) = &input {
        input["operationId"].clone()
    } else {
        match wire::parse("customizationOperationIdSchema", query.get("operationId")) {
            Ok(value) => value,
            Err(_) => return Ok(error(400, "A valid operationId is required.")),
        }
    };
    let Some(context) = repository.execution_context(&owner, &chat).await? else {
        return Ok(error(404, "Chat not found."));
    };
    let worker = text(&context["workerId"])?;
    if !service.workers.commands.is_connected(&worker) {
        return Ok(error(503, "Project worker is offline."));
    }
    if target {
        let Some(runtime) = service
            .model_routing
            .runtime_for_context(&owner, &context)
            .await?
        else {
            return Ok(error(409, "Choose a model before using customizations."));
        };
        return output(
            200,
            "customizationContentScopeSchema",
            &scope(&context, &runtime)?,
        );
    }
    let spec = spec.unwrap();
    let attempt: Result<Response> = async {
        let Some(runtime) = service.model_routing.runtime_for_context(&owner, &context).await? else {
            return Ok(error(409, format!("Choose a model before {}.", spec.choose)));
        };
        let scope = scope(&context, &runtime)?;
        if input.as_ref().is_some_and(|i| i["scope"].stringify() != scope.stringify()) {
            return Ok(error(409, "Customization scope changed."));
        }
        let mut command = json!({"type":spec.name,"operationId":id,"serverId":service.server_id,
            "scope":scope,"cwd":context["cwd"],"model":runtime["model"],"provider":runtime["provider"]});
        if spec.thread { command["threadId"] = context["threadId"].clone(); }
        if spec.name == "customization.inventory.read" {
            command["forceReload"] = json!(query.get("refresh").is_some_and(|v| v == "true"));
        }
        if let Some(input) = &input { command["protectedRequest"] = input["protectedRequest"].clone(); }
        let raw = service.workers.commands.request(&worker, command, None, None).await?;
        let response = crate::settings::parse_response("protectedCustomizationResponseSchema", raw.as_ref())?;
        anyhow::ensure!(response["operationId"] == id && response["operation"] == spec.name
            && response["scope"].stringify() == scope.stringify(),
            "Protected customization response targets another operation.");
        if spec.invalidate && response["result"] == "succeeded" {
            service.chat_mutations.publish_invalidation(&owner, &chat, "customization", None);
        }
        output(spec.status, "protectedCustomizationResponseSchema", &response)
    }.await;
    match attempt {
        Ok(response) => Ok(response),
        Err(cause) => Ok(error(
            downcast_ref::<CommandFailure>(&cause).map_or(502, |e| e.status(502)),
            crate::settings::operation_error_message(&cause),
        )),
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(chat): Path<String>,
    matched: MatchedPath,
    request: Request,
) -> Response {
    let method = request.method().clone();
    let query = super::account::query(request.uri());
    let input = if method != Method::GET && method != Method::HEAD {
        let binary = (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024;
        match body::parse_js_buffer(request, service.config.api_body_limit_bytes, binary).await {
            Ok(value) => value,
            Err(response) => return response,
        }
    } else {
        None
    };
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let work = execute(
        service.clone(),
        owner,
        chat,
        matched.as_str().into(),
        method,
        query,
        input,
    );
    match service.scratch_roots.owned(work).await {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/chats/{chatId}/skills", get(handle))
        .route("/api/chats/{chatId}/customizations/target", get(handle))
        .route("/api/chats/{chatId}/customizations", get(handle))
        .route(
            "/api/chats/{chatId}/customizations/external-preview",
            get(handle),
        )
        .route(
            "/api/chats/{chatId}/customizations/mcp-resource",
            post(handle),
        )
        .route("/api/chats/{chatId}/customizations/skill", patch(handle))
        .route(
            "/api/chats/{chatId}/customizations/skill-roots",
            put(handle),
        )
        .route("/api/chats/{chatId}/customizations/mcp-oauth", post(handle))
        .route(
            "/api/chats/{chatId}/customizations/mcp-oauth/status",
            post(handle),
        )
        .route(
            "/api/chats/{chatId}/customizations/mcp-reload",
            post(handle),
        )
        .route(
            "/api/chats/{chatId}/customizations/external-import",
            post(handle),
        )
        .route(
            "/api/chats/{chatId}/customizations/external-import/status",
            post(handle),
        )
}
