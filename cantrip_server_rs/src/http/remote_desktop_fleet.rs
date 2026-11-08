//! Bounded parallel fleet discovery leaves encrypted inventories opaque.
use super::{
    browser_discovery::{bounded, named},
    browsers::allows,
    middleware::{self, Context},
    settings::{error, output},
};
use crate::{
    auth::service::AuthService,
    projects::{placement::collator, repository::ProjectRepository},
    remote_surfaces::Repository,
    wire::{Value, coercion, value::json},
    workers::command_bus::CommandFailure,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, State},
    response::Response,
    routing::get,
};
use std::{sync::Arc, time::Duration};

async fn scan(
    service: &AuthService,
    worker: &Value,
    desktops: &[Value],
    limit: usize,
) -> Result<Value> {
    let id = worker["workerId"]
        .as_str()
        .context("Fleet worker identity")?;
    let name = bounded(
        worker["name"].as_js_string().context("Fleet worker name")?,
        200,
    );
    let mut value = json!({"workerId":id,"workerName":name,
        "platform":bounded(worker["platform"].as_js_string().context("Fleet platform")?,100),
        "architecture":bounded(worker["architecture"].as_js_string().context("Fleet architecture")?,100),
        "desktops":desktops.iter().filter(|v|v["workerId"]==id).cloned().collect::<Vec<_>>(),
        "status":"offline","inventoryOperationId":Value::Null,"inventoryProtection":Value::Null,
        "monitorCount":0,"windowCount":0,"truncated":false,
        "error":json!({"code":"worker-offline","message":named("",&name," is offline.")})});
    if !coercion::truthy(worker.get("online")) || !service.workers.commands.is_connected(id) {
        return Ok(value);
    }
    let result:Result<Value>=async {
        let response=service.workers.commands.request(id,json!({"type":"surface.desktop.targets","serverId":service.server_id,"operationId":uuid::Uuid::new_v4().to_string(),"resourceId":id,"limit":limit}),Some(Duration::from_secs(20)),None).await?;
        crate::settings::parse_response("remoteDesktopProtectedInventorySchema",response.as_ref())
    }.await;
    match result {
        Ok(inventory) => {
            value["status"] = json!("ok");
            value["inventoryOperationId"] = inventory["operationId"].clone();
            value["inventoryProtection"] = inventory["stateProtection"].clone();
            for key in ["monitorCount", "windowCount", "truncated"] {
                value[key] = inventory[key].clone();
            }
            value["error"] = Value::Null;
        }
        Err(cause) => {
            let unavailable = matches!(cause.downcast_ref::<CommandFailure>(),Some(CommandFailure::Bridge(error)) if error.unavailable);
            let message = bounded(&crate::settings::operation_error_message(&cause), 1000);
            let timed_out = message.lowercase().lossy().contains("timed out");
            let (status, code, message) = if unavailable {
                (
                    "offline",
                    "worker-offline",
                    named("", &name, " is offline."),
                )
            } else if timed_out {
                (
                    "timed-out",
                    "worker-timeout",
                    named("Timed out inspecting ", &name, "."),
                )
            } else {
                (
                    "error",
                    "worker-error",
                    named("Could not inspect ", &name, "."),
                )
            };
            value["status"] = json!(status);
            value["error"] = json!({"code":code,"message":message});
        }
    }
    Ok(value)
}
async fn fleet(service: Arc<AuthService>, owner: String, project: String) -> Result<Response> {
    let Some(project_value) = ProjectRepository::new(service.repository.database.clone())?
        .get(&owner, &project)
        .await?
    else {
        return Ok(error(404, "Project not found."));
    };
    let repository = Repository::new(service.repository.database.clone());
    let (workers, desktops) = tokio::try_join!(
        service.workers.repository.list_workers(&owner),
        repository.desktops(&owner, &project)
    )?;
    let mut workers = workers
        .iter()
        .map(Value::from_serialize)
        .filter(|w| {
            coercion::truthy(w["remoteSurfaces"].get("desktop"))
                && allows(&project_value, &w["workerId"])
        })
        .collect::<Vec<_>>();
    let collator = collator()?;
    workers.sort_by(|a, b| {
        ["name", "workerId"]
            .into_iter()
            .map(|key| {
                collator.compare_utf16(
                    a[key].as_js_string().unwrap().units(),
                    b[key].as_js_string().unwrap().units(),
                )
            })
            .find(|order| !order.is_eq())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut truncated = workers.len() > 64;
    workers.truncate(64);
    let limit = if workers.is_empty() {
        0
    } else {
        4096 / workers.len()
    };
    let results = futures::future::join_all(
        workers
            .iter()
            .map(|worker| scan(&service, worker, &desktops, limit)),
    )
    .await;
    let mut partial = false;
    let mut workers = Vec::new();
    for result in results {
        let mut worker = result?;
        let Value::Array(desktops) = &mut worker["desktops"] else {
            anyhow::bail!("Fleet desktops")
        };
        let cut = desktops.len() > 64;
        desktops.truncate(64);
        worker["truncated"] = json!(worker["truncated"] == true || cut);
        truncated |= worker["truncated"] == true;
        partial |= worker["status"] != "ok";
        workers.push(worker);
    }
    output(
        200,
        "remoteDesktopFleetWireSchema",
        &json!({"projectId":project,"observedAt":crate::auth::iso(crate::auth::now()),"partial":partial||truncated,"truncated":truncated,"workers":workers}),
    )
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(project): Path<String>,
) -> Response {
    let owner = ctx
        .principal
        .user
        .as_ref()
        .expect("Admitted fleet request")
        .id
        .clone();
    service
        .worker_maintenance
        .owned(fleet(service.clone(), owner, project))
        .await
        .unwrap_or_else(|cause| middleware::failure(&service, &ctx.id, &cause))
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route(
        "/api/projects/{projectId}/remote-desktop-fleet",
        get(handle),
    )
}
