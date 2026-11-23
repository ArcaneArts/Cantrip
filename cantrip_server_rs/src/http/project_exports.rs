//! Existing project export previews and sequential, independently settled Chats.
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    chats::{Repository, message_queries::MessageKind},
    projects::{exports, targets::TargetRepository},
    wire::{Value, coercion::truthy, value::json},
    workers::repository::WorkerRepository,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    response::Response,
    routing::post,
};
use std::{sync::Arc, time::Duration};

async fn operation(
    service: Arc<AuthService>,
    owner: String,
    project: String,
    input: Value,
    preview: bool,
) -> Result<Response> {
    let targets = TargetRepository::new(service.repository.database.clone());
    let worktree = input["worktreeId"]
        .as_js_string()
        .context("Export worktree")?
        .lossy();
    let Some(context) = targets
        .worktree_context(&owner, &project, &worktree)
        .await?
    else {
        return Ok(error(
            404,
            "Project worktree was not found or is not ready.",
        ));
    };
    // Source maps the complete owned worker catalog before selecting this worker.
    let workers = WorkerRepository::new(service.repository.database.clone())
        .list_workers(&owner)
        .await?
        .iter()
        .map(Value::from_serialize)
        .collect::<Vec<_>>();
    let Some(worker) = workers
        .iter()
        .find(|worker| worker["workerId"] == context["workerId"])
    else {
        return Ok(error(404, "Project worker was not found."));
    };
    let worker_id = worker["workerId"]
        .as_str()
        .context("Export worker identity")?;
    let capable = truthy(worker.get("externalCodexHistory"));
    let online = truthy(worker.get("online")) && service.workers.bridge.is_connected(worker_id);
    if preview {
        let inspection = if !capable || !online {
            let name = worker["name"]
                .as_js_string()
                .context("Export worker name")?;
            // Concatenate UTF-16 directly; worker names can contain lone surrogates.
            let mut text = name.units().to_vec();
            text.extend(
                if capable {
                    " is offline."
                } else {
                    " does not support local Codex project exports."
                }
                .encode_utf16(),
            );
            json!({"available":false,"destinationLabel":Value::Null,"message":crate::wire::JsString::new(text),"platform":worker["platform"]})
        } else {
            let inspection: Result<Value> = async {
                let result = service.workers.commands.request(worker_id, json!({"type":"project.export.target.inspect","target":input["target"],"cwd":context["worktree"]["path"]}), Some(Duration::from_secs(30)), None).await?;
                crate::settings::parse_response("projectExportTargetInspectionSchema", result.as_ref())
            }.await;
            match inspection {
                Ok(inspection) => inspection,
                Err(cause) => {
                    json!({"available":false,"destinationLabel":Value::Null,"message":exports::message(&cause),"platform":worker["platform"]})
                }
            }
        };
        let mut result = exports::definition::mappings();
        result["target"] = input["target"].clone();
        for field in ["available", "destinationLabel", "message"] {
            result[field] = inspection[field].clone();
        }
        result["worker"] = json!({"workerId":worker["workerId"],"name":worker["name"],"platform":inspection["platform"]});
        result["worktree"] = json!({"worktreeId":context["worktree"]["id"],"name":context["worktree"]["name"],"displayPath":context["worktree"]["displayPath"]});
        return output(200, "projectExportPreviewSchema", &result);
    }
    if !capable {
        return Ok(error(409, "The selected worker cannot export to Codex."));
    }
    if !online {
        return Ok(error(503, "Project worker is offline."));
    }
    let chats = Repository::new(service.repository.database.clone());
    let catalog = chats.list_project(&owner, &project).await?;
    let selected = input["chatIds"]
        .as_array()
        .context("Export Chat selections")?
        .iter()
        .map(|id| catalog.iter().find(|chat| chat["id"] == *id))
        .collect::<Vec<_>>();
    if selected.iter().any(Option::is_none) {
        return Ok(error(404, "One or more selected chats were not found."));
    }
    let selected = selected.into_iter().flatten().collect::<Vec<_>>();
    if selected.iter().any(|chat| chat["experience"] != "agent") {
        return Ok(error(
            409,
            "The selected export target does not support one or more chat types.",
        ));
    }
    if selected
        .iter()
        .any(|chat| chat["status"] == "running" || chat["status"] == "waiting-for-approval")
    {
        return Ok(error(
            409,
            "Wait for selected chats to finish before exporting them.",
        ));
    }
    let mut outcomes = Vec::new();
    for chat in selected {
        let exported: Result<Value> = async {
            let messages = chats.list_messages_with_query_context(&owner, chat["id"].as_str().context("Export Chat identity")?, MessageKind::Encrypted,
                Some((exports::queries::ENCRYPTED_MESSAGES, &[json!("agent"), json!(owner), chat["id"].clone()]))).await?;
            exports::export(&service.workers.commands, exports::Input {
                operation:&input["operationId"], target:&input["target"], worker:worker_id,
                chat:&chat["id"], cwd:&context["worktree"]["path"], title:&chat["titleProtection"],
                payload:&json!({"version":1,"kind":"chat-encrypted","messages":messages,"attachments":Vec::<Value>::new()})
            }).await
        }.await;
        outcomes.push(match exported {
            Ok(exported) => Value::object(
                std::iter::once((crate::wire::JsString::from("status"), json!("exported"))).chain(
                    exported
                        .as_object()
                        .context("Export result")?
                        .iter()
                        .map(|(key, value)| (key.clone(), value.clone())),
                ),
            ),
            Err(cause) => exports::failure(&chat["id"], &cause),
        });
    }
    output(
        200,
        "projectExportResultSchema",
        &json!({"operationId":input["operationId"],"target":input["target"],"workerId":worker["workerId"],"worktreeId":context["worktree"]["id"],"outcomes":outcomes}),
    )
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(project): Path<String>,
    request: Request,
) -> Response {
    let preview = request.uri().path().ends_with("/preview");
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let result: Result<Response> = async {
        let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(body) => body,
            Err(response) => return Ok(response),
        };
        let schema = if preview {
            "projectExportPreviewRequestSchema"
        } else {
            "projectExportCreateSchema"
        };
        let input = match parse(schema, body.as_ref())? {
            Ok(input) => input,
            Err(response) => return Ok(response),
        };
        // Continue the whole multi-command operation if the caller disconnects,
        // and drain it before closing the worker bridge or database.
        service
            .project_operations
            .own(operation(service.clone(), owner, project, input, preview))
            .await
    }
    .await;
    match result {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/projects/{projectId}/exports/preview", post(handle))
        .route("/api/projects/{projectId}/exports", post(handle))
}
