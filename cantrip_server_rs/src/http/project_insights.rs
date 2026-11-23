//! Read-only project insights and encrypted script-command discovery.
use super::{
    account, json_response,
    middleware::{self, Context},
    settings::{error, output},
};
use crate::{
    auth::service::AuthService,
    projects::{
        placement::{PlacementRepository, Unavailable},
        repository::ProjectRepository,
        targets::TargetRepository,
    },
    run_configurations::lifecycle::ApiError,
    settings::repository::SettingsRepository,
    wire::{self, Value, coercion, value::json},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Request, State},
    http::Method,
    response::Response,
    routing::get,
};
use futures::{FutureExt, future::try_join_all};
use std::{collections::HashMap, sync::Arc, time::Duration};

fn run_failure(cause: &anyhow::Error) -> Response {
    let rejection = if let Some(value) = cause.downcast_ref::<Unavailable>() {
        Some((
            match value.code {
                "project-not-found" | "target-not-found" => 404,
                "worker-offline" => 503,
                _ => 409,
            },
            value.code,
            value.message.as_str(),
        ))
    } else if let Some(value) = cause.downcast_ref::<ApiError>() {
        Some((value.status, value.code, value.message.as_str()))
    } else {
        cause
            .downcast_ref::<crate::cantrip_os::PlacementError>()
            .map(|value| (409, "conflict", value.0))
    };
    if let Some((status, code, message)) = rejection {
        return json_response(
            axum::http::StatusCode::from_u16(status).unwrap(),
            json!({"code":code,"error":message}),
        );
    }
    super::worker_links::request_failure(cause)
}
fn unavailable(code: &'static str, message: &str) -> anyhow::Error {
    Unavailable {
        code,
        message: message.into(),
    }
    .into()
}
fn conflict(message: &str) -> anyhow::Error {
    ApiError {
        status: 409,
        code: "conflict",
        mcp_code: None,
        message: message.into(),
    }
    .into()
}
async fn run_context(
    service: &AuthService,
    owner: &str,
    project: &str,
    requested: Option<&Value>,
) -> Result<Value> {
    let database = service.repository.database.clone();
    let targets = TargetRepository::new(database.clone());
    let connected = |worker: &str| service.workers.commands.is_connected(worker);
    if coercion::truthy(requested) {
        let requested = coercion::string(requested.unwrap())
            .map_err(|_| anyhow::anyhow!("Cannot convert object to primitive value"))?;
        let selected = targets
            .worktree_context(owner, project, &requested.lossy())
            .await?
            .ok_or_else(|| {
                unavailable(
                    "target-not-found",
                    "The requested Run worktree was not found.",
                )
            })?;
        if !connected(selected["workerId"].as_str().context("Run worker")?) {
            return Err(unavailable(
                "worker-offline",
                "The requested Run worktree worker is offline.",
            ));
        }
        return Ok(selected);
    }
    let resolution = PlacementRepository::new(database)?
        .resolve(
            owner,
            project,
            "terminal",
            Some(&json!({"kind":"project","projectId":project})),
            Some(&connected),
            false,
        )
        .await?;
    let Some(worktree) = resolution["placement"]["worktreeId"]
        .as_str()
        .filter(|id| !id.is_empty())
    else {
        return Err(unavailable(
            "worktree-unavailable",
            "The project has no ready Run worktree.",
        ));
    };
    let selected = targets
        .worktree_context(owner, project, worktree)
        .await?
        .filter(|selected| selected["workerId"] == resolution["placement"]["workerId"])
        .ok_or_else(|| conflict("The Run worktree placement changed before the operation."))?;
    Ok(selected)
}
async fn project_scripts(
    service: &AuthService,
    owner: &str,
    project: &str,
    operation: Value,
    query: &Value,
) -> Result<Response> {
    let context = run_context(service, owner, project, query.get("worktreeId")).await?;
    let worker = context["workerId"].as_str().context("Run worker")?;
    let worktree = context["worktree"]["id"].as_str().context("Run worktree")?;
    let selected = TargetRepository::new(service.repository.database.clone())
        .worktree_context(owner, project, worktree)
        .await?
        .filter(|selected| selected["workerId"] == context["workerId"])
        .ok_or_else(|| {
            conflict("The script command worktree placement changed before discovery.")
        })?;
    let response = service
        .workers
        .commands
        .request(
            worker,
            json!({
                "type":"project.script-commands.inspect", "operationId":operation,
                "projectId":project, "worktreeId":worktree, "serverId":service.server_id,
                "sourcePath":selected["worktree"]["path"],
            }),
            Some(Duration::from_secs(30)),
            None,
        )
        .await?;
    let protected =
        crate::settings::parse_response("repositoryOperationOpaqueSchema", response.as_ref())?;
    output(
        200,
        "protectedScriptCommandListSchema",
        &json!({
            "operationId":operation,"projectId":project,"worktreeId":worktree,"protectedCommands":protected,
        }),
    )
}
async fn terminal_scripts(
    service: &AuthService,
    owner: &str,
    terminal: &str,
    operation: Value,
) -> Result<Response> {
    let Some(context) = crate::terminals::Repository::new(service.repository.database.clone())
        .context(owner, terminal)
        .await?
    else {
        return Ok(error(404, "Terminal not found."));
    };
    if context["kind"] == "run-configuration" || !coercion::truthy(context.get("stateProtection")) {
        return Ok(error(
            409,
            "Run configuration terminals do not expose interactive terminal commands.",
        ));
    }
    let worker = context["workerId"].as_str().context("Terminal worker")?;
    if !service.workers.commands.is_connected(worker) {
        return Ok(error(503, "Project worker is offline."));
    }
    let response: Result<Response> = async {
        let response = service.workers.commands.request(worker, json!({
            "type":"project.script-commands", "operationId":operation,
            "terminalId":context["terminalId"], "serverId":service.server_id,
            "worktreePath":context["worktreePath"], "stateProtection":context["stateProtection"],
        }), Some(Duration::from_secs(30)), None).await?;
        let protected = crate::settings::parse_response("repositoryOperationOpaqueSchema",response.as_ref())?;
        // The reference binds both response identities to the terminal, rather
        // than exposing project/worktree identities as authenticated metadata.
        output(200,"protectedScriptCommandListSchema",&json!({
            "operationId":operation,"projectId":context["terminalId"],"worktreeId":context["terminalId"],"protectedCommands":protected,
        }))
    }.await;
    Ok(response.unwrap_or_else(|cause| super::worker_links::request_failure(&cause)))
}
async fn stats(service: &AuthService, owner: &str, project: &str) -> Result<Response> {
    let repository = ProjectRepository::new(service.repository.database.clone())?;
    let targets = TargetRepository::new(service.repository.database.clone());
    let connected = |worker: &str| service.workers.commands.is_connected(worker);
    let (project, source) = tokio::try_join!(
        repository.get(owner, project).boxed(),
        targets
            .observation_source(owner, project, &connected)
            .boxed(),
    )?;
    let (Some(project), Some(source)) = (project, source) else {
        return Ok(error(404, "Project source not found."));
    };
    let response: Result<Response> = async {
        let git = project["capabilities"]["git"] == true;
        let command = if git {
            json!({"type":"project.repository-stats","cwd":source["cwd"]})
        } else {
            json!({"type":"project.folder-stats","root":source["cwd"]})
        };
        let response = service
            .workers
            .commands
            .request(
                source["workerId"].as_str().context("Project worker")?,
                command,
                Some(Duration::from_secs(30)),
                None,
            )
            .await?;
        let parsed =
            crate::settings::parse_response("projectRepositoryStatsSchema", response.as_ref())?;
        if git != (parsed["kind"] == "git") {
            anyhow::bail!("Worker returned statistics for the wrong project kind.");
        }
        Ok(json_response(axum::http::StatusCode::OK, parsed))
    }
    .await;
    Ok(response.unwrap_or_else(|cause| super::worker_links::request_failure(&cause)))
}
async fn workload(service: &AuthService, owner: &str, project: &str) -> Result<Response> {
    let database = service.repository.database.clone();
    // Preserve the reference order: task mapping can fail before project lookup.
    let tasks = crate::tasks::Repository::new(database.clone())
        .list(owner, project)
        .await?;
    if ProjectRepository::new(database.clone())?
        .get(owner, project)
        .await?
        .is_none()
    {
        return Ok(error(404, "Project not found."));
    }
    let chats = crate::chats::Repository::new(database);
    let items = try_join_all(tasks.into_iter().map(|task| {
        let chats = &chats;
        async move {
            let chat = task["chatId"].as_str().context("Task chat")?;
            let query = json!({"limit":100});
            let (plan, page) = tokio::try_join!(
                chats.plan_wire_state(owner, chat).boxed(),
                chats.opaque_message_page(owner, chat, true, &query).boxed(),
            )?;
            let plan = plan.context("Task Chat plan state was not found.")?;
            Ok::<_, anyhow::Error>(json!({"task":task,"plan":plan,"messages":page["messages"]}))
        }
    }))
    .await?;
    output(
        200,
        "projectTaskWorkloadOpaqueSchema",
        &json!({"projectId":project,"items":items}),
    )
}
async fn execute(
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    route: String,
    request: Request,
) -> Result<Response> {
    let query = account::query(request.uri());
    drop(request); // Fastify ignores GET and HEAD bodies.
    if route.ends_with("/script-commands") {
        let operation =
            match wire::parse("scriptCommandOperationIdSchema", query.get("operationId")) {
                Ok(value) => value,
                Err(wire::ValidationError::Invalid(_)) => {
                    return Ok(error(400, "A valid operationId is required."));
                }
                Err(cause) => return Err(crate::settings::response_error(cause)),
            };
        if let Some(terminal) = params.get("terminalId") {
            return terminal_scripts(&service, &owner, terminal, operation).await;
        }
        return Ok(
            project_scripts(&service, &owner, &params["projectId"], operation, &query)
                .await
                .unwrap_or_else(|cause| run_failure(&cause)),
        );
    }
    let project = &params["projectId"];
    if route.ends_with("/repository-stats") {
        stats(&service, &owner, project).await
    } else if route.ends_with("/token-usage") {
        match SettingsRepository::new(service.repository.database.clone())
            .project_token_usage(&owner, project)
            .await?
        {
            Some(value) => output(
                200,
                "projectTokenUsageSchema",
                &Value::from_serialize(&value),
            ),
            None => Ok(error(404, "Project not found.")),
        }
    } else {
        workload(&service, &owner, project).await
    }
}
async fn read(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    route: MatchedPath,
    request: Request,
) -> Response {
    let owner = ctx
        .principal
        .user
        .as_ref()
        .expect("Admitted project read")
        .id
        .clone();
    match service
        .worker_maintenance
        .owned(execute(
            service.clone(),
            owner,
            params,
            route.as_str().to_owned(),
            request,
        ))
        .await
    {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
pub(super) fn unregistered_method(method: &Method, route: &str) -> bool {
    matches!(
        route,
        "/api/projects/:projectId/repository-stats"
            | "/api/projects/:projectId/token-usage"
            | "/api/projects/:projectId/script-commands"
            | "/api/terminals/:terminalId/script-commands"
            | "/api/projects/:projectId/tasks/workload"
    ) && *method != Method::GET
        && *method != Method::HEAD
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/projects/{projectId}/repository-stats", get(read))
        .route("/api/projects/{projectId}/token-usage", get(read))
        .route("/api/projects/{projectId}/script-commands", get(read))
        .route("/api/terminals/{terminalId}/script-commands", get(read))
        .route("/api/projects/{projectId}/tasks/workload", get(read))
}
