//! Alert tools use authenticated worker bindings; no public generic resolve API.
use super::{
    body, json_response,
    middleware::{self, Context},
    settings::parse,
};
use crate::{
    agent_alerts,
    auth::service::AuthService,
    chats, project_alerts,
    wire::{Value, value::json},
    workers::credentials,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Query, Request, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
};
use std::{collections::HashMap, sync::Arc};
pub(super) fn failure(status: u16, code: &str, message: &str) -> Response {
    json_response(
        StatusCode::from_u16(status).unwrap(),
        json!({"code":code,"error":message}),
    )
}
async fn authenticate(
    service: &AuthService,
    worker: &str,
    authorization: Option<&str>,
) -> Result<Option<String>> {
    let auth = credentials::authenticate(
        &service.workers.repository,
        &service.config,
        authorization,
        worker,
        "worker:agent-tools",
    )
    .await?;
    Ok(auth.map(|a| a.credential.owner_id))
}
async fn capabilities(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let result: Result<Response> = async {
        let query = Value::from_serialize(&json!(query));
        let query = match parse("workerCantripMcpCapabilitiesQuerySchema", Some(&query))? {
            Ok(v) => v,
            Err(r) => return Ok(r),
        };
        let worker = query["workerId"].as_str().context("Worker identity")?;
        let authorization = middleware::value(&headers, "authorization");
        let Some(owner) = authenticate(&service, worker, authorization.as_deref()).await? else {
            return Ok(failure(401, "invalid", "Unauthorized"));
        };
        if service
            .repository
            .database
            .query(
                "SELECT 1 FROM workers WHERE id=$1 AND owner_id=$2",
                &[&worker, &owner],
            )
            .await?
            .is_empty()
        {
            return Ok(failure(404, "not-found", "Worker not found."));
        }
        // Alerts and Tasks require the current binding shape. Other MCP domains
        // are advertised only when their native runtime implementations exist.
        Ok(json_response(
            StatusCode::OK,
            json!({"bindingProtocolVersions":[1,2],"operations":agent_alerts::OPERATIONS}),
        ))
    }
    .await;
    result.unwrap_or_else(|e| middleware::failure(&service, &ctx.id, &e))
}
async fn execute_operation(service: &Arc<AuthService>, owner: &str, call: &Value) -> Result<Value> {
    use super::agent_operations::{OperationError, parse};
    let binding = &call["binding"];
    let worker = binding["workerId"].as_str().context("Worker identity")?;
    let repository = chats::Repository::new(service.repository.database.clone());
    let context = repository
        .execution_context(owner, binding["chatId"].as_str().context("Chat identity")?)
        .await?
        .ok_or_else(|| {
            OperationError::new(
                409,
                "stale-binding",
                "The MCP binding chat context no longer exists.",
            )
        })?;
    let operation = call["request"]["operation"]
        .as_str()
        .context("MCP operation")?;
    let permission = &chats::managed_console::permission_profile(&context)["effectiveId"];
    agent_alerts::validate_binding(
        owner,
        binding,
        &context,
        operation,
        permission,
        crate::auth::now().timestamp_millis(),
    )
    .map_err(|error| OperationError::new(error.status, error.code, error.message))?;
    if operation == "context.get" {
        if !call["request"]["arguments"]
            .as_object()
            .is_some_and(|v| v.is_empty())
        {
            return Err(
                OperationError::new(400, "invalid", "Context probe takes no arguments.").into(),
            );
        }
        let rows = service
            .repository
            .database
            .query(
                "SELECT name FROM workers WHERE id=$1 AND owner_id=$2",
                &[&worker, &owner],
            )
            .await?;
        let row = rows
            .first()
            .ok_or_else(|| OperationError::new(404, "not-found", "Worker not found."))?;
        let name = row.get::<String>(0)?;
        let public = json!({"chatId":context["chatId"],"executionLaneId":context["executionLaneId"],"permissionProfileId":permission,"projectId":context["projectId"],"rootKind":context["rootKind"],"terminalId":Value::Null,"workerId":worker,"worktreeId":context["worktreeId"],"worktreeMode":context["worktreeMode"]});
        let data = json!({"worker":json!({"id":worker,"name":name,"online":service.workers.bridge.is_connected(worker)}),"context":public,"binding":agent_alerts::readiness(binding,&context,permission),"contextWindow":Value::Null});
        return parse(
            "cantripMcpContextGetResultSchema",
            &json!({"summary":"Returned the bound Cantrip context.","data":data,"worktreeId":context["worktreeId"],"target":Value::Null,"mutated":false,"continuationScheduled":false}),
        );
    }
    if operation.starts_with("task.") {
        return super::agent_tasks::execute(
            service,
            owner,
            &context,
            operation,
            &call["request"]["arguments"],
        )
        .await;
    }
    if context["contextKind"] != "project" {
        return Err(OperationError::new(403, "invalid", "Alerts require a project Chat.").into());
    }
    let input = parse(
        "agentAlertMutationWireSchema",
        &call["request"]["arguments"],
    )?;
    let aad = &input["protectedDetail"]["context"];
    let expected = if operation == "alert.resolve" {
        "resolved"
    } else {
        "open"
    };
    if input["status"] != expected
        || aad["serverId"] != service.server_id
        || aad["workerId"] != worker
        || aad["scopeId"] != context["chatId"]
        || aad["operationId"] != input["key"]
        || aad["sequence"] != input["revision"]
        || aad["operation"] != "agent-alert"
    {
        return Err(OperationError::new(
            403,
            "invalid",
            "The Alert payload does not match its authenticated Chat context.",
        )
        .into());
    }
    let alert = project_alerts::Repository::new(service.repository.database.clone())
        .apply_agent(owner, &context, &input)
        .await?
        .ok_or_else(|| {
            OperationError::new(
                409,
                "conflict",
                "The originating Chat execution is no longer active.",
            )
        })?;
    Ok(
        json!({"summary":if alert["status"]=="resolved"{"Project Alert resolved."}else{"Project Alert raised."},"data":json!({"id":alert["id"],"key":input["key"],"status":alert["status"],"revision":alert["sourceRevision"]}),"mutated":true,"worktreeId":context["worktreeId"],"target":Value::Null,"continuationScheduled":false}),
    )
}

async fn handle_operation(
    service: &Arc<AuthService>,
    context: &Context,
    authorization: Option<&str>,
    raw: Option<&Value>,
) -> Result<Response> {
    use super::agent_operations::{OperationError, audit};
    let call = match crate::wire::parse("compatibleWorkerCantripMcpOperationCallSchema", raw) {
        Ok(call) => call,
        Err(crate::wire::ValidationError::Invalid(issues)) => {
            return Ok(json_response(
                StatusCode::BAD_REQUEST,
                json!({
                    "code":"incompatible-worker-protocol",
                    "error":"Cantrip worker/server MCP relay protocol mismatch. This is not a tool argument error. Do not retry this MCP call or change its arguments; use the Cantrip CLI fallback for this turn and report that the worker/server deployment needs updating.",
                    "issues":issues
                }),
            ));
        }
        Err(crate::wire::ValidationError::Operation) => {
            anyhow::bail!("MCP relay input parsing failed")
        }
    };
    let binding = &call["binding"];
    let worker = binding["workerId"].as_str().context("Worker identity")?;
    let Some(owner) = authenticate(service, worker, authorization).await? else {
        return Ok(failure(401, "invalid", "Unauthorized"));
    };
    let result = async {
        let result = execute_operation(service, &owner, &call).await?;
        super::agent_operations::parse("cantripAgentOperationResultSchema", &result)
    }
    .await;
    match result {
        Ok(result) => {
            let mutation = matches!(
                call["request"]["operation"].as_str(),
                Some("task.create" | "alert.raise" | "alert.resolve")
            );
            audit(
                service,
                &owner,
                binding,
                &context.id,
                if mutation {
                    "mcp.operation.mutated"
                } else {
                    "mcp.operation.executed"
                },
                "succeeded",
            )
            .await;
            Ok(json_response(StatusCode::OK, result))
        }
        Err(cause) => {
            let error = OperationError::from_cause(&cause);
            let result = if matches!(error.code, "forbidden" | "stale-binding" | "expired") {
                "denied"
            } else {
                "failed"
            };
            audit(
                service,
                &owner,
                binding,
                &context.id,
                "mcp.operation.rejected",
                result,
            )
            .await;
            Ok(error.response())
        }
    }
}

async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let authorization = middleware::value(request.headers(), "authorization");
    let raw = match body::parse_js(request, service.config.api_body_limit_bytes).await {
        Ok(value) => value,
        Err(response) => return response,
    };
    let owned = service.scratch_roots.clone();
    let on_failure = service.clone();
    let request_id = context.id.clone();
    let result = owned
        .owned(async move {
            handle_operation(&service, &context, authorization.as_deref(), raw.as_ref()).await
        })
        .await;
    result.unwrap_or_else(|error| middleware::failure(&on_failure, &request_id, &error))
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/internal/agent-operations", post(handle))
        .route(
            "/api/internal/agent-operations/capabilities",
            get(capabilities),
        )
}
