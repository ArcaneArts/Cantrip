//! User Chat placement/lane controls retain their durable repository behavior.
mod compact;
use super::{
    body, json_response,
    middleware::{self, Context},
    on_response,
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    chats::{
        Repository,
        execution_lanes::{LaneError, LaneRepository},
        live_mutations::{MessageOptions, WorkerUnavailable},
        message_queries::MessageKind,
    },
    projects::repository::ProjectRepository,
    wire::{Value, value::json},
    workers::command_bus::CommandFailure,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, patch, post},
};
use std::{collections::HashMap, sync::Arc};

async fn change_worktree(
    service: &AuthService,
    owner: &str,
    chat: &str,
    raw: Option<&Value>,
) -> Result<Response> {
    let input = match parse("chatWorktreeUpdateSchema", raw)? {
        Ok(v) => v,
        Err(response) => return Ok(response),
    };
    let repository = Repository::new(service.repository.database.clone());
    let context = repository.execution_context(owner, chat).await?;
    if let Some(context) = context {
        if context["contextKind"] == "standalone" {
            return Ok(error(
                409,
                "Standalone Chats do not have project worktrees.",
            ));
        }
        if let Some(project) = ProjectRepository::new(service.repository.database.clone())?
            .get(
                owner,
                context["projectId"].as_str().context("Chat project")?,
            )
            .await?
            && project["capabilities"]["worktrees"] != true
        {
            return Ok(json_response(
                StatusCode::CONFLICT,
                json!({"code":"project-capability-unavailable","capability":"worktrees","error":format!("This {} project does not support the worktrees capability.",project["originKind"].as_str().unwrap_or("undefined"))}),
            ));
        }
    }
    // These context/capability reads are outside Source's custom error boundary.
    let updated = async {
        match repository
            .update_worktree(owner, chat, &input, None)
            .await?
        {
            Some(value) => output(200, "chatWireSummarySchema", &value),
            None => Ok(error(404, "Chat or worktree not found.")),
        }
    }
    .await;
    match updated {
        Ok(response) => Ok(response),
        Err(cause) => {
            if cause.downcast_ref::<LaneError>().is_some() {
                return Ok(error(409, crate::settings::operation_error_message(&cause)));
            }
            let class = crate::operations::logging::error_details(&cause)["name"].clone();
            crate::operations::logging::server_logger()(
                crate::operations::logging::LogCall::event(
                    "error",
                    "Log event",
                    json!({"event":"chat.worktree.update.failed","chatId":chat,"errorClass":class}),
                ),
            );
            Ok(error(
                500,
                "Could not update the agent worktree. Try again or reload the agent.",
            ))
        }
    }
}
fn conflict_failure(cause: &anyhow::Error) -> Response {
    let status = if cause.downcast_ref::<WorkerUnavailable>().is_some() {
        503
    } else {
        cause
            .downcast_ref::<CommandFailure>()
            .map_or(409, |e| e.status(409))
    };
    error(status, crate::settings::operation_error_message(cause))
}
async fn release(
    service: &Arc<AuthService>,
    owner: &str,
    chat: &str,
    lane: &str,
    raw: Option<&Value>,
) -> Result<Response> {
    let default = Value::Object(Default::default());
    let input = match parse(
        "chatExecutionLaneReleaseSchema",
        Some(raw.filter(|v| !v.is_null()).unwrap_or(&default)),
    )? {
        Ok(v) => v,
        Err(response) => return Ok(response),
    };
    let repository = LaneRepository::new(service.repository.database.clone());
    let Some(context) = repository.lane_context(owner, chat, lane).await? else {
        return Ok(error(404, "Execution lane not found."));
    };
    if context["lane"]["state"] == "released" {
        return Ok(json_response(
            StatusCode::OK,
            json!({"chat":context["chat"],"lane":context["lane"],"returnedToPrimary":false}),
        ));
    }
    let result=async {
        let worker=context["worktree"]["workerId"].as_str().context("Lane worker")?;
        if !service.workers.bridge.is_connected(worker) {return Err(anyhow::Error::from(WorkerUnavailable))}
        let status=service.workers.commands.request(worker,json!({"type":"worktree.status","sourcePath":context["sourcePath"],"worktreePath":context["worktree"]["path"]}),None,None).await?;
        let status=crate::settings::parse_response("worktreeStatusResultSchema",status.as_ref())?;
        if !status["status"]["files"].as_array().context("Worktree files")?.is_empty() && input["allowDirty"]!=true {return Ok(error(409,"This worktree has uncommitted changes. Pass allowDirty to release it intentionally."))}
        let Some(released)=repository.release(owner,chat,lane,input["returnToPrimary"]==true).await? else{return Ok(error(404,"Execution lane not found."))};
        let name=context["worktree"]["name"].as_str().context("Lane worktree name")?;
        let content=if released["returnedToPrimary"]==true {format!("Released {name}; execution returned to Primary.")}else{format!("Released execution lane for {name}.")};
        service.chat_mutations.write_message(owner,chat,&json!({"role":"system","content":vec![json!({"type":"text","text":content})],"idempotencyKey":format!("lane-release:{lane}")}),MessageOptions{kind:MessageKind::Plain,upsert:false,attribution:Some(&json!({"executionLaneId":lane,"worktreeId":context["worktree"]["id"]})),routing:None}).await?;
        Ok(json_response(StatusCode::OK,released))
    }.await;
    Ok(match result {
        Ok(response) => response,
        Err(cause) => conflict_failure(&cause),
    })
}
async fn execute(
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    route: String,
    method: Method,
    request: Request,
) -> Result<Response> {
    let input = if matches!(method, Method::GET | Method::HEAD) {
        None
    } else {
        match body::parse_js_buffer(
            request,
            service.config.api_body_limit_bytes,
            (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024,
        )
        .await
        {
            Ok(v) => v,
            Err(response) => return Ok(response),
        }
    };
    let chat = &params["chatId"];
    // Source's shared pre-handler runs after body parsing and before the
    // individual worktree/lane handler validates its request schema.
    if !route.ends_with("/compact")
        && Repository::new(service.repository.database.clone())
            .execution_context(&owner, chat)
            .await?
            .is_some_and(|context| context["contextKind"] == "standalone")
    {
        return Ok(error(
            409,
            "This IDE-only Chat feature is unavailable in standalone Chat.",
        ));
    }
    if route.ends_with("/compact") {
        return compact::compact(&service, &owner, chat).await;
    }
    if route.ends_with("/worktree") {
        return change_worktree(&service, &owner, chat, input.as_ref()).await;
    }
    if let Some(lane) = params.get("laneId") {
        return release(&service, &owner, chat, lane, input.as_ref()).await;
    }
    let lanes = LaneRepository::new(service.repository.database.clone())
        .list_chat(&owner, chat)
        .await?;
    output(200, "chatExecutionLaneListSchema", &json!(lanes))
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    matched: MatchedPath,
    request: Request,
) -> Response {
    let owner = context.principal.user.as_ref().unwrap().id.clone();
    let event_owner = owner.clone();
    let chat = params["chatId"].clone();
    let method = request.method().clone();
    let mutation = !matches!(method, Method::GET | Method::HEAD);
    let route = matched.as_str().to_owned();
    let owned = service.clone();
    match service
        .scratch_roots
        .owned(execute(owned, owner, params, route, method, request))
        .await
    {
        Ok(response) if mutation && response.status().as_u16() < 400 => {
            let live = service.live.clone();
            on_response::completed(response, move || {
                let _=live.publish_event(json!({"ownerId":event_owner,"scope":json!({"kind":"current-user"}),"resource":"chat","action":"invalidated","entityId":chat,"revision":Value::Null,"payload":Value::Null}));
            })
        }
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &context.id, &cause),
    }
}
pub(super) fn unregistered_method(method: &Method, route: &str) -> bool {
    match route {
        "/api/chats/:chatId/compact" | "/api/chats/:chatId/execution-lanes/:laneId/release" => {
            method != Method::POST
        }
        "/api/chats/:chatId/worktree" => method != Method::PATCH,
        "/api/chats/:chatId/execution-lanes" => method != Method::GET && method != Method::HEAD,
        _ => false,
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/chats/{chatId}/compact", post(handle))
        .route("/api/chats/{chatId}/worktree", patch(handle))
        .route("/api/chats/{chatId}/execution-lanes", get(handle))
        .route(
            "/api/chats/{chatId}/execution-lanes/{laneId}/release",
            post(handle),
        )
}
