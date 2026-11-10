//! Plan reads retain encrypted history; mode changes await the actual native write.
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    chats::{self, managed_console},
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::Method,
    response::Response,
    routing::get,
};
use std::sync::Arc;

fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Plan identity")?
        .lossy()
        .into_owned())
}
async fn stored(service: &AuthService, owner: &str, chat: &str) -> Result<Response> {
    match chats::Repository::new(service.repository.database.clone())
        .plan_wire_state(owner, chat)
        .await?
    {
        Some(state) => output(200, "encryptedChatPlanWireStateSchema", &state),
        None => Ok(error(404, "Chat source not found.")),
    }
}
async fn read(service: &AuthService, owner: &str, chat: &str) -> Result<Response> {
    let repository = chats::Repository::new(service.repository.database.clone());
    if repository.plan_wire_state(owner, chat).await?.is_none() {
        return Ok(error(404, "Chat source not found."));
    }
    // Execution placement can be unavailable while saved plan/question history
    // remains readable. Refresh is an actual native observation, never a load.
    let refresh: Result<()> = async {
        let Some(context) = repository.execution_context(owner, chat).await? else { return Ok(()) };
        if !truthy(context.get("threadId")) { return Ok(()) }
        let worker = text(&context["workerId"])?;
        if !service.workers.commands.is_connected(&worker) { return Ok(()) }
        let Some(runtime) = service.model_routing.runtime_for_context(owner, &context).await? else { return Ok(()) };
        let reply = service.workers.commands.request(&worker, json!({
            "type":"chat.plan.get","cwd":context["cwd"],"threadId":context["threadId"],"fallbackMode":context["planMode"],
            "model":runtime["model"],"provider":runtime["provider"],"permissionProfileId":managed_console::permission_profile(&context)["effectiveId"]
        }), None, None).await?;
        if let Some(mode) = reply.as_ref().and_then(|reply| reply.get("mode")) {
            let parsed = crate::settings::parse_response("chatPlanUpdateSchema", Some(&json!({"mode":mode})))?;
            if parsed["mode"] != context["planMode"] {
                service.chat_mutations.update_plan_mode(owner, chat, &text(&parsed["mode"])?).await?;
            }
        }
        Ok(())
    }.await;
    if let Err(cause) = refresh {
        (crate::operations::logging::server_logger())(crate::operations::logging::LogCall::event(
            "warn",
            "Could not refresh native Plan Mode state",
            json!({"chatId":chat,"err":crate::operations::logging::error_details(&cause)}),
        ));
    }
    stored(service, owner, chat).await
}
async fn change(service: &AuthService, owner: &str, chat: &str, input: &Value) -> Result<Response> {
    let repository = chats::Repository::new(service.repository.database.clone());
    let Some(context) = repository.execution_context(owner, chat).await? else {
        return Ok(error(404, "Chat source not found."));
    };
    if context["status"] == "running" {
        return Ok(error(409, "Wait for the active turn to finish."));
    }
    let worker = text(&context["workerId"])?;
    if !service.workers.commands.is_connected(&worker) {
        return Ok(error(503, "Project worker is offline."));
    }
    let result: Result<Response> = async {
        let model = service.model_routing.resolve_model_id(owner, &context, None).await?;
        let runtime = match service.model_routing.runtime_for_context(owner, &context).await? {
            Some(runtime) => runtime,
            None => service.model_routing.available_runtimes(owner, &context, &text(&model)?).await?.into_iter().next().context("Selected model was not found.")?,
        };
        let same_route = runtime["routeId"] == context["modelRouteId"]
            && runtime["provider"].get("accountId").unwrap_or(&Value::Null) == &context["providerAccountId"];
        let reply = service.workers.commands.request(&worker, json!({
            "type":"chat.plan.set","cwd":context["cwd"],"threadId":if same_route {context["threadId"].clone()}else{Value::Null},"mode":input["mode"],
            "model":runtime["model"],"provider":runtime["provider"],"permissionProfileId":managed_console::permission_profile(&context)["effectiveId"]
        }), None, None).await?.context("Codex did not return a Plan Mode thread.")?;
        let mode = crate::settings::parse_response("chatPlanUpdateSchema", Some(&json!({"mode":reply["mode"]})))?;
        let thread = reply["threadId"].as_str().filter(|id| !id.is_empty()).context("Codex did not return a Plan Mode thread.")?;
        repository.update_runtime(chats::RuntimeUpdate {
            chat:chat.into(),worker:text(&context["workerId"])?,worktree:context["worktreeId"].as_str().map(str::to_owned),
            scratch_root:context["scratchRootId"].as_str().map(str::to_owned),thread:Some(thread.into()),route:text(&runtime["routeId"])?,status:"ready".into(),
            provider_account:Some(runtime["provider"].get("accountId").and_then(Value::as_str).map(str::to_owned)),
        }).await?;
        let state = service.chat_mutations.update_plan_mode(owner, chat, &text(&mode["mode"])?).await?.context("Chat source not found.")?;
        output(200, "encryptedChatPlanWireStateSchema", &state)
    }.await;
    result.or_else(|cause| Ok(error(409, crate::settings::operation_error_message(&cause))))
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(chat): Path<String>,
    request: Request,
) -> Response {
    let result: Result<Response> = async {
        let owner = context
            .principal
            .user
            .as_ref()
            .context("Authenticated Plan owner")?
            .id
            .clone();
        if matches!(*request.method(), Method::GET | Method::HEAD) {
            return read(&service, &owner, &chat).await;
        }
        let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(body) => body,
            Err(response) => return Ok(response),
        };
        let input = match parse("chatPlanUpdateSchema", body.as_ref())? {
            Ok(input) => input,
            Err(response) => return Ok(response),
        };
        let owned_service = service.clone();
        service
            .worker_maintenance
            .owned(async move { change(&owned_service, &owner, &chat, &input).await })
            .await
    }
    .await;
    result.unwrap_or_else(|cause| middleware::failure(&service, &context.id, &cause))
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route("/api/chats/{chatId}/plan", get(handle).patch(handle))
}
