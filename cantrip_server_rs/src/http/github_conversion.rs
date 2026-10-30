//! Existing conversion wire contract; protected handles pass only to workers.
use super::{
    body, json_response,
    middleware::{self, Context},
    on_response,
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    projects::{
        github_conversion::ConversionError, repository::ProjectRepository,
        targets::TargetRepository,
    },
    wire::{Value, coercion, value::json},
    workers::command_bus::CommandFailure,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, post},
};
use std::{sync::Arc, time::Duration};
fn conflict(code: &str, message: &str) -> Response {
    json_response(StatusCode::CONFLICT, json!({"code":code,"error":message}))
}
async fn source(
    service: &AuthService,
    owner: &str,
    project: &str,
    input: &Value,
) -> Result<Option<Value>> {
    let requested = input
        .get("projectSourceId")
        .filter(|v| coercion::truthy(Some(v)));
    let selected = if let Some(id) = requested {
        Some(id.clone())
    } else {
        let rows=service.repository.database.query("SELECT s.id,t.worker_id FROM projects p INNER JOIN project_sources s ON s.project_id=p.id INNER JOIN project_worktrees t ON t.project_source_id=s.id AND t.is_primary=true LEFT JOIN user_settings u ON u.user_id=p.owner_id WHERE p.id=$1 AND p.owner_id=$2 AND s.removed_at IS NULL AND t.lifecycle_state='ready' ORDER BY coalesce(s.worker_id=p.preferred_worker_id,false) DESC,coalesce(s.worker_id=u.default_worker_id,false) DESC,s.created_at ASC,s.id ASC", &[&project,&owner]).await?;
        let mut selected = None;
        for row in &rows {
            let worker = row.get::<String>(1)?;
            if selected.is_none() || service.workers.bridge.is_connected(&worker) {
                selected = Some(json!(row.get::<String>(0)?));
                if service.workers.bridge.is_connected(&worker) {
                    break;
                }
            }
        }
        selected
    };
    let Some(selected) = selected else {
        return Ok(None);
    };
    Ok(ProjectRepository::new(service.repository.database.clone())?
        .replicas(owner, project)
        .await?
        .unwrap_or_default()
        .into_iter()
        .find(|s| {
            s["id"] == selected && (requested.is_none() || s["workerId"] == input["workerId"])
        }))
}
async fn mutate(
    service: Arc<AuthService>,
    owner: String,
    id: String,
    action: String,
    input: Value,
) -> Result<Response> {
    let repository = &service.github_conversion.repository;
    let Some(project) = ProjectRepository::new(service.repository.database.clone())?
        .get(&owner, &id)
        .await?
    else {
        return Ok(error(404, "Project not found."));
    };
    if action == "retry" {
        if project["originKind"] != "managed-folder" {
            return Ok(error(409, "The project is no longer a managed folder."));
        }
        let Some(job) = repository
            .retry(&owner, &id, input["stateRevision"].as_f64().unwrap())
            .await?
        else {
            return Ok(error(409, "GitHub conversion changed or is not retryable."));
        };
        service.github_conversion.publish(&owner, &job);
        service.github_conversion.queue();
        return output(200, "projectGithubConversionJobSummarySchema", &job);
    }
    if project["originKind"] != "managed-folder" || project["setupStatus"] != "ready" {
        return Ok(conflict(
            "project-not-ready",
            "Only a ready folder or local Git project can be converted.",
        ));
    }
    let preflight = action == "preflight";
    let blind = input["repositoryBlindIndex"].as_str().unwrap();
    let collision = || {
        service
            .project_replicas
            .repository
            .has_github_project(&owner, blind)
    };
    if preflight {
        if repository.has_active(&id).await? {
            return Ok(conflict(
                "transition-active",
                "A GitHub conversion is already active for this project.",
            ));
        }
        if collision().await? {
            return Ok(conflict(
                "repository-collision",
                "This GitHub repository is already bound to another Cantrip project.",
            ));
        }
    }
    if project["folderManagement"] == "external"
        && (!coercion::truthy(input.get("projectSourceId"))
            || !coercion::truthy(input.get("workerId")))
    {
        return Ok(if preflight {
            conflict(
                "source-required",
                "Refresh the project before converting so the request can bind to its exact local Git source.",
            )
        } else {
            conflict(
                "preflight-required",
                "Run conversion preflight again to bind this request to its exact local Git source.",
            )
        });
    }
    let selected = source(&service, &owner, &id, &input).await?;
    let managed = selected.as_ref().is_some_and(|s| {
        project["folderManagement"] == "managed"
            && s["sourceKind"] == "folder"
            && s["ownershipKind"] == "cantrip"
    });
    let external = selected.as_ref().is_some_and(|s| {
        project["folderManagement"] == "external"
            && project["capabilities"]["git"] == true
            && s["sourceKind"] == "git"
            && s["ownershipKind"] == "user"
    });
    let Some(source) = selected.filter(|s| s["ready"] == true && (managed || external)) else {
        return Ok(conflict(
            "project-not-ready",
            "The project no longer has an eligible conversion source.",
        ));
    };
    let worker_id = source["workerId"]
        .as_str()
        .context("Conversion source worker")?;
    let worker = TargetRepository::new(service.repository.database.clone())
        .worker(&owner, &source["workerId"])
        .await?;
    let storage =
        crate::projects::folders::FolderRepository::new(service.repository.database.clone())
            .workspace_storage(&owner, &id)
            .await?;
    let Some(storage) = storage else {
        return Ok(conflict(
            "project-not-ready",
            "Project workspace storage is unavailable.",
        ));
    };
    let truth = |key| {
        worker
            .as_ref()
            .is_some_and(|w| coercion::truthy(w["managedFolders"].get(key)))
    };
    if !truth("convertToGithub")
        || (external && !truth("convertExternalGitToGithub"))
        || (managed && storage["kind"] == "managed" && !truth("workspaceScopedRoots"))
    {
        return Ok(conflict(
            "capability-missing",
            "The source worker does not support GitHub conversion for this project.",
        ));
    }
    if !service.workers.bridge.is_connected(worker_id) {
        return Ok(json_response(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({"code":"worker-offline","error":"The owning worker must be online before conversion."}),
        ));
    }
    if preflight {
        let mut request = json!({"type":"project.folder-conversion.preflight","projectId":id,"repository":input["repository"],"workspaceStorage":storage});
        if external {
            request["sourcePath"] = source["path"].clone();
            request["sourceDisplayPath"] = source["displayPath"].clone();
        }
        let result: Result<Value> = async {
            let response = service
                .workers
                .commands
                .request(worker_id, request, Some(Duration::from_secs(30 * 60)), None)
                .await?;
            let mut result = crate::settings::parse_response(
                "projectGithubConversionPreflightResultSchema",
                response.as_ref(),
            )?;
            if result["status"] == "ready" {
                result["projectSourceId"] = source["id"].clone();
                result["workerId"] = source["workerId"].clone();
                result = crate::settings::parse_response(
                    "projectGithubConversionPreflightResultSchema",
                    Some(&result),
                )?;
            }
            Ok(result)
        }
        .await;
        return match result {
            Ok(result) => Ok(json_response(StatusCode::OK, result)),
            Err(e) => Ok(error(
                e.downcast_ref::<CommandFailure>()
                    .map_or(502, |e| e.status(502)),
                crate::settings::operation_error_message(&e),
            )),
        };
    }
    if collision().await? {
        return Ok(conflict(
            "repository-collision",
            "This GitHub repository is already bound to another Cantrip project.",
        ));
    }
    match repository
        .create(
            &owner,
            &id,
            worker_id,
            source["id"].as_str().unwrap(),
            &input,
        )
        .await
    {
        Ok(job) => {
            service.github_conversion.publish(&owner, &job);
            service.github_conversion.queue();
            output(202, "projectGithubConversionJobSummarySchema", &job)
        }
        Err(e) => match e.downcast_ref::<ConversionError>() {
            Some(ConversionError::NotFound) => Ok(error(404, "Project not found.")),
            Some(ConversionError::Conflict(_)) => Ok(error(409, e.to_string())),
            _ => Err(e),
        },
    }
}
async fn execute(
    service: Arc<AuthService>,
    owner: String,
    id: String,
    route: String,
    request: Request,
) -> Result<Response> {
    if matches!(*request.method(), Method::GET | Method::HEAD) {
        if ProjectRepository::new(service.repository.database.clone())?
            .get(&owner, &id)
            .await?
            .is_none()
        {
            return Ok(error(404, "Project not found."));
        }
        return match service
            .github_conversion
            .repository
            .get(&owner, &id)
            .await?
        {
            Some(job) => output(200, "projectGithubConversionJobSummarySchema", &job),
            None => Ok(error(404, "GitHub conversion job not found.")),
        };
    }
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(v) => v,
        Err(r) => return Ok(r),
    };
    let action = route.rsplit('/').next().unwrap().to_owned();
    let schema = match action.as_str() {
        "preflight" => "encryptedProjectGithubConversionPreflightRequestSchema",
        "retry" => "projectGithubConversionRetrySchema",
        _ => "encryptedProjectGithubConversionStartSchema",
    };
    let input = match parse(schema, body.as_ref())? {
        Ok(v) => v,
        Err(r) => return Ok(r),
    };
    service
        .github_conversion
        .owned(mutate(service.clone(), owner, id, action, input))
        .await
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(id): Path<String>,
    route: MatchedPath,
    request: Request,
) -> Response {
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let invalidate = request.method() == Method::POST && !route.as_str().ends_with("/preflight");
    match execute(
        service.clone(),
        owner.clone(),
        id.clone(),
        route.as_str().to_owned(),
        request,
    )
    .await
    {
        Ok(r) if invalidate && r.status().as_u16() < 400 => {
            let live = service.live.clone();
            on_response::completed(r, move || {
                let _=live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"project","projectId":id}),"resource":"project","action":"invalidated","entityId":id,"revision":Value::Null,"payload":Value::Null}));
            })
        }
        Ok(r) => r,
        Err(e) => middleware::failure(&service, &ctx.id, &e),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/projects/{projectId}/github-conversion/preflight",
            post(handle),
        )
        .route(
            "/api/projects/{projectId}/github-conversion",
            get(handle).post(handle),
        )
        .route(
            "/api/projects/{projectId}/github-conversion/retry",
            post(handle),
        )
}
