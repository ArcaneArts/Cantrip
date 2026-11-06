//! Durable project relocation admission and owner-scoped job controls.
use super::{
    body, json_response,
    middleware::{self, Context},
    on_response,
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    chats::relocations::Error,
    projects::{
        placement::{PlacementRepository, Unavailable},
        repository::ProjectRepository,
        targets::TargetRepository,
    },
    wire::{Value, value::json},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, post},
};
use std::{collections::HashMap, sync::Arc};

async fn project(
    service: &AuthService,
    owner: &str,
    id: &str,
) -> Result<Result<Option<Value>, Response>> {
    let project = ProjectRepository::new(service.repository.database.clone())?
        .get(owner, id)
        .await?;
    if let Some(project) = project
        .as_ref()
        .filter(|p| p["capabilities"]["relocation"] != true)
    {
        return Ok(Err(json_response(
            StatusCode::CONFLICT,
            json!({"code":"project-capability-unavailable","capability":"relocation","error":format!("This {} project does not support the relocation capability.",project["originKind"].as_str().unwrap_or("undefined"))}),
        )));
    }
    Ok(Ok(project))
}
async fn catalog(
    service: &AuthService,
    owner: &str,
    params: &HashMap<String, String>,
) -> Result<Response> {
    let repository = &service.chat_relocations.repository;
    if let Some(chat) = params.get("chatId") {
        let Some(context) = crate::chats::Repository::new(service.repository.database.clone())
            .execution_context(owner, chat)
            .await?
        else {
            return Ok(error(404, "Chat not found."));
        };
        if context["contextKind"] != "project" {
            return Ok(error(
                409,
                "Standalone Chats do not support durable project relocation.",
            ));
        }
        if let Err(response) = project(
            service,
            owner,
            context["projectId"]
                .as_str()
                .context("Relocation project")?,
        )
        .await?
        {
            return Ok(response);
        }
        return output(
            200,
            "chatRelocationJobListSchema",
            &repository.list(owner, chat).await?,
        );
    }
    match repository.get(owner, &params["jobId"]).await? {
        Some(job) => {
            if let Err(response) = project(
                service,
                owner,
                job["projectId"].as_str().context("Relocation project")?,
            )
            .await?
            {
                return Ok(response);
            }
            output(200, "chatRelocationJobSummarySchema", &job)
        }
        None => Ok(error(404, "Chat relocation not found.")),
    }
}
async fn mutate(
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    action: String,
    input: Value,
) -> Result<Response> {
    let repository = &service.chat_relocations.repository;
    if let Some(chat) = params.get("chatId") {
        let Some(context) = crate::chats::Repository::new(service.repository.database.clone())
            .execution_context(&owner, chat)
            .await?
        else {
            return Ok(error(404, "Chat not found."));
        };
        if context["contextKind"] != "project" {
            return Ok(error(
                409,
                "Standalone Chats do not support durable project relocation.",
            ));
        }
        let id = context["projectId"]
            .as_str()
            .context("Relocation project")?;
        match project(&service, &owner, id).await? {
            Err(response) => return Ok(response),
            Ok(None) => return Ok(error(404, "Project not found.")),
            Ok(Some(_)) => {}
        }
        let admitted:Result<Value>=async {
            let connected=|worker:&str|service.workers.bridge.is_connected(worker);
            let resolution=PlacementRepository::new(service.repository.database.clone())?.resolve(&owner,id,"chat",Some(&input["target"]),Some(&connected),true).await?;
            let targets=TargetRepository::new(service.repository.database.clone());
            let (source,target)=tokio::try_join!(targets.worker(&owner,&context["workerId"]),targets.worker(&owner,&resolution["placement"]["workerId"]))?;
            if !source.as_ref().is_some_and(|w|crate::wire::coercion::truthy(w.get("chatRelocation")))||!target.as_ref().is_some_and(|w|crate::wire::coercion::truthy(w.get("chatRelocation"))) {
                return Err(Error::Conflict("Both workers must be upgraded to a version that supports durable chat relocation.".into()).into());
            }
            repository.create(&owner,context["chatId"].as_str().context("Relocation chat")?,&resolution["placement"],input["idempotencyKey"].as_str().context("Relocation idempotency key")?).await
        }.await;
        return match admitted {
            Ok(job) => {
                service.chat_relocations.publish(&owner, &job, None);
                service.chat_relocations.queue();
                output(202, "chatRelocationJobSummarySchema", &job)
            }
            Err(cause) => {
                if let Some(error) = cause.downcast_ref::<Error>() {
                    return match error {
                        Error::NotFound(_) => Ok(super::settings::error(404, error.to_string())),
                        Error::Conflict(_) => Ok(super::settings::error(409, error.to_string())),
                        _ => Err(cause),
                    };
                }
                if let Some(error) = cause.downcast_ref::<Unavailable>() {
                    return Ok(super::settings::error(
                        if error.code == "project-not-found" {
                            404
                        } else {
                            409
                        },
                        error.message.clone(),
                    ));
                }
                Err(cause)
            }
        };
    }
    let id = &params["jobId"];
    if let Some(job) = repository.get(&owner, id).await?
        && let Err(response) = project(
            &service,
            &owner,
            job["projectId"].as_str().context("Relocation project")?,
        )
        .await?
    {
        return Ok(response);
    }
    let revision = input["stateRevision"]
        .as_f64()
        .context("Relocation revision")?;
    let result = if action == "retry" {
        repository.retry(&owner, id, revision).await
    } else {
        repository.cancel(&owner, id, revision).await
    };
    match result {
        Ok(job) => {
            service.chat_relocations.publish(&owner, &job, None);
            if action == "retry" {
                service.chat_relocations.queue();
            }
            output(200, "chatRelocationJobSummarySchema", &job)
        }
        Err(cause) => match cause.downcast_ref::<Error>() {
            Some(Error::NotFound(_)) => Ok(error(404, "Chat relocation not found.")),
            Some(Error::Conflict(message)) => Ok(error(409, message.clone())),
            _ => Err(cause),
        },
    }
}
async fn execute(
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    request: Request,
) -> Result<Response> {
    if matches!(*request.method(), Method::GET | Method::HEAD) {
        if let Some(response) = standalone_guard(&service, &owner, &params).await? {
            return Ok(response);
        }
        return catalog(&service, &owner, &params).await;
    }
    let action = if request.uri().path().ends_with("/retry") {
        "retry"
    } else {
        "cancel"
    }
    .to_owned();
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    if let Some(response) = standalone_guard(&service, &owner, &params).await? {
        return Ok(response);
    }
    let schema = if params.contains_key("chatId") {
        "chatRelocationCreateSchema"
    } else if action == "retry" {
        "chatRelocationJobRetrySchema"
    } else {
        "chatRelocationJobCancelSchema"
    };
    let input = match parse(schema, body.as_ref())? {
        Ok(input) => input,
        Err(response) => return Ok(response),
    };
    service
        .chat_relocations
        .owned(mutate(service.clone(), owner, params, action, input))
        .await
}
// Source's project-context hook runs after body parsing and before route schema
// validation. The handler subsequently resolves its own current chat context.
async fn standalone_guard(
    service: &AuthService,
    owner: &str,
    params: &HashMap<String, String>,
) -> Result<Option<Response>> {
    let Some(chat) = params.get("chatId") else {
        return Ok(None);
    };
    Ok(
        crate::chats::Repository::new(service.repository.database.clone())
            .execution_context(owner, chat)
            .await?
            .filter(|context| context["contextKind"] == "standalone")
            .map(|_| {
                error(
                    409,
                    "This IDE-only Chat feature is unavailable in standalone Chat.",
                )
            }),
    )
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let catalog = (request.method() == Method::POST)
        .then(|| params.get("chatId").cloned())
        .flatten();
    match execute(service.clone(), owner.clone(), params, request).await {
        Ok(response) if response.status().as_u16() < 400 && catalog.is_some() => {
            let live = service.live.clone();
            let chat = catalog.unwrap();
            on_response::completed(response, move || live.invalidate(&owner, "chat", &chat))
        }
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/chats/{chatId}/relocations", get(handle).post(handle))
        .route("/api/chat-relocations/{jobId}", get(handle))
        .route("/api/chat-relocations/{jobId}/retry", post(handle))
        .route("/api/chat-relocations/{jobId}/cancel", post(handle))
}
