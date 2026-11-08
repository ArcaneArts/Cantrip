//! Managed desktop reads and encrypted mutations retain their distinct catches.
use super::{
    body,
    middleware::{self, Context},
    remote_surfaces::{placement_failure, publish},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    projects::placement::PlacementRepository,
    remote_surfaces::{Repository, StateConflict},
    wire::{Value, coercion, value::json},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::get,
};
use std::{collections::HashMap, sync::Arc, time::Duration};

async fn create(
    service: &AuthService,
    owner: &str,
    project: &str,
    input: &Value,
) -> Result<Response> {
    let selected:Result<(String, Option<Value>)>=async {
        if coercion::truthy(input.get("cantripOsBindingId")) {
            let os=crate::cantrip_os::Repository{database:service.repository.database.clone()};
            let source=os.binding_context(owner,input["cantripOsBindingId"].as_str().context("OS binding")?).await?
                .filter(|source|source["available"]==true&&source["binding"]["projectId"]==project&&source["instance"]["runtimeGeneration"].as_str()==input["cantripOsRuntimeGeneration"].as_str())
                .context(crate::cantrip_os::PlacementError("The selected desktop source is unavailable or stale."))?;
            let worker=source["instance"]["workerId"].as_str().context("Desktop worker")?.to_owned();
            let captured=serde_json::json!({"binding_generation":source["binding"]["bindingGeneration"],"attachment_generation":source["instance"]["attachmentGeneration"],"runtime_generation":source["instance"]["runtimeGeneration"]});
            let execution=crate::cantrip_os::chats::execution_for_source(owner,&source,&captured)?;
            Ok((worker,Some(Value::from_serialize(&execution))))
        } else {
            let connected=|worker:&str|service.workers.commands.is_connected(worker);
            let selected=PlacementRepository::new(service.repository.database.clone())?.resolve(owner,project,"remote-desktop",input.get("target"),Some(&connected),false).await?;
            Ok((selected["placement"]["workerId"].as_str().context("Desktop placement")?.to_owned(),None))
        }
    }.await;
    let (worker, execution) = match selected {
        Ok(value) => value,
        Err(cause) => {
            if let Some(value) = cause.downcast_ref::<crate::cantrip_os::PlacementError>() {
                return Ok(error(409, value.0));
            }
            if let Some(response) = placement_failure(&cause) {
                return Ok(response);
            }
            return Err(cause);
        }
    };
    if !service.workers.commands.is_connected(&worker) {
        return Ok(super::json_response(
            StatusCode::CONFLICT,
            json!({"code":"worker-offline","error":"The selected worker is offline."}),
        ));
    }
    let result:Result<Response>=async {
        let prepared=if let Some(execution)=execution {
            let response=service.workers.commands.request(&worker,json!({"type":"surface.desktop.os-prepare","serverId":service.server_id,"projectId":project,"osExecution":execution}),Some(Duration::from_secs(30)),None).await?;
            Some(crate::settings::parse_response("remoteDesktopPreparedGenerationSchema",response.as_ref())?)
        }else{None};
        if !coercion::truthy(input.get("cantripOsBindingId")) {
            let response=service.workers.commands.request(&worker,json!({"type":"surface.desktop.probe"}),Some(Duration::from_secs(20)),None).await?;
            let probe=crate::settings::parse_response("remoteDesktopProbeResultSchema",response.as_ref())?;
            if probe["available"]!=true {
                return Ok(error(409,probe.get("message").filter(|v|!v.is_null()).and_then(Value::as_js_string).cloned().unwrap_or_else(||"The project worker could not start managed Remote Desktop.".into())));
            }
        }
        match Repository::new(service.repository.database.clone()).create_desktop(owner,project,&worker,input,prepared.as_ref().and_then(|v|v.get("desktopGeneration"))).await? {
            Some(value)=>output(201,"remoteDesktopWireSummarySchema",&value),
            None=>Ok(error(404,"Project or worker not found.")),
        }
    }.await;
    Ok(result.unwrap_or_else(|cause| {
        if let Some(value) = cause.downcast_ref::<crate::pane_layouts::LegacyInvariant>() {
            error(400, value.to_string())
        } else {
            error(502, crate::settings::operation_error_message(&cause))
        }
    }))
}
async fn update(service: &AuthService, owner: &str, id: &str, input: &Value) -> Result<Response> {
    let repository = Repository::new(service.repository.database.clone());
    let Some(context) = repository
        .context(owner, id)
        .await?
        .filter(|v| v["surface"]["kind"] == "desktop")
    else {
        return Ok(error(404, "Remote Desktop not found."));
    };
    let updated = match repository.update(owner, id, input).await {
        Ok(Some(value)) => value,
        Ok(None) => return Ok(error(404, "Remote Desktop not found.")),
        Err(cause) if cause.is::<StateConflict>() => {
            return Ok(super::json_response(
                StatusCode::CONFLICT,
                json!({"code":"stale-state","error":"Remote Desktop state changed before this update."}),
            ));
        }
        Err(cause) => return Err(cause),
    };
    let worker = context["workerId"].as_str().context("Desktop worker")?;
    if service.workers.commands.is_connected(worker) {
        if service.workers.commands.request(worker,json!({"type":"surface.configure","surfaceId":context["surface"]["id"],"serverId":service.server_id,"configuration":context["surface"]["configuration"],"stateResource":"remote-desktop-row","stateRevision":updated["stateRevision"],"stateProtection":updated["stateProtection"]}),Some(Duration::from_secs(20)),None).await.is_err() {
            repository.record_status(&service.live,owner,id,"error",Some("The worker could not apply the encrypted Remote Desktop target.")).await?;
        }
    } else {
        repository.record_status(&service.live,owner,id,"offline",Some("Worker is offline. The saved encrypted target will be restored when it reconnects.")).await?;
    }
    match repository.desktop(owner, id).await? {
        Some(value) => output(200, "remoteDesktopWireSummarySchema", &value),
        None => Ok(error(404, "Remote Desktop not found.")),
    }
}
async fn execute(
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    method: Method,
    input: Option<Value>,
) -> Result<Response> {
    let repository = Repository::new(service.repository.database.clone());
    if method == Method::GET || method == Method::HEAD {
        return if let Some(project) = params.get("projectId") {
            output(
                200,
                "remoteDesktopWireListSchema",
                &Value::Array(repository.desktops(&owner, project).await?),
            )
        } else {
            match repository.desktop(&owner, &params["desktopId"]).await? {
                Some(value) => output(200, "remoteDesktopWireSummarySchema", &value),
                None => Ok(error(404, "Remote Desktop not found.")),
            }
        };
    }
    let schema = if method == Method::POST {
        "encryptedRemoteDesktopCreateSchema"
    } else {
        "encryptedRemoteDesktopUpdateSchema"
    };
    let input = match parse(schema, input.as_ref())? {
        Ok(value) => value,
        Err(response) => return Ok(response),
    };
    if method == Method::POST {
        create(&service, &owner, &params["projectId"], &input).await
    } else {
        update(&service, &owner, &params["desktopId"], &input).await
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let owner = ctx
        .principal
        .user
        .as_ref()
        .expect("Admitted desktop request")
        .id
        .clone();
    let method = request.method().clone();
    let mutation = method != Method::GET && method != Method::HEAD;
    let result: Result<Response> = async {
        let input = if mutation {
            match body::parse_js_buffer(
                request,
                service.config.api_body_limit_bytes,
                (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024,
            )
            .await
            {
                Ok(value) => value,
                Err(response) => return Ok(response),
            }
        } else {
            drop(request);
            None
        };
        service
            .worker_maintenance
            .owned(execute(
                service.clone(),
                owner.clone(),
                params.clone(),
                method,
                input,
            ))
            .await
    }
    .await;
    let response = result.unwrap_or_else(|cause| middleware::failure(&service, &ctx.id, &cause));
    if mutation {
        publish(&service, owner, params, response)
    } else {
        response
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/projects/{projectId}/remote-desktops",
            get(handle).post(handle),
        )
        .route(
            "/api/remote-desktops/{desktopId}",
            get(handle).patch(handle),
        )
}
