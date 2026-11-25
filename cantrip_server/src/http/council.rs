mod creation;
mod history;
pub(super) mod inventory;
mod memory;

use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    chats::{Repository, council},
    wire::{Value, value::json},
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::Method,
    response::Response,
    routing::{get, patch},
};
use std::sync::Arc;

pub(super) async fn execute_agent_operation(
    service: &Arc<AuthService>,
    owner: &str,
    context: &Value,
    operation: &str,
    arguments: &Value,
) -> Result<Value> {
    use super::agent_operations::OperationError;
    if context.get("councilAgent").is_none() {
        return Err(OperationError::new(
            403,
            "forbidden",
            "This operation requires an active Council agent.",
        )
        .into());
    }
    let repository = Repository::new(service.repository.database.clone());
    match operation {
        "council.list" => {
            let agents = repository.council_agents(owner).await?;
            Ok(json!({"summary":"Loaded the Council roster.","data":json!({"agents":agents})}))
        }
        "council.create" => {
            let input = super::agent_operations::parse("councilAgentCreateSchema", arguments)?;
            let agent = repository
                .create_council_agent(owner, input, |_| false)
                .await?;
            service.scratch_roots.queue();
            let _ = service
                .live
                .publish_event(council::notification(owner, &agent));
            Ok(
                json!({"summary":"Created a Council agent.","mutated":true,"data":json!({"agent":agent})}),
            )
        }
        "council.history.search" | "council.history.read" => {
            history::execute_agent_operation(&repository, owner, context, operation, arguments)
                .await
        }
        "council.inventory" => inventory::read(service, owner, arguments).await,
        "council.project.send" => {
            super::agent_chat_send::execute_council(service, owner, context, arguments).await
        }
        "council.project.chat.create" => creation::chat(service, owner, context, arguments).await,
        "council.project.task.create" => creation::task(service, owner, context, arguments).await,
        _ => {
            memory::execute_agent_operation(&repository, owner, context, operation, arguments).await
        }
    }
}

async fn execute(
    service: Arc<AuthService>,
    context: &Context,
    id: Option<String>,
    request: Request,
) -> Result<Response> {
    let owner = &context.principal.user.as_ref().expect("Council owner").id;
    let repository = Repository::new(service.repository.database.clone());
    if matches!(*request.method(), Method::GET | Method::HEAD) {
        return output(
            200,
            "councilAgentWireListSchema",
            &Value::Array(repository.council_agents(owner).await?),
        );
    }
    let schema = if id.is_some() {
        "councilAgentUpdateSchema"
    } else {
        "councilAgentCreateSchema"
    };
    let input = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(input) => input,
        Err(response) => return Ok(response),
    };
    let input = match parse(schema, input.as_ref())? {
        Ok(input) => input,
        Err(response) => return Ok(response),
    };
    if id.is_some() && council::empty_update(&input) {
        return Ok(error(400, "Change at least one Council agent field."));
    }
    let owner = owner.to_owned();
    let root_service = service.scratch_roots.clone();
    root_service
        .owned(async move {
            let (status, result) = if let Some(id) = id {
                (
                    200,
                    repository.update_council_agent(&owner, &id, input).await,
                )
            } else {
                let result = repository
                    .create_council_agent(&owner, input, |id| {
                        service.workers.bridge.is_connected(id)
                    })
                    .await;
                if result.is_ok() {
                    service.scratch_roots.queue();
                }
                (202, result)
            };
            match result {
                Ok(agent) => {
                    let _ = service
                        .live
                        .publish_event(council::notification(&owner, &agent));
                    output(status, "councilAgentWireSummarySchema", &agent)
                }
                Err(cause) => match cause.downcast_ref::<council::RosterError>() {
                    Some(council::RosterError::NotFound) => Ok(error(404, cause.to_string())),
                    Some(_) => Ok(error(409, cause.to_string())),
                    None => Err(cause),
                },
            }
        })
        .await
}

async fn collection(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    match execute(service.clone(), &context, None, request).await {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &context.id, &cause),
    }
}
async fn update(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(id): Path<String>,
    request: Request,
) -> Response {
    match execute(service.clone(), &context, Some(id), request).await {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &context.id, &cause),
    }
}

async fn conversation(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(id): Path<String>,
) -> Response {
    let owner = &context.principal.user.as_ref().expect("Council owner").id;
    let repository = Repository::new(service.repository.database.clone());
    let result = match repository.council_conversation(owner, &id).await {
        Ok(Some(chat)) => output(200, "standaloneChatWireSummarySchema", &chat),
        Ok(None) => Ok(error(404, "Council agent not found.")),
        Err(cause) => Err(cause),
    };
    result.unwrap_or_else(|cause| middleware::failure(&service, &context.id, &cause))
}

pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .merge(history::routes())
        .route("/api/council/agents", get(collection).post(collection))
        .route("/api/council/agents/{agentId}", patch(update))
        .route("/api/council/agents/{agentId}/chat", get(conversation))
        .route(
            "/api/council/agents/{agentId}/memory",
            get(memory::handle).put(memory::handle),
        )
}
