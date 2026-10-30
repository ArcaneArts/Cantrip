//! Owning routes for protected project and standalone-chat WebDAV shares.
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
    tunnel_cleanup::revoke_attachments,
};
use crate::{
    auth::service::AuthService,
    direct_attachments::Scope,
    project_shares::{OperationError, repository::Repository},
    wire::{Value, value::json},
    workers::command_bus::CommandFailure,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{delete, post},
};
use std::{collections::HashMap, sync::Arc};

fn stable_code(code: &str) -> bool {
    !code.is_empty()
        && code.len() <= 100
        && code.split('-').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        })
}
fn diagnostic_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
}
fn failure(
    ctx: &Context,
    cause: &anyhow::Error,
    worker: &Value,
    resource: &str,
) -> Result<Response> {
    let operation = cause.downcast_ref::<OperationError>();
    let bridge = match cause.downcast_ref::<CommandFailure>() {
        Some(CommandFailure::Bridge(e)) => Some(e),
        _ => None,
    };
    let unavailable = bridge.is_some_and(|e| e.unavailable);
    let code = operation
        .map(|e| e.code.as_str())
        .filter(|c| stable_code(c))
        .or_else(|| {
            bridge
                .and_then(|e| e.code.as_deref())
                .filter(|c| stable_code(c))
        })
        .unwrap_or(if unavailable {
            "worker-offline"
        } else {
            "project-share-open-failed"
        });
    let stage = operation.map_or(
        if bridge.is_some() && !unavailable {
            "worker-share-open"
        } else if unavailable {
            "worker-connectivity"
        } else {
            "control-plane"
        },
        |e| e.stage,
    );
    let status = if ["project-share-state-stale", "project-source-unavailable"].contains(&code) {
        409
    } else if code == "worker-offline" {
        503
    } else {
        502
    };
    let message = if code == "project-source-unavailable" {
        "Project source is unavailable."
    } else if code == "worker-offline" {
        "The project worker is offline."
    } else if let Some(error) = operation {
        error.message.as_str()
    } else if code == "project-share-state-stale" {
        "Project share state is stale."
    } else {
        "Winterhold could not open the protected project share."
    };
    let request = operation
        .and_then(|e| e.worker_request_id.as_deref())
        .or_else(|| bridge.and_then(|e| e.request_id.as_deref()))
        .filter(|s| diagnostic_id(s));
    let mut context = json!({"event":"project_share.open.failed","subsystem":"project-share","operation":"open","status":"failed","requestId":ctx.id,"workerId":worker,"reasonCode":code,"failureStage":stage,"resourceKind":resource});
    let mut value = json!({"code":code,"error":message,"failureStage":stage,"requestId":ctx.id,"workerId":worker});
    if let Some(request) = request {
        context["workerRequestId"] = json!(request);
        value["workerRequestId"] = json!(request);
    }
    crate::operations::logging::server().event(
        if status >= 500 { "error" } else { "warn" },
        &"Protected project share open failed".into(),
        Some(&context),
    )?;
    Ok(super::json_response(
        StatusCode::from_u16(status).unwrap(),
        value,
    ))
}
async fn create(
    service: Arc<AuthService>,
    owner: String,
    ctx: Arc<Context>,
    params: HashMap<String, String>,
    input: Value,
) -> Result<Response> {
    let repository = Repository::new(service.repository.database.clone());
    let project = params.get("projectId");
    let chat = params.get("chatId");
    let mut setup = json!({"ownerId":owner,"projectId":project,"tunnelId":input["tunnelId"],"workerId":input["workerId"],"protectedRecord":input["protectedRecord"]});
    let managed_id = if let Some(project) = project {
        let Some(source) = repository
            .source(&owner, project, &input["workerId"])
            .await?
        else {
            return Ok(error(404, "Project source not found."));
        };
        let worktree = if let Some(id) = input.get("worktreeId") {
            repository.worktree(&owner, project, id).await?
        } else {
            None
        };
        if input.get("worktreeId").is_some() && worktree.is_none() {
            return Ok(error(404, "Project worktree not found."));
        }
        let worker = worktree
            .as_ref()
            .map_or(&source["workerId"], |w| &w["workerId"]);
        if *worker != input["workerId"] {
            return Ok(super::json_response(
                StatusCode::CONFLICT,
                json!({"code":"target-mismatch","error":"The protected project share targets another project worker."}),
            ));
        }
        project.clone()
    } else {
        if input.get("worktreeId").is_some() {
            return Ok(error(
                400,
                "Scratch network shares cannot target a project worktree.",
            ));
        }
        let chat = chat.context("Share chat route")?;
        let Some(context) = crate::chats::Repository::new(service.repository.database.clone())
            .execution_context(&owner, chat)
            .await?
        else {
            return Ok(error(404, "Chat not found."));
        };
        if context["contextKind"] != "standalone" {
            return Ok(error(
                409,
                "Scratch network shares are available only in standalone Chat.",
            ));
        }
        if context["workerId"] != input["workerId"] {
            return Ok(super::json_response(
                StatusCode::CONFLICT,
                json!({"code":"target-mismatch","error":"The protected Chat share targets another worker."}),
            ));
        }
        let worker = service
            .workers
            .repository
            .get_worker(
                &owner,
                context["workerId"].as_str().context("Chat share worker")?,
            )
            .await?;
        if worker
            .as_ref()
            .is_none_or(|w| w["standaloneChat"]["files"]["networkShare"] != true)
        {
            return Ok(error(
                409,
                "The Chat worker does not support scratch network shares.",
            ));
        }
        setup["standaloneRoot"] =
            json!({"chatId":context["chatId"],"rootId":context["scratchRootId"]});
        setup["managedResourceId"] = json!(format!(
            "chat:{}",
            context["chatId"].as_str().context("Share chat identity")?
        ));
        setup["managedResourceId"].as_str().unwrap().to_owned()
    };
    let scope = Scope::Resource {
        owner: json!(owner),
        kind: json!("tunnel"),
        resource: input["tunnelId"].clone(),
    };
    let result=service.direct_attachments.mutate(scope,async {
        let repository=crate::tunnels::Repository::new(service.repository.database.clone());
        let existing=repository.get_managed(&owner,&json!({"kind":"project-share","id":managed_id})).await?;
        if existing.as_ref().is_some_and(|t|t["id"]!=input["tunnelId"]) {return Err(OperationError::stale(if project.is_some(){"The project share tunnel identity is stale."}else{"The Chat share tunnel identity is stale."}).into());}
        if let Some(existing)=existing {
            service.worker_links.revoke_resource(&owner,"tunnel",existing["id"].as_str().context("Share tunnel identity")?,"resource-stopped").await;
            revoke_attachments(&service,&owner,&existing,true).await?;
        }
        let attachment=service.project_shares.open(&setup).await?;
        if let Some(chat)=chat {
            output(201,"standaloneChatShareAttachmentWireSchema",&json!({"attachmentId":attachment["attachmentId"],"chatId":chat,"protocol":attachment["protocol"],"tunnelId":attachment["tunnelId"],"expiresAt":attachment["expiresAt"],"mountLeaseMs":attachment["mountLeaseMs"]}))
        }else{output(201,"projectShareAttachmentWireSchema",&attachment)}
    }).await;
    match result {
        Ok(response) => Ok(response),
        Err(cause) => failure(
            &ctx,
            &cause,
            &input["workerId"],
            if project.is_some() { "project" } else { "chat" },
        ),
    }
}
async fn remove(service: Arc<AuthService>, owner: String, id: String) -> Result<Response> {
    let scope = Scope::Resource {
        owner: json!(owner),
        kind: json!("tunnel"),
        resource: json!(id),
    };
    service
        .direct_attachments
        .mutate(scope, async {
            let Some(tunnel) = crate::tunnels::Repository::new(service.repository.database.clone())
                .get(&owner, &id)
                .await?
                .filter(|t| {
                    t["origin"] == "project-share" && t["managedBy"]["kind"] == "project-share"
                })
            else {
                return Ok(error(404, "Project share not found."));
            };
            service
                .worker_links
                .revoke_resource(&owner, "tunnel", &id, "resource-deleted")
                .await;
            revoke_attachments(&service, &owner, &tunnel, true).await?;
            Ok(
                if service
                    .project_shares
                    .revoke_attachment(&owner, &id)
                    .await?
                {
                    StatusCode::NO_CONTENT.into_response()
                } else {
                    error(404, "Project share not found.")
                },
            )
        })
        .await
}
use axum::response::IntoResponse;
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let method = request.method().clone();
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let result: Result<Response> = async {
        let raw = match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(v) => v,
            Err(r) => return Ok(r),
        };
        if method == Method::DELETE {
            return service
                .worker_maintenance
                .owned(remove(
                    service.clone(),
                    owner,
                    params
                        .get("attachmentId")
                        .context("Share attachment route")?
                        .clone(),
                ))
                .await;
        }
        let input = match parse("projectShareTunnelCreateSchema", raw.as_ref())? {
            Ok(v) => v,
            Err(r) => return Ok(r),
        };
        service
            .worker_maintenance
            .owned(create(service.clone(), owner, ctx.clone(), params, input))
            .await
    }
    .await;
    result.unwrap_or_else(|cause| middleware::failure(&service, &ctx.id, &cause))
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/projects/{projectId}/network-shares", post(handle))
        .route("/api/chats/{chatId}/network-shares", post(handle))
        .route("/api/project-shares/{attachmentId}", delete(handle))
}
