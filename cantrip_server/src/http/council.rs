use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    chats::{Repository, council},
    wire::Value,
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

pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/council/agents", get(collection).post(collection))
        .route("/api/council/agents/{agentId}", patch(update))
}
