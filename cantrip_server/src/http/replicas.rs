//! Replica catalog, durable job admission, and worker-owned link repair.
use super::{
    body, json_response,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    projects::{replicas::ReplicaError, repository::ProjectRepository},
    wire::{Value, coercion, value::json},
    workers::command_bus::CommandFailure,
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{MatchedPath, Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, post},
};
use std::{collections::HashMap, sync::Arc};

fn conflict(code: &str, message: &str) -> Response {
    json_response(StatusCode::CONFLICT, json!({"code":code,"error":message}))
}
async fn repair(
    service: &AuthService,
    owner: &str,
    project: &str,
    replica: &str,
) -> Result<Response> {
    let Some(context) = service
        .project_replicas
        .repository
        .link_repair_context(owner, project, replica)
        .await?
    else {
        return Ok(error(404, "Project replica not found."));
    };
    if context["placementMode"] != "managed-link"
        || context["ownershipKind"] != "cantrip"
        || ["repository", "repositoryFingerprint", "linkPath"]
            .iter()
            .any(|key| !coercion::truthy(context.get(key)))
    {
        return Ok(conflict(
            "link-unsupported",
            "This replica does not have a repairable managed link.",
        ));
    }
    if context["workerSupportsRepair"] != true {
        return Ok(conflict(
            "capability-missing",
            "The replica worker does not support managed-link repair.",
        ));
    }
    let result: Result<Value> = async {
        let response = service.workers.commands.request(context["workerId"].as_str().unwrap(), json!({"type":"project.replica.link.repair","projectId":project,"repository":json!({"nameWithOwner":context["repository"]}),"sourcePath":context["sourcePath"],"linkPath":context["linkPath"],"repositoryFingerprint":context["repositoryFingerprint"]}), None, None).await?;
        crate::settings::parse_response("projectReplicaLinkRepairResultSchema", response.as_ref())
    }.await;
    match result {
        Ok(result) if result["status"] == "blocked" => Ok(json_response(
            StatusCode::CONFLICT,
            json!({"code":result["error"]["code"],"error":"Replica link repair was blocked."}),
        )),
        Ok(result) => Ok(json_response(StatusCode::OK, result)),
        Err(e) => Ok(error(
            e.downcast_ref::<CommandFailure>()
                .map_or(502, |e| e.status(502)),
            crate::settings::operation_error_message(&e),
        )),
    }
}
async fn mutate(
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    action: String,
    input: Value,
) -> Result<Response> {
    let repository = &service.project_replicas.repository;
    if action == "repair-link" {
        return repair(&service, &owner, &params["projectId"], &params["replicaId"]).await;
    }
    let result = if let Some(id) = params.get("jobId") {
        if repository.get(&owner, id).await?.is_none() {
            return Ok(error(404, "Project replica job not found."));
        }
        let revision = input["stateRevision"].as_f64().unwrap();
        let job = if action == "retry" {
            repository.retry(&owner, id, revision).await?
        } else {
            repository.cancel(&owner, id, revision).await?
        };
        let Some(job) = job else {
            return Ok(error(
                409,
                if action == "retry" {
                    "The job changed or is not in a retryable state."
                } else {
                    "The job changed or has crossed the safe cancellation boundary."
                },
            ));
        };
        Ok(job)
    } else {
        let project = &params["projectId"];
        match action.as_str() {
            "replicas" => repository.create_provision(&owner, project, &input).await,
            "synchronize" => {
                repository
                    .create_synchronize(&owner, project, &params["replicaId"], &input)
                    .await
            }
            "remove" => {
                repository
                    .create_remove(&owner, project, &params["replicaId"], &input)
                    .await
            }
            _ => unreachable!(),
        }
    };
    match result {
        Ok(job) => {
            service.project_replicas.publish(&owner, &job);
            if action != "cancel" {
                service.project_replicas.queue();
            }
            output(
                if params.contains_key("jobId") {
                    200
                } else {
                    202
                },
                "projectReplicaJobSummarySchema",
                &job,
            )
        }
        Err(e) => match e.downcast_ref::<ReplicaError>() {
            Some(ReplicaError::NotFound(_)) => Ok(error(404, e.to_string())),
            Some(ReplicaError::Conflict(_)) => Ok(error(409, e.to_string())),
            _ => Err(e),
        },
    }
}
async fn execute(
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    route: String,
    request: Request,
) -> Result<Response> {
    let read = matches!(*request.method(), Method::GET | Method::HEAD);
    // Fastify parses the body before project capability preHandlers, and validates
    // route-specific schemas only after those preHandlers have completed.
    let body = if read {
        None
    } else {
        match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(v) => v,
            Err(r) => return Ok(r),
        }
    };
    let projects = ProjectRepository::new(service.repository.database.clone())?;
    if let Some(id) = params.get("projectId")
        && let Some(project) = projects.get(&owner, id).await?
        && project["capabilities"]["replicas"] != true
    {
        return Ok(json_response(
            StatusCode::CONFLICT,
            json!({"code":"project-capability-unavailable","capability":"replicas","error":format!("This {} project does not support the replicas capability.", project["originKind"].as_str().unwrap_or("undefined"))}),
        ));
    }
    if read {
        if let Some(id) = params.get("jobId") {
            return match service.project_replicas.repository.get(&owner, id).await? {
                Some(job) => output(200, "projectReplicaJobSummarySchema", &job),
                None => Ok(error(404, "Project replica job not found.")),
            };
        }
        let project = &params["projectId"];
        if route.ends_with("/replica-jobs") {
            return match service
                .project_replicas
                .repository
                .list(&owner, project)
                .await?
            {
                Some(jobs) => output(200, "projectReplicaJobListSchema", &jobs),
                None => Ok(error(404, "Project not found.")),
            };
        }
        let replicas = projects.replicas(&owner, project).await?;
        if let Some(id) = params.get("replicaId") {
            return match replicas
                .unwrap_or_default()
                .into_iter()
                .find(|replica| replica["id"] == id.as_str())
            {
                Some(replica) => output(200, "projectReplicaSummarySchema", &replica),
                None => Ok(error(404, "Project replica not found.")),
            };
        }
        return match replicas {
            Some(replicas) => output(200, "projectReplicaListSchema", &Value::Array(replicas)),
            None => Ok(error(404, "Project not found.")),
        };
    }
    let action = route.rsplit('/').next().unwrap().to_owned();
    let schema = match action.as_str() {
        "replicas" => Some("encryptedProjectReplicaProvisionCreateSchema"),
        "synchronize" => Some("encryptedProjectReplicaSynchronizeCreateSchema"),
        "remove" => Some("encryptedProjectReplicaRemoveCreateSchema"),
        "retry" => Some("projectReplicaJobRetrySchema"),
        "cancel" => Some("projectReplicaJobCancelSchema"),
        "repair-link" => None,
        _ => unreachable!(),
    };
    let input = if let Some(schema) = schema {
        match parse(schema, body.as_ref())? {
            Ok(v) => v,
            Err(r) => return Ok(r),
        }
    } else {
        Value::Null
    };
    service
        .project_replicas
        .owned(mutate(service.clone(), owner, params, action, input))
        .await
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    route: MatchedPath,
    request: Request,
) -> Response {
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    match execute(
        service.clone(),
        owner,
        params,
        route.as_str().to_owned(),
        request,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => middleware::failure(&service, &ctx.id, &e),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/projects/{projectId}/replicas",
            get(handle).post(handle),
        )
        .route(
            "/api/projects/{projectId}/replicas/{replicaId}",
            get(handle),
        )
        .route(
            "/api/projects/{projectId}/replicas/{replicaId}/synchronize",
            post(handle),
        )
        .route(
            "/api/projects/{projectId}/replicas/{replicaId}/remove",
            post(handle),
        )
        .route(
            "/api/projects/{projectId}/replicas/{replicaId}/repair-link",
            post(handle),
        )
        .route("/api/projects/{projectId}/replica-jobs", get(handle))
        .route("/api/project-replica-jobs/{jobId}", get(handle))
        .route("/api/project-replica-jobs/{jobId}/retry", post(handle))
        .route("/api/project-replica-jobs/{jobId}/cancel", post(handle))
}
