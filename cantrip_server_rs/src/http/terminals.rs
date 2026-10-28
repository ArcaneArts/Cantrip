use super::{
    body,
    middleware::{self, Context},
    on_response,
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    projects::placement::Unavailable,
    terminals::Repository,
    wire::{Value, coercion},
    workers::command_bus::CommandFailure,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::Method,
    response::Response,
    routing::{get, patch, post, put},
};
use std::{collections::HashMap, sync::Arc};

fn conflict(failure: anyhow::Error) -> Response {
    error(409, crate::settings::operation_error_message(&failure))
}
async fn mutate(
    service: Arc<AuthService>,
    owner: String,
    project: Option<String>,
    terminal: Option<String>,
    method: Method,
    input: Value,
) -> Result<Response> {
    let repository = Repository::new(service.repository.database.clone());
    if let Some(project) = project {
        let connected = |worker: &str| service.workers.bridge.is_connected(worker);
        return match repository
            .create(&owner, &project, &input, Some(&connected))
            .await
        {
            Ok(Some(terminal)) => output(201, "terminalWireSummarySchema", &terminal),
            Ok(None) => Ok(error(404, "Project source not found.")),
            Err(failure) => {
                if let Some(unavailable) = failure.downcast_ref::<Unavailable>() {
                    Ok(super::json_response(
                        if unavailable.code == "project-not-found" {
                            axum::http::StatusCode::NOT_FOUND
                        } else {
                            axum::http::StatusCode::CONFLICT
                        },
                        Value::object([
                            ("code", Value::String(unavailable.code.into())),
                            ("error", Value::String(unavailable.message.clone().into())),
                        ]),
                    ))
                } else {
                    Err(failure)
                }
            }
        };
    }
    let terminal = terminal.context("Terminal route identity")?;
    if method == Method::PATCH {
        let result = async {
            match repository.update(&owner, &terminal, &input).await? {
                Some(terminal) => output(200, "terminalWireSummarySchema", &terminal),
                None => Ok(error(404, "Terminal not found.")),
            }
        }
        .await;
        return Ok(result.unwrap_or_else(conflict));
    }
    if method == Method::PUT {
        let result=async {
            let Some(context)=repository.context(&owner,&terminal).await? else{return Ok(error(404,"Terminal not found."))};
            if context["kind"]=="run-configuration"||!coercion::truthy(context.get("stateProtection")){return Ok(error(409,"Run configuration terminals are read-only and use the managed runtime output API."))}
            let Some(mut updated)=repository.configure_service(&owner,&terminal,&input).await? else{return Ok(error(404,"Terminal not found."))};
            let worker=context["workerId"].as_str().context("Terminal worker")?;
            let enabled=input["enabled"]==true;
            let mut status=if enabled{"offline"}else{"idle"};
            if service.workers.bridge.is_connected(worker){
                if service.worker_maintenance.reconcile_services(&owner,worker).await.is_ok(){status=if enabled{"running"}else{"idle"};}
                else {eprintln!("{}",Value::object([("event",Value::String("terminal.service.reconciliation-deferred".into())),("subsystem",Value::String("terminal".into()))]).stringify());}
            }
            service.worker_maintenance.record_status(&owner,&terminal,status).await?;
            updated["status"]=Value::String(status.into());
            output(200,"terminalWireSummarySchema",&updated)
        }.await;
        return Ok(result.unwrap_or_else(conflict));
    }
    let Some(context) = repository.context(&owner, &terminal).await? else {
        return Ok(error(404, "Terminal not found."));
    };
    if context["kind"] == "run-configuration" {
        return Ok(error(
            409,
            "Run configuration terminals are controlled by their runtime.",
        ));
    }
    if context["serviceEnabled"] != true {
        return Ok(error(409, "Terminal service is disabled."));
    }
    let worker = context["workerId"].as_str().context("Terminal worker")?;
    if !service.workers.bridge.is_connected(worker) {
        service
            .worker_maintenance
            .record_status(&owner, &terminal, "offline")
            .await?;
        return Ok(error(503, "Project worker is offline."));
    }
    let result: Result<Response> = async {
        service
            .worker_maintenance
            .restart_service(worker, &terminal)
            .await?;
        service
            .worker_maintenance
            .record_status(&owner, &terminal, "running")
            .await?;
        Ok(super::json_response(
            axum::http::StatusCode::ACCEPTED,
            Value::object([("accepted", Value::Bool(true))]),
        ))
    }
    .await;
    match result {
        Ok(response) => Ok(response),
        Err(failure) => Ok(error(
            failure
                .downcast_ref::<CommandFailure>()
                .map_or(502, |e| e.status(502)),
            crate::settings::operation_error_message(&failure),
        )),
    }
}
async fn execute(
    service: Arc<AuthService>,
    owner: &str,
    params: &HashMap<String, String>,
    request: Request,
) -> Result<Response> {
    let method = request.method().clone();
    if method == Method::GET || method == Method::HEAD {
        let project = params.get("projectId").context("Terminal project")?;
        return output(
            200,
            "terminalWireListSchema",
            &Value::Array(
                Repository::new(service.repository.database.clone())
                    .list(owner, project)
                    .await?,
            ),
        );
    }
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(v) => v,
        Err(response) => return Ok(response),
    };
    let input = if method == Method::POST && !params.contains_key("projectId") {
        Value::Null
    } else {
        let schema = if params.contains_key("projectId") {
            "encryptedTerminalCreateSchema"
        } else if method == Method::PATCH {
            "encryptedTerminalUpdateSchema"
        } else {
            "encryptedTerminalServiceConfigurationSchema"
        };
        match parse(schema, body.as_ref())? {
            Ok(v) => v,
            Err(response) => return Ok(response),
        }
    };
    service
        .worker_maintenance
        .owned(mutate(
            service.clone(),
            owner.to_owned(),
            params.get("projectId").cloned(),
            params.get("terminalId").cloned(),
            method,
            input,
        ))
        .await
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let mutation = ![Method::GET, Method::HEAD].contains(request.method());
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    match execute(service.clone(), &owner, &params, request).await {
        Ok(response) if mutation && response.status().as_u16() < 400 => {
            let live = service.live.clone();
            let project = params.get("projectId").cloned();
            let entity = params.get("terminalId").or(project.as_ref()).cloned();
            on_response::completed(response, move || {
                for resource in ["terminal", "project-tab-layout"] {
                    let scope = project.as_ref().map_or_else(
                        || Value::object([("kind", Value::String("current-user".into()))]),
                        |p| {
                            Value::object([
                                ("kind", Value::String("project".into())),
                                ("projectId", Value::String(p.clone().into())),
                            ])
                        },
                    );
                    let _ = live.publish_event(Value::object([
                        ("ownerId", Value::String(owner.clone().into())),
                        ("scope", scope),
                        ("resource", Value::String(resource.into())),
                        ("action", Value::String("invalidated".into())),
                        (
                            "entityId",
                            entity
                                .as_ref()
                                .map_or(Value::Null, |v| Value::String(v.clone().into())),
                        ),
                        ("revision", Value::Null),
                        ("payload", Value::Null),
                    ]));
                }
            })
        }
        Ok(response) => response,
        Err(failure) => middleware::failure(&service, &ctx.id, &failure),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/projects/{projectId}/terminals",
            get(handle).post(handle),
        )
        .route("/api/terminals/{terminalId}", patch(handle))
        .route("/api/terminals/{terminalId}/service", put(handle))
        .route("/api/terminals/{terminalId}/service/restart", post(handle))
}
