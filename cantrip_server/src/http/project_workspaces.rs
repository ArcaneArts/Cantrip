use super::{
    body, json_response,
    middleware::{self, Context},
    on_response,
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    projects::{
        targets::TargetRepository,
        workspaces::{WorkspaceRepository, project_cleanup},
    },
    wire::{Value, value::json},
    workers::command_bus::CommandFailure,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    body::Body,
    extract::{MatchedPath, Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, patch, post},
};
use std::{sync::Arc, time::Duration};
async fn attached(service: &Arc<AuthService>, owner: &str, input: &Value) -> Result<Response> {
    let Some(worker) = TargetRepository::new(service.repository.database.clone())
        .worker(owner, &input["storage"]["workerId"])
        .await?
    else {
        return Ok(error(404, "Worker not found."));
    };
    if !crate::wire::coercion::truthy(worker["managedFolders"].get("attachWorkspaceRoot")) {
        return Ok(json_response(
            StatusCode::CONFLICT,
            json!({"code":"workspace-root-capability-unavailable","error":"This worker does not support attached workspace roots."}),
        ));
    }
    let result:Result<Value>=async {
        let response=service.workers.commands.request(worker["workerId"].as_str().unwrap(),json!({"type":"repository.operation","serverId":service.server_id,"projectId":input["id"],"worktreeId":worker["workerId"],"cwd":".","sourcePath":".","repository":Value::Null,"agentRuntimes":Vec::<Value>::new(),"mcpServers":Vec::<Value>::new(),"operationId":input["operationId"],"protectedRequest":input["protectedRequest"],"access":"write","agent":false,"routingPurpose":"workspace-root-attachment"}),Some(Duration::from_secs(30*60)),None).await?;
        crate::settings::parse_response("repositoryOperationWireResponseSchema",response.as_ref())
    }.await;
    let operation = match result {
        Ok(v) => v,
        Err(e) => {
            return Ok(error(
                e.downcast_ref::<CommandFailure>()
                    .map_or(502, |e| e.status(502)),
                crate::settings::operation_error_message(&e),
            ));
        }
    };
    if !crate::wire::coercion::truthy(operation.get("workspaceRootAttachment")) {
        return output(
            200,
            "encryptedAttachedProjectWorkspaceCreateResultSchema",
            &json!({"workspace":Value::Null,"operation":operation}),
        );
    }
    let result:Result<Response>=async {
        let mut storage=operation["workspaceRootAttachment"].clone();storage["kind"]=json!("attached");storage["workerId"]=worker["workerId"].clone();
        let workspace=WorkspaceRepository::new(service.repository.database.clone()).create(owner,&json!({"id":input["id"],"nameProtection":input["nameProtection"],"storage":storage}),true).await?;
        match service.workspace_discovery.repository.queue_scan(owner,workspace["id"].as_str().unwrap(),&Value::Object(Default::default())).await {
            Ok(Some(job))=>{service.workspace_discovery.publish(owner,&job,None);service.workspace_discovery.queue();},Ok(None)=>{},Err(_)=>eprintln!("{}",serde_json::json!({"level":"warn","event":"workspace.repository-discovery.initial-queue-failed","workspaceId":workspace["id"]})),
        }
        output(201,"encryptedAttachedProjectWorkspaceCreateResultSchema",&json!({"workspace":workspace,"operation":operation}))
    }.await;
    Ok(match result {
        Ok(r) => r,
        Err(e) => error(409, crate::settings::operation_error_message(&e)),
    })
}
async fn mutate(
    service: Arc<AuthService>,
    owner: String,
    id: Option<String>,
    route: String,
    method: Method,
    input: Option<Value>,
) -> Result<Response> {
    let repository = WorkspaceRepository::new(service.repository.database.clone());
    let input = input.unwrap_or(Value::Null);
    let result:Result<Response>=async {
        if route.ends_with("/attached"){return attached(&service,&owner,&input).await};
        if route=="/api/workspaces" {return output(201,"projectWorkspaceWireSummarySchema",&repository.create(&owner,&input,false).await?)};
        let id=id.as_deref().context("Workspace route identity")?;
        if route.ends_with("/repository-discovery") {
            let Some(job)=service.workspace_discovery.repository.queue_scan(&owner,id,&input).await? else {
                return Ok(json_response(StatusCode::CONFLICT,json!({"code":"repository-discovery-stale","error":"Workspace repository discovery is already running or changed."})));
            };
            let snapshot=service.workspace_discovery.repository.snapshot(&owner,id).await?.context("Queued workspace repository discovery disappeared.")?;
            service.workspace_discovery.publish(&owner,&job,None);service.workspace_discovery.queue();
            return output(202,"workspaceRepositoryDiscoverySnapshotSchema",&snapshot);
        }
        if route.ends_with("/repository-imports") {
            let Some(snapshot)=service.workspace_discovery.repository.queue_imports(&owner,id,&input).await? else {
                return Ok(json_response(StatusCode::CONFLICT,json!({"code":"repository-candidates-stale","error":"Repository discovery changed before the import was queued."})));
            };
            service.workspace_discovery.publish(&owner,&snapshot["job"],None);service.workspace_discovery.queue();
            return output(202,"workspaceRepositoryDiscoverySnapshotSchema",&snapshot);
        }
        if method==Method::PATCH {
            return match repository.update(&owner,id,&input).await? {Some(v)=>output(200,"projectWorkspaceWireSummarySchema",&v),None=>Ok(error(404,"Workspace not found."))};
        }
        let Some(plan)=repository.deletion_plan(&owner,id).await? else {return Ok(error(404,"Workspace not found."))};
        let projects=plan["projectIds"].as_array().context("Workspace deletion projects")?;
        let results=futures::future::join_all(projects.iter().map(|project|async {
            let project=project.as_str().context("Workspace deletion project identity")?;
            if let Some(context)=repository.project_removal_context(&owner,project).await? {
                project_cleanup::preserving_files(service.clone(),owner.clone(),project.to_owned(),context).await?;
            }
            Ok::<_,anyhow::Error>(())
        })).await;
        for result in results{result?;}
        if repository.delete(&owner,id).await?{Ok(Response::builder().status(204).body(Body::empty())?)}else{Ok(error(409,"Workspace changed before it could be deleted."))}
    }.await;
    Ok(match result {
        Ok(r) => r,
        Err(e) => error(409, crate::settings::operation_error_message(&e)),
    })
}
async fn execute(
    service: Arc<AuthService>,
    owner: String,
    id: Option<String>,
    route: String,
    request: Request,
) -> Result<Response> {
    let method = request.method().clone();
    let repository = WorkspaceRepository::new(service.repository.database.clone());
    if matches!(method, Method::GET | Method::HEAD) {
        if route == "/api/workspaces" {
            return output(
                200,
                "projectWorkspaceWireListSchema",
                &repository.list(&owner).await?,
            );
        };
        return match service
            .workspace_discovery
            .repository
            .snapshot(&owner, id.as_deref().unwrap())
            .await?
        {
            Some(v) => output(200, "workspaceRepositoryDiscoverySnapshotSchema", &v),
            None => Ok(error(
                404,
                "Workspace repository discovery has not started.",
            )),
        };
    }
    let input = if method == Method::DELETE {
        None
    } else {
        let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(v) => v,
            Err(r) => return Ok(r),
        };
        let schema = if route.ends_with("/attached") {
            "encryptedAttachedProjectWorkspaceCreateSchema"
        } else if route.ends_with("/repository-discovery") {
            "workspaceRepositoryDiscoveryStartSchema"
        } else if route.ends_with("/repository-imports") {
            "workspaceRepositoryImportStartSchema"
        } else if method == Method::PATCH {
            "encryptedProjectWorkspaceUpdateSchema"
        } else {
            "encryptedProjectWorkspaceCreateSchema"
        };
        let body = if route.ends_with("/repository-discovery") {
            Some(
                body.filter(|v| !v.is_null())
                    .unwrap_or_else(|| Value::Object(Default::default())),
            )
        } else {
            body
        };
        Some(match parse(schema, body.as_ref())? {
            Ok(v) => v,
            Err(r) => return Ok(r),
        })
    };
    service
        .workspace_discovery
        .owned(mutate(service.clone(), owner, id, route, method, input))
        .await
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    id: Option<Path<String>>,
    route: MatchedPath,
    request: Request,
) -> Response {
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let mutation = !matches!(*request.method(), Method::GET | Method::HEAD);
    let discovery = route.as_str().ends_with("/repository-discovery")
        || route.as_str().ends_with("/repository-imports");
    let workspace = id.map(|Path(id)| id);
    let entity = workspace.clone();
    match execute(
        service.clone(),
        owner.clone(),
        workspace,
        route.as_str().to_owned(),
        request,
    )
    .await
    {
        Ok(response) if mutation && response.status().as_u16() < 400 => {
            let live = service.live.clone();
            on_response::completed(response, move || {
                let resources = if discovery {
                    vec!["workspace-repository-discovery-job"]
                } else {
                    vec!["project", "policy"]
                };
                for resource in resources {
                    let _=live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"current-user"}),"resource":resource,"action":"invalidated","entityId":if resource=="policy"{Value::Null}else{entity.as_ref().map_or(Value::Null,|id|json!(id))},"revision":Value::Null,"payload":Value::Null}));
                }
            })
        }
        Ok(response) => response,
        Err(e) => middleware::failure(&service, &ctx.id, &e),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/workspaces", get(handle).post(handle))
        .route("/api/workspaces/attached", post(handle))
        .route(
            "/api/workspaces/{workspaceId}/repository-discovery",
            get(handle).post(handle),
        )
        .route(
            "/api/workspaces/{workspaceId}/repository-imports",
            post(handle),
        )
        .route(
            "/api/workspaces/{workspaceId}",
            patch(handle).delete(handle),
        )
}
