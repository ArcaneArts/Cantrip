//! Public interaction inspection and visible/protected worker replies.
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    agent_interactions::Repository,
    auth::service::AuthService,
    chats::{self, computer_use_authority},
    database::Executor,
    operations::shared_failure::downcast_ref,
    wire::{JsString, Value, coercion::truthy, value::json},
    workers::command_bus::CommandFailure,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::Method,
    response::Response,
    routing::{get, post},
};
use std::{collections::HashMap, sync::Arc, time::Duration};

fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Interaction identity")?
        .lossy()
        .into_owned())
}
fn unavailable(cause: &anyhow::Error) -> bool {
    matches!(downcast_ref::<CommandFailure>(cause), Some(CommandFailure::Bridge(error)) if error.unavailable)
}
fn worker_failure(cause: &anyhow::Error) -> Response {
    let status = downcast_ref::<CommandFailure>(cause).map_or(409, |e| e.status(409));
    let mut message = JsString::from("The runtime no longer accepts this interaction: ")
        .units()
        .to_vec();
    message.extend(crate::settings::operation_error_message(cause).units());
    error(status, JsString::new(message))
}
async fn resolve(
    service: &Arc<AuthService>,
    owner: &str,
    id: &str,
    input: &Value,
    protected: bool,
    accepted: bool,
) -> Result<Response> {
    let interaction = service
        .chat_mutations
        .resolve_interaction(owner, id, input, protected, accepted)
        .await?;
    output(
        200,
        "agentInteractionRequestWireSchema",
        &interaction.unwrap_or(Value::Null),
    )
}
async fn computer_use(
    service: &Arc<AuthService>,
    owner: &str,
    existing: &Value,
    input: &Value,
    protected: bool,
) -> Result<Response> {
    if !protected {
        return Ok(error(
            409,
            "Computer-use approvals require a protected response.",
        ));
    }
    let operation: Result<Response> = async {
        let provenance = &existing["provenance"];
        let preview = ["threadId", "turnId", "itemId", "executionLaneId"].iter().all(|key| provenance[*key].is_null());
        let context = if truthy(provenance.get("chatId")) {
            chats::Repository::new(service.repository.database.clone())
                .execution_context(owner, &text(&provenance["chatId"])?).await?
        } else { None };
        let Some(context) = context.filter(|c| c["workerId"] == provenance["workerId"]
            && (preview || c["executionLaneId"] == provenance["executionLaneId"])
            && (existing["status"] == "pending" || existing["status"] == "resolved")) else {
            return Ok(error(409, "The computer-use approval is no longer active."));
        };
        // Source validates current authority even on a durable replay, but
        // never sends another authorization request for an acknowledged row.
        let mut authority = computer_use_authority::preview(owner, &service.server_id, &context)?;
        if !preview {
            authority["executionLaneId"] = context["executionLaneId"].clone();
            authority = crate::settings::parse_response("cuaAgentAuthoritySchema", Some(&authority))?;
        }
        if existing["status"] == "pending" {
            let mut command = json!({"type":"computer-use.approval.respond","ownerId":owner,
                "chatId":context["chatId"],"executionLaneId":if preview{Value::Null}else{context["executionLaneId"].clone()},
                "requestKey":existing["requestKey"],"response":json!({"classification":input["classification"],"protectedResponse":input["protectedResponse"]})});
            command[if preview{"previewAuthority"}else{"agentAuthority"}] = authority;
            let attempt: Result<()> = async {
                let value = service.workers.commands.request(&text(&context["workerId"])?, command, Some(Duration::from_secs(30)), None).await?;
                crate::settings::parse_response("agentInteractionAcceptedSchema", value.as_ref())?;
                Ok(())
            }.await;
            if let Err(cause) = attempt {
                return Ok(error(if unavailable(&cause){503}else{409}, "The worker no longer accepts this computer-use approval."));
            }
        }
        resolve(service, owner, &text(&existing["id"])?, input, true, false).await
    }.await;
    match operation {
        Ok(response) => Ok(response),
        Err(cause) => Ok(error(
            if downcast_ref::<crate::agent_interactions::Conflict>(&cause).is_some() {
                409
            } else {
                503
            },
            "The computer-use approval could not be resolved.",
        )),
    }
}
async fn respond(
    service: &Arc<AuthService>,
    owner: &str,
    id: &str,
    input: &Value,
) -> Result<Response> {
    let protected = input.get("protectedResponse").is_some();
    let repository = Repository::new(Executor::Database(&service.repository.database));
    let Some(existing) = repository
        .validate_resolution(owner, id, input, protected)
        .await?
    else {
        return Ok(error(404, "Agent request not found."));
    };
    if existing["provenance"]["owner"] == "computer-use" {
        return computer_use(service, owner, &existing, input, protected).await;
    }
    if existing["status"] != "pending" {
        return resolve(service, owner, id, input, protected, false).await;
    }
    if !truthy(existing["provenance"].get("chatId")) {
        return Ok(error(
            409,
            "The interaction is not associated with an active chat.",
        ));
    }
    let control = crate::native_commands::Repository::new(service.repository.database.clone())
        .control_context(owner, &text(&existing["provenance"]["chatId"])?)
        .await?;
    let context = &control["context"];
    if context.is_null()
        || context["workerId"] != existing["provenance"]["workerId"]
        || context["executionLaneId"] != existing["provenance"]["executionLaneId"]
    {
        return Ok(error(
            409,
            "The interaction execution lane is no longer active.",
        ));
    }
    let worker = text(&context["workerId"])?;
    if !service.workers.commands.is_connected(&worker) {
        return Ok(error(503, "Project worker is offline."));
    }
    let native = truthy(control.get("activationGeneration"));
    let runtime = if native {
        None
    } else {
        service
            .model_routing
            .runtime_for_context(owner, context)
            .await?
    };
    if !native && runtime.is_none() {
        return Ok(error(409, "Selected model was not found."));
    }
    let command = if native {
        let mut reply = json!({"kind":"reply","requestKey":existing["requestKey"]});
        if protected {
            reply["protectedResponse"] = json!({"classification":input["classification"],"protectedResponse":input["protectedResponse"]});
        } else {
            reply["response"] = input["response"].clone();
        }
        json!({"type":"chat.native-control","chatId":context["chatId"],"threadId":context["threadId"],
            "nativeActivationGeneration":control["activationGeneration"],"nativeRuntimeGeneration":control["runtimeGeneration"],
            "modelRouteId":context["modelRouteId"],"providerAccountId":context["providerAccountId"],"control":reply})
    } else {
        let runtime = runtime.as_ref().expect("Selected interaction runtime");
        json!({"type":if protected{"agent.interaction.respond.protected"}else{"agent.interaction.respond"},
            "chatId":context["chatId"],"threadId":context["threadId"],
            "executionProfile":if context["contextKind"]=="standalone"{"standalone-chat"}else{"ide"},
            "requestKey":existing["requestKey"],
            "response":if protected{json!({"classification":input["classification"],"protectedResponse":input["protectedResponse"]})}else{input["response"].clone()},
            "model":runtime["model"],"provider":runtime["provider"]})
    };
    let attempt: Result<()> = async {
        let result = service
            .workers
            .commands
            .request(&worker, command, Some(Duration::from_secs(30)), None)
            .await?;
        crate::settings::parse_response("agentInteractionAcceptedSchema", result.as_ref())?;
        Ok(())
    }
    .await;
    if let Err(cause) = attempt {
        return Ok(worker_failure(&cause));
    }
    resolve(service, owner, id, input, protected, true).await
}
async fn execute(
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    method: Method,
    query: Value,
    input: Option<Value>,
) -> Result<Response> {
    if method == Method::POST {
        let input = match parse("agentInteractionResolutionWireCreateSchema", input.as_ref())? {
            Ok(value) => value,
            Err(response) => return Ok(response),
        };
        return match respond(&service, &owner, &params["requestId"], &input).await {
            Ok(response) => Ok(response),
            Err(cause) if downcast_ref::<crate::agent_interactions::Conflict>(&cause).is_some() => {
                Ok(error(409, cause.to_string()))
            }
            Err(cause) if unavailable(&cause) => {
                Ok(error(503, crate::settings::operation_error_message(&cause)))
            }
            Err(cause) => Err(cause),
        };
    }
    let repository = Repository::new(Executor::Database(&service.repository.database));
    if let Some(id) = params.get("requestId") {
        return match repository.get(&owner, id).await? {
            Some(value) => output(200, "agentInteractionRequestWireSchema", &value),
            None => Ok(error(404, "Agent request not found.")),
        };
    }
    let query = match parse("agentInteractionRequestQuerySchema", Some(&query))? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    let values = Value::Array(repository.list(&owner, &query).await?);
    output(200, "agentInteractionRequestWireListSchema", &values)
}
async fn handler(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let method = request.method().clone();
    let query = super::account::query(request.uri());
    let input = if method == Method::POST {
        let binary = (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024;
        match body::parse_js_buffer(request, service.config.api_body_limit_bytes, binary).await {
            Ok(value) => value,
            Err(response) => return response,
        }
    } else {
        None
    };
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let operation = execute(service.clone(), owner, params, method, query, input);
    match service.scratch_roots.owned(operation).await {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/agent-requests", get(handler))
        .route("/api/agent-requests/{requestId}", get(handler))
        .route("/api/agent-requests/{requestId}/respond", post(handler))
}
