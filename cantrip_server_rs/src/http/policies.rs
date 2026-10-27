use super::{
    body, json_response,
    middleware::{self, Context},
    on_response,
};
use crate::{
    auth::service::AuthService,
    policies::{
        self,
        repository::{PolicyConflict, PolicyRepository, PolicyScopeNotFound},
    },
    wire::{self, ValidationError, Value},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    body::Body,
    extract::{Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::get,
};
use serde_json::{Value as JsonValue, json};
use std::{collections::HashMap, sync::Arc};

fn error(status: u16, message: &str) -> Response {
    json_response(
        StatusCode::from_u16(status).unwrap(),
        json!({"error":message}),
    )
}
fn output(status: u16, schema: &str, value: JsonValue) -> Result<Response> {
    let parsed = wire::parse(schema, Some(&Value::from_serialize(&value)))
        .map_err(|_| anyhow::anyhow!("Stored policy record violates its protocol contract."))?;
    Ok(json_response(StatusCode::from_u16(status).unwrap(), parsed))
}
async fn execute(
    service: &AuthService,
    ctx: &Context,
    params: &HashMap<String, String>,
    request: Request,
) -> Result<Response> {
    let owner = &ctx
        .principal
        .user
        .as_ref()
        .context("authenticated policy owner")?
        .id;
    let repository = PolicyRepository::new(service.repository.database.clone());
    let path = request.uri().path().to_owned();
    let method = request.method().clone();
    let read = method == Method::GET || method == Method::HEAD;
    if read {
        return if path == "/api/policy-templates" {
            output(200, "policyTemplateListSchema", policies::templates())
        } else if let Some(key) = params.get("templateKey") {
            match policies::template(key) {
                Some(template) => output(200, "policyTemplateDetailSchema", template),
                None => Ok(error(404, "Policy template not found.")),
            }
        } else if path == "/api/policies" {
            output(200, "policyWireListSchema", repository.list(owner).await?)
        } else if let Some(id) = params.get("policyId") {
            match repository.get(owner, id).await? {
                Some(policy) => output(200, "policyWireDetailSchema", policy),
                None => Ok(error(404, "Policy not found.")),
            }
        } else if path.ends_with("/effective-policies") {
            match repository
                .resolve_effective(owner, &params["projectId"])
                .await?
            {
                Some(effective) => output(200, "effectivePolicyWireListSchema", effective),
                None => Ok(error(404, "Project not found.")),
            }
        } else {
            let workspace = params.contains_key("workspaceId");
            let id = &params[if workspace {
                "workspaceId"
            } else {
                "projectId"
            }];
            match repository.list_assignments(owner, workspace, id).await? {
                Some(assignments) => output(200, "policyAssignmentWireListSchema", assignments),
                None => Ok(error(
                    404,
                    if workspace {
                        "Workspace not found."
                    } else {
                        "Project not found."
                    },
                )),
            }
        };
    }
    let schema = if path == "/api/policies/bootstrap" && method == Method::POST {
        "encryptedPolicyBootstrapSchema"
    } else if path == "/api/policies/order" && method == Method::PATCH {
        "policyOrderUpdateSchema"
    } else if path == "/api/policies" {
        "encryptedPolicyCreateSchema"
    } else if params.contains_key("policyId") {
        if method == Method::DELETE {
            "policyDeleteSchema"
        } else {
            "encryptedPolicyUpdateSchema"
        }
    } else {
        "policyAssignmentUpdateSchema"
    };
    let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(body) => body,
        Err(response) => return Ok(response),
    };
    let wire_input = match wire::parse(schema, body.as_ref()) {
        Ok(value) => value,
        Err(ValidationError::Invalid(issues)) => {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                Value::object([
                    ("error", Value::String("Invalid request body".into())),
                    ("issues", Value::Array(issues)),
                ]),
            ));
        }
        Err(ValidationError::Operation) => anyhow::bail!("Policy request validation failed."),
    };
    let input = policies::request::storage_input(wire_input.clone())?;
    let assignment = params.contains_key("workspaceId") || params.contains_key("projectId");
    let result: Result<Response> = async {
        if path == "/api/policies/bootstrap" && method == Method::POST {
            output(
                200,
                "policyWireListSchema",
                repository.bootstrap(owner, &input).await?,
            )
        } else if path == "/api/policies/order" && method == Method::PATCH {
            output(
                200,
                "policyWireListSchema",
                repository.reorder_wire(owner, &wire_input).await?,
            )
        } else if path == "/api/policies" {
            output(
                201,
                "policyWireDetailSchema",
                repository.create(owner, &input).await?,
            )
        } else if let Some(id) = params.get("policyId") {
            if method == Method::DELETE {
                let version = input["rowVersion"].as_i64().context("policy row version")?;
                if repository.delete(owner, id, version).await? {
                    let mut response = Response::new(Body::empty());
                    *response.status_mut() = StatusCode::NO_CONTENT;
                    Ok(response)
                } else {
                    Ok(error(404, "Policy not found."))
                }
            } else {
                match repository.update(owner, id, &input).await? {
                    Some(policy) => output(200, "policyWireDetailSchema", policy),
                    None => Ok(error(404, "Policy not found.")),
                }
            }
        } else {
            let workspace = params.contains_key("workspaceId");
            let id = &params[if workspace {
                "workspaceId"
            } else {
                "projectId"
            }];
            repository
                .replace_assignments_wire(owner, workspace, id, &wire_input)
                .await?;
            match repository.list_assignments(owner, workspace, id).await? {
                Some(assignments) => output(200, "policyAssignmentWireListSchema", assignments),
                None => Ok(error(
                    404,
                    if workspace {
                        "Workspace not found."
                    } else {
                        "Project not found."
                    },
                )),
            }
        }
    }
    .await;
    match result {
        Ok(response) if response.status().as_u16() < 400 => {
            let live = service.live.clone();
            let owner = owner.clone();
            let entity = params.get("policyId").cloned();
            Ok(on_response::completed(response, move || {
                if let Some(entity) = entity {
                    live.invalidate(&owner, "policy", &entity);
                } else {
                    live.invalidate_resource(&owner, "policy");
                }
            }))
        }
        Ok(response) => Ok(response),
        Err(failure) if failure.is::<policies::PolicyQueryError>() => Ok(json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            Value::object([(
                "error",
                Value::String(
                    failure
                        .downcast_ref::<policies::PolicyQueryError>()
                        .unwrap()
                        .message
                        .clone(),
                ),
            )]),
        )),
        Err(failure) => Ok(error(
            if failure.is::<PolicyConflict>() {
                409
            } else if assignment && failure.is::<PolicyScopeNotFound>() {
                404
            } else {
                500
            },
            &failure.to_string(),
        )),
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(mut params): Path<HashMap<String, String>>,
    request: Request,
) -> Response {
    // Fastify selects its route tree per method. A literal used by POST/PATCH
    // still matches :policyId for the other supported policy methods.
    let path = request.uri().path();
    if path == "/api/policies/bootstrap" && request.method() != Method::POST {
        params.insert("policyId".into(), "bootstrap".into());
    } else if path == "/api/policies/order" && request.method() != Method::PATCH {
        params.insert("policyId".into(), "order".into());
    }
    match execute(&service, &ctx, &params, request).await {
        Ok(response) => response,
        Err(error) => middleware::failure(&service, &ctx.id, &error),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/policy-templates", get(handle))
        .route("/api/policy-templates/{templateKey}", get(handle))
        .route("/api/policies", get(handle).post(handle))
        .route(
            "/api/policies/bootstrap",
            get(handle).post(handle).patch(handle).delete(handle),
        )
        .route(
            "/api/policies/order",
            get(handle).patch(handle).delete(handle),
        )
        .route(
            "/api/policies/{policyId}",
            get(handle).patch(handle).delete(handle),
        )
        .route(
            "/api/workspaces/{workspaceId}/policies",
            get(handle).patch(handle),
        )
        .route(
            "/api/projects/{projectId}/policies",
            get(handle).patch(handle),
        )
        .route("/api/projects/{projectId}/effective-policies", get(handle))
}
