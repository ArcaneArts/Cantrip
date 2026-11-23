use super::{
    body, json_response,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    project_automations::{
        dispatch,
        repository::{Conflict, Repository},
    },
    wire::{Value, coercion},
    workers::credentials,
};
use anyhow::Result;
use axum::{
    Extension, Router,
    body::Body,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, patch, post},
};
use std::{collections::HashMap, sync::Arc};

fn binary_limit(service: &AuthService) -> u64 {
    (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024
}
async fn public_operation(
    service: Arc<AuthService>,
    owner: String,
    params: HashMap<String, String>,
    method: Method,
    input: Option<Value>,
) -> Result<Response> {
    let repository = Repository::new(service.repository.database.clone());
    if method == Method::GET || method == Method::HEAD {
        return output(
            200,
            "projectAutomationWireListSchema",
            &repository.list(&owner, &params["projectId"]).await?,
        );
    }
    if method == Method::DELETE {
        let id = &params["automationId"];
        let Some(automation) = repository.get(&owner, id).await? else {
            return Ok(error(404, "Automation not found."));
        };
        if !repository.delete(&owner, id).await? {
            return Ok(error(404, "Automation not found."));
        }
        dispatch::publish(
            &service,
            &owner,
            &automation["projectId"],
            &automation["id"],
        );
        return Ok(Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(Body::empty())?);
    }
    let create = method == Method::POST;
    let schema = if create {
        "encryptedProjectAutomationCreateSchema"
    } else {
        "encryptedProjectAutomationUpdateSchema"
    };
    let input = match parse(schema, input.as_ref())? {
        Ok(v) => v,
        Err(response) => return Ok(response),
    };
    let result = if create {
        repository
            .create(&owner, &params["projectId"], &input)
            .await
    } else {
        repository
            .update(&owner, &params["automationId"], &input)
            .await
    };
    match result {
        Ok(Some(automation)) => {
            dispatch::publish(
                &service,
                &owner,
                &automation["projectId"],
                &automation["id"],
            );
            output(
                if create { 201 } else { 200 },
                "projectAutomationWireSchema",
                &automation,
            )
        }
        Ok(None) => Ok(error(
            404,
            if create {
                "Project or target chat not found."
            } else {
                "Automation not found."
            },
        )),
        Err(cause) if cause.is::<Conflict>() => Ok(error(409, cause.to_string())),
        Err(cause) => Err(cause),
    }
}
async fn public(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let method = request.method().clone();
    let input = if method == Method::GET || method == Method::HEAD {
        None
    } else if method == Method::DELETE {
        if let Err(response) = body::parse_ignored(
            request,
            service.config.api_body_limit_bytes,
            binary_limit(&service),
        )
        .await
        {
            return response;
        }
        None
    } else {
        match body::parse_js_buffer(
            request,
            service.config.api_body_limit_bytes,
            binary_limit(&service),
        )
        .await
        {
            Ok(v) => v,
            Err(response) => return response,
        }
    };
    let owner = ctx.principal.user.as_ref().unwrap().id.clone();
    let operation = public_operation(service.clone(), owner, params, method, input);
    match service.scratch_roots.owned(operation).await {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
async fn worker_operation(
    service: Arc<AuthService>,
    authorization: Option<String>,
    worker: Option<Value>,
    automation: Option<String>,
    input: Option<Value>,
    request_id: String,
) -> Result<Response> {
    if !coercion::truthy(worker.as_ref()) {
        return Ok(error(400, "workerId is required."));
    }
    let worker = coercion::string(worker.as_ref().unwrap())
        .map_err(|_| anyhow::anyhow!("Worker query coercion failed"))?
        .lossy()
        .into_owned();
    let Some(auth) = credentials::authenticate(
        &service.workers.repository,
        &service.config,
        authorization.as_deref(),
        &worker,
        "worker:automations",
    )
    .await?
    else {
        return Ok(error(401, "Unauthorized"));
    };
    let owner = auth.credential.owner_id;
    if service
        .workers
        .repository
        .get_worker(&owner, &worker)
        .await?
        .is_none()
    {
        return Ok(error(404, "Worker not found."));
    }
    if let Some(id) = automation {
        let input = match parse("projectAutomationDispatchRequestSchema", input.as_ref())? {
            Ok(v) => v,
            Err(response) => return Ok(response),
        };
        let result = dispatch::run(service, owner, worker, id, input, request_id).await?;
        Ok(json_response(
            StatusCode::from_u16(result.status)?,
            result.value,
        ))
    } else {
        output(
            200,
            "projectAutomationWireListSchema",
            &Repository::new(service.repository.database.clone())
                .list_for_worker(&owner, &worker)
                .await?,
        )
    }
}
async fn worker(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    let query = super::account::query(request.uri());
    let authorization = middleware::value(request.headers(), "authorization");
    let automation = params.get("automationId").cloned();
    // Fastify's content-type parser runs before route authentication or schema
    // validation. Worker existence is checked before the dispatch body schema.
    let input = if automation.is_some() {
        match body::parse_js_buffer(
            request,
            service.config.api_body_limit_bytes,
            binary_limit(&service),
        )
        .await
        {
            Ok(v) => v,
            Err(response) => return response,
        }
    } else {
        None
    };
    let operation = worker_operation(
        service.clone(),
        authorization,
        query.get("workerId").cloned(),
        automation,
        input,
        ctx.id.clone(),
    );
    match service.scratch_roots.owned(operation).await {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route(
            "/api/projects/{projectId}/automations",
            get(public).post(public),
        )
        .route(
            "/api/automations/{automationId}",
            patch(public).delete(public),
        )
        .route("/api/internal/workers/automations", get(worker))
        .route(
            "/api/internal/workers/automations/{automationId}/dispatch",
            post(worker),
        )
}
