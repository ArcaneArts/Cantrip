//! Project-affine service discovery through the existing worker command bus.
use super::{
    browsers::allows,
    middleware::{self, Context},
    settings::{error, output},
};
use crate::{
    auth::service::AuthService,
    projects::{placement::collator, repository::ProjectRepository},
    settings::{operation_error_message, parse_response},
    wire::{JsString, Value, value::json},
    workers::command_bus::CommandFailure,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, State},
    response::Response,
    routing::get,
};
use std::{collections::HashMap, sync::Arc, time::Duration};

const WORKER_LIMIT: usize = 64;
const SERVICE_LIMIT: usize = 1_024;
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(20);

fn bounded(text: &JsString, limit: usize) -> JsString {
    JsString::new(text.units()[..text.len().min(limit)].to_vec())
}
fn named(prefix: &str, name: &JsString, suffix: &str) -> JsString {
    JsString::new(
        prefix
            .encode_utf16()
            .chain(name.units().iter().copied())
            .chain(suffix.encode_utf16())
            .collect(),
    )
}
async fn discover(service: &Arc<AuthService>, worker: &str) -> Result<Value> {
    let response = service
        .workers
        .commands
        .request(
            worker,
            json!({"type":"browser.services.discover"}),
            Some(DISCOVERY_TIMEOUT),
            None,
        )
        .await?;
    parse_response("browserServiceListSchema", response.as_ref())
}
async fn scan(service: &Arc<AuthService>, project: &str, worker: &Value) -> Result<Value> {
    let id = worker["workerId"].as_str().context("Discovery worker")?;
    let name = bounded(worker["name"].as_js_string().context("Worker name")?, 200);
    let mut result = json!({"workerId":id,"workerName":name,"status":"offline","services":Value::Array(Vec::new()),"error":json!({"code":"worker-offline","message":named("",&name," is offline.")}),"truncated":false});
    if worker["online"] != true || !service.workers.bridge.is_connected(id) {
        return Ok(result);
    }
    match discover(service, id).await {
        Ok(mut services) => {
            let Value::Array(items) = &mut services else {
                anyhow::bail!("Discovered services")
            };
            for item in items {
                item["workerId"] = json!(id);
                item["workerName"] = json!(name);
                item["placement"] = json!({"projectId":project,"workerId":id,"projectReplicaId":Value::Null,"worktreeId":Value::Null,"surface":Value::Null});
            }
            result["status"] = json!("ok");
            result["services"] = services;
            result["error"] = Value::Null;
        }
        Err(failure) => {
            let message = bounded(&operation_error_message(&failure), 1_000);
            let unavailable = matches!(failure.downcast_ref::<CommandFailure>(),Some(CommandFailure::Bridge(error)) if error.unavailable);
            let timed_out = message.lowercase().lossy().contains("timed out");
            let (status, code) = if unavailable {
                ("offline", "worker-offline")
            } else if timed_out {
                ("timed-out", "worker-timeout")
            } else {
                ("error", "worker-error")
            };
            result["status"] = json!(status);
            result["error"] = json!({"code":code,"message":if message.is_empty(){named("Could not scan ",&name,".")}else{message}});
        }
    }
    Ok(result)
}
async fn fleet(service: &Arc<AuthService>, owner: &str, id: &str) -> Result<Response> {
    let Some(project) = ProjectRepository::new(service.repository.database.clone())?
        .get(owner, id)
        .await?
    else {
        return Ok(error(404, "Project not found."));
    };
    let mut workers = service
        .workers
        .repository
        .list_workers(owner)
        .await?
        .iter()
        .map(Value::from_serialize)
        .filter(|worker| {
            worker["remoteSurfaces"]["browser"] == true && allows(&project, &worker["workerId"])
        })
        .collect::<Vec<_>>();
    let collator = collator()?;
    workers.sort_by(|left, right| {
        ["name", "workerId"]
            .into_iter()
            .map(|key| {
                collator.compare_utf16(
                    left[key].as_js_string().unwrap().units(),
                    right[key].as_js_string().unwrap().units(),
                )
            })
            .find(|order| !order.is_eq())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut truncated = workers.len() > WORKER_LIMIT;
    let results = futures::future::join_all(
        workers
            .iter()
            .take(WORKER_LIMIT)
            .map(|worker| scan(service, id, worker)),
    )
    .await;
    let mut remaining = SERVICE_LIMIT;
    let mut partial = false;
    let mut workers = Vec::new();
    for result in results {
        let mut result = result?;
        let Value::Array(services) = &mut result["services"] else {
            anyhow::bail!("Fleet services")
        };
        let cut = services.len() > remaining;
        services.truncate(remaining);
        remaining -= services.len();
        truncated |= cut;
        partial |= result["status"] != "ok";
        result["truncated"] = json!(cut);
        workers.push(result);
    }
    output(
        200,
        "browserServiceFleetDiscoverySchema",
        &json!({"projectId":id,"observedAt":crate::auth::iso(crate::auth::now()),"partial":partial||truncated,"truncated":truncated,"workers":workers}),
    )
}
async fn browser(service: &Arc<AuthService>, owner: &str, id: &str) -> Result<Response> {
    let Some(context) =
        crate::remote_surfaces::Repository::new(service.repository.database.clone())
            .context(owner, id)
            .await?
            .filter(|context| context["surface"]["kind"] == "browser")
    else {
        return Ok(error(404, "Browser not found."));
    };
    let worker = context["workerId"].as_str().context("Browser worker")?;
    if !service.workers.bridge.is_connected(worker) {
        return Ok(error(503, "Project worker is offline."));
    }
    let result: Result<Response> = async {
        let mut services = discover(service, worker).await?;
        let Value::Array(items) = &mut services else {
            anyhow::bail!("Browser services")
        };
        for item in items {
            item["workerId"] = json!(worker);
        }
        output(200, "browserServiceListSchema", &services)
    }
    .await;
    Ok(result.unwrap_or_else(|failure| {
        error(
            failure
                .downcast_ref::<CommandFailure>()
                .map_or(502, |f| f.status(502)),
            operation_error_message(&failure),
        )
    }))
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
) -> Response {
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let owned = service.clone();
    let result = service
        .worker_maintenance
        .owned(async move {
            if let Some(id) = params.get("projectId") {
                fleet(&owned, &owner, id).await
            } else {
                browser(
                    &owned,
                    &owner,
                    params.get("browserId").context("Browser route")?,
                )
                .await
            }
        })
        .await;
    result.unwrap_or_else(|failure| middleware::failure(&service, &ctx.id, &failure))
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/projects/{projectId}/browser-services", get(handle))
        .route("/api/browsers/{browserId}/services", get(handle))
}
