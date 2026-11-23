mod project_creation;
use super::{
    body, json_response,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    chats::{Repository, catalog::StandaloneUnavailable},
    wire::{Value, value::json},
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, post},
};
use std::sync::Arc;

fn duplicate(error: &anyhow::Error) -> bool {
    if let Some(error) = error.downcast_ref::<crate::chats::catalog::StatementFailure>() {
        return error.duplicate_message;
    }
    let text = error.to_string().to_lowercase();
    text.contains("unique") || text.contains("duplicate")
}
async fn create(service: Arc<AuthService>, owner: String, input: Value) -> Result<Response> {
    match Repository::new(service.repository.database.clone())
        .create_standalone(&owner, &input, |id| service.workers.bridge.is_connected(id))
        .await
    {
        Ok(created) => {
            let _=service.live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"current-user"}),"resource":"chat","action":"invalidated","entityId":created["chat"]["id"],"revision":Value::Null,"payload":Value::Null}));
            service.scratch_roots.queue();
            output(202, "standaloneChatWireSummarySchema", &created["chat"])
        }
        Err(e) if e.is::<StandaloneUnavailable>() => Ok(json_response(
            StatusCode::CONFLICT,
            json!({"code":"standalone-worker-unavailable","error":e.to_string()}),
        )),
        Err(e) if duplicate(&e) => Ok(error(409, "Chat already exists.")),
        Err(e) => Err(e),
    }
}
async fn cleanup_archives(service: Arc<AuthService>, owner: String) -> Result<Response> {
    // These are independent commits in the reference. A later scratch failure
    // must not roll back project cleanup or discard its already accepted writes.
    let deleted = Repository::new(service.repository.database.clone())
        .purge_expired_project_chats(&owner, crate::auth::now() - chrono::Duration::days(90))
        .await?;
    let standalone = service
        .scratch_roots
        .purge_archived_for_owner(&owner)
        .await?;
    output(
        200,
        "archivedChatCleanupResultSchema",
        &json!({"deleted": deleted + standalone}),
    )
}
async fn execute(
    service: Arc<AuthService>,
    ctx: &Context,
    route: &str,
    request: Request,
) -> Result<Response> {
    let owner = ctx
        .principal
        .user
        .as_ref()
        .expect("Authenticated Chat owner")
        .id
        .clone();
    if matches!(*request.method(), Method::GET | Method::HEAD) {
        let archived = route == "/api/chats/archived";
        if super::account::query(request.uri())["context"] != "standalone" {
            return Ok(error(
                400,
                if archived {
                    "Archived standalone Chat lists require context=standalone."
                } else {
                    "Standalone Chat lists require context=standalone."
                },
            ));
        }
        let repository = Repository::new(service.repository.database.clone());
        let chats = if archived {
            repository.list_archived_standalone(&owner).await?
        } else {
            repository.list_standalone(&owner).await?
        };
        return Ok(json_response(StatusCode::OK, Value::Array(chats)));
    }
    if route == "/api/chats/archives/cleanup" {
        // The Source route ignores a successfully parsed body, including null
        // and unknown fields. Ordinary parsing/authentication still apply.
        let binary_limit = (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024;
        if let Err(response) =
            body::parse_ignored(request, service.config.api_body_limit_bytes, binary_limit).await
        {
            return Ok(response);
        }
        return service
            .scratch_roots
            .owned(cleanup_archives(service.clone(), owner))
            .await;
    }
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let input = match parse("encryptedStandaloneChatCreateSchema", body.as_ref())? {
        Ok(input) => input,
        Err(response) => return Ok(response),
    };
    service
        .scratch_roots
        .owned(create(service.clone(), owner, input))
        .await
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    route: MatchedPath,
    request: Request,
) -> Response {
    match execute(service.clone(), &ctx, route.as_str(), request).await {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}
async fn project_list(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(project): Path<String>,
    route: MatchedPath,
) -> Response {
    let owner = &context
        .principal
        .user
        .as_ref()
        .expect("Authenticated Chat owner")
        .id;
    let repository = Repository::new(service.repository.database.clone());
    let result = if route.as_str().ends_with("/archived-chats") {
        repository.list_archived_project(owner, &project).await
    } else {
        repository.list_project(owner, &project).await
    };
    match result {
        Ok(chats) => json_response(StatusCode::OK, Value::Array(chats)),
        Err(cause) => middleware::failure(&service, &context.id, &cause),
    }
}
async fn project_create(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(project): Path<String>,
    request: Request,
) -> Response {
    let result = async {
        let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(body) => body,
            Err(response) => return Ok(response),
        };
        let input = match parse("encryptedChatCreateSchema", body.as_ref())? {
            Ok(input) => input,
            Err(response) => return Ok(response),
        };
        let owner = context
            .principal
            .user
            .as_ref()
            .expect("Authenticated Chat owner")
            .id
            .clone();
        service
            .scratch_roots
            .owned(project_creation::create(
                service.clone(),
                owner,
                project,
                input,
            ))
            .await
    }
    .await;
    match result {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &context.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/chats", get(handle).post(handle))
        .route("/api/chats/archived", get(handle))
        .route("/api/chats/archives/cleanup", post(handle))
        .route(
            "/api/projects/{projectId}/chats",
            get(project_list).post(project_create),
        )
        .route(
            "/api/projects/{projectId}/archived-chats",
            get(project_list),
        )
}
