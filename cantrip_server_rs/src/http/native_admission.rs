//! Native operation admission/preparation/dispatch share worker authentication.
use super::{
    body, json_response,
    middleware::{self, Context},
};
use crate::{
    auth::service::AuthService,
    native_commands::{CommandError, Repository},
    wire::{self, Value, coercion::truthy, value::json},
    workers::credentials,
};
use anyhow::Result;
use axum::{
    Extension, Router,
    extract::{Request, State},
    http::StatusCode,
    response::Response,
    routing::post,
};
use std::sync::Arc;
fn code(status: u16, key: &str) -> Response {
    json_response(StatusCode::from_u16(status).unwrap(), json!({"code":key}))
}
fn invalidation(service: &AuthService, owner: &str, scope: Value, entity: &Value) {
    let _=service.live.publish_event(json!({"ownerId":owner,"scope":scope,"resource":"chat","action":"invalidated","entityId":entity,"revision":Value::Null,"payload":Value::Null}));
}
fn authority(service: &AuthService, owner: &str, mut result: Value) -> Result<Value> {
    let receipt = &result["receipt"];
    let context = &result["execution"];
    let value = if matches!(receipt["status"].as_str(), Some("accepted" | "dispatched"))
        && truthy(context.get("computerUseEnabled"))
        && truthy(receipt.get("executionLaneId"))
    {
        let mut authority =
            crate::chats::computer_use_authority::preview(owner, &service.server_id, context)?;
        authority["executionLaneId"] = receipt["executionLaneId"].clone();
        authority
    } else {
        Value::Null
    };
    result["computerUseAuthority"] = value;
    Ok(result)
}
async fn apply(
    service: Arc<AuthService>,
    owner: String,
    input: Value,
    phase: String,
) -> Result<Value> {
    if phase == "inference-resource-authorize" {
        let worker = input["workerId"].as_str().unwrap();
        let current = || {
            service.server_id.as_str() == input["serverId"].as_str().unwrap()
                && input["ownerId"] == owner.as_str()
                && service
                    .workers
                    .bridge
                    .connection_identity(worker)
                    .is_some_and(|identity| {
                        identity.owner == owner
                            && Some(identity.process_generation.as_str())
                                == input["workerGeneration"].as_str()
                    })
        };
        // The bound process identity survives reconnect grace. Availability and
        // provider catalogs are not authority for this actual resource lookup.
        if !current() {
            return Err(CommandError::new("stale-worker-generation", None, 409).into());
        }
        let result = Repository::new(service.repository.database.clone())
            .authorize_inference_resource(&owner, &input)
            .await?;
        if !current() {
            return Err(CommandError::new("stale-worker-generation", None, 409).into());
        }
        return crate::settings::parse_response(
            "nativeInferenceResourceAuthorizationResultSchema",
            Some(&result),
        );
    }
    if phase == "task-goal-outcome" {
        if input["serverId"].as_str() != Some(service.server_id.as_str())
            || input["ownerId"].as_str() != Some(owner.as_str())
        {
            return Err(CommandError::new("stale-outcome-scope", None, 409).into());
        }
        let note = &input["notification"];
        if note["taskInferenceInputOperationId"].as_str().is_none()
            || note["taskDispatchFence"].as_object().is_none()
        {
            return Err(CommandError::new("invalid-task-goal-outcome", None, 400).into());
        }
        // Captured facts can outlive a worker generation. The transaction
        // validates exact original input authority, not current observer liveness.
        let tasks = crate::tasks::Repository::new(service.repository.database.clone());
        let captured = if input["inputKind"] == "round" {
            tasks
                .deliver_round_outcome(&owner, input["workerId"].as_str().unwrap(), note)
                .await
        } else {
            tasks
                .apply_goal_input_outcome(&owner, input["workerId"].as_str().unwrap(), note, true)
                .await
        };
        let (captured, conflict) = match captured {
            Ok(result) => (result, None),
            Err(error) if error.is::<crate::task_dispatch::Conflict>() => (None, Some(error)),
            Err(error) => return Err(error),
        };
        let committed = captured.is_some();
        let retired = if committed {
            None
        } else if input["inputKind"] == "round" {
            tasks
                .round_outcome_retirement(&owner, input["workerId"].as_str().unwrap(), note)
                .await?
        } else {
            tasks
                .goal_outcome_retirement(&owner, note, input["workerId"].as_str().unwrap())
                .await?
        };
        if retired.is_none()
            && let Some(error) = conflict
        {
            return Err(error);
        }
        if let Some(captured) = &captured
            && !captured["message"].is_null()
        {
            service
                .execution
                .publish_task_outcome_message(&owner, &captured["message"], &captured["chat"])
                .await;
        }
        if committed {
            service
                .execution
                .receive_committed_outcome(
                    owner.clone(),
                    input["workerId"].as_str().unwrap().to_owned(),
                    Arc::new(note.clone()),
                )
                .await;
        }
        let mut receipt = json!({"deliveryId":input["deliveryId"],"taskInferenceInputOperationId":note["taskInferenceInputOperationId"],"committed":committed});
        if let Some(reason) = retired {
            receipt["retiredReason"] = json!(reason);
        }
        return crate::settings::parse_response("taskGoalOutcomeCommitSchema", Some(&receipt));
    }
    if phase == "inference-recovery" || phase == "task-input-dispatch" {
        let worker = input["workerId"].as_str().unwrap();
        let current = || {
            service.server_id.as_str() == input["serverId"].as_str().unwrap()
                && service
                    .workers
                    .bridge
                    .connection_identity(worker)
                    .is_some_and(|identity| {
                        identity.owner == owner
                            && Some(identity.process_generation.as_str())
                                == input["workerGeneration"].as_str()
                    })
                && service.workers.bridge.is_connected(worker)
        };
        if !current() {
            return Err(CommandError::new("stale-worker-generation", None, 409).into());
        }
        let repo = Repository::new(service.repository.database.clone());
        let result = if phase == "task-input-dispatch" {
            crate::tasks::Repository::new(service.repository.database.clone())
                .dispatch_inference_input(
                    &owner,
                    worker,
                    &input["receipt"],
                    input["phase"].as_str().unwrap(),
                )
                .await?
        } else if input["record"]["identity"]["recovery"]
            .get("taskInput")
            .is_some_and(|v| !v.is_null())
        {
            crate::tasks::Repository::new(service.repository.database.clone())
                .reconcile_inference_input(&owner, &input)
                .await?
        } else {
            repo.reconcile_inference(&owner, &input).await?
        };
        if !current() {
            return Err(CommandError::new("stale-worker-generation", None, 409).into());
        }
        if truthy(result.get("chatId")) && result["disposition"] != "unresolved" {
            invalidation(
                &service,
                &owner,
                json!({"kind":"chat","chatId":result["chatId"]}),
                &Value::Null,
            );
            if result["disposition"] == "requeued"
                && input["record"]["identity"]["recovery"]
                    .get("taskInput")
                    .is_some_and(|v| !v.is_null())
            {
                service.execution.scheduler.queue_tick();
            }
        }
        return crate::settings::parse_response(
            if phase == "task-input-dispatch" {
                "taskInferenceInputDispatchResultSchema"
            } else {
                "nativeInferenceRecoveryResultSchema"
            },
            Some(&result),
        );
    }
    if phase == "receipt" {
        return service.execution.receipts.settle(&owner, &input).await;
    }
    let repo = Repository::new(service.repository.database.clone());
    if phase == "continue" {
        return authority(
            &service,
            &owner,
            repo.continue_execution(&owner, &input).await?,
        );
    }
    if phase == "settings-evidence" {
        let result = repo.record_settings_evidence(&owner, &input).await?;
        let worker = input["workerId"]
            .as_js_string()
            .unwrap()
            .lossy()
            .into_owned();
        let operation = input["operationId"]
            .as_js_string()
            .unwrap()
            .lossy()
            .into_owned();
        if let Some(receipt) = repo.lookup(&owner, &worker, &operation).await? {
            invalidation(
                &service,
                &owner,
                json!({"kind":"chat","chatId":receipt["chatId"]}),
                &Value::Null,
            );
        }
        return Ok(result);
    }
    if phase == "bind-preparation" {
        return Ok(json!({"receipt":repo.bind_preparation(&owner,&input).await?}));
    }
    let result = if phase == "admit" {
        repo.admit(&owner, &input, &Value::Null).await?
    } else {
        repo.dispatch(&owner, &input).await?
    };
    if phase == "admit" && truthy(result.get("execution")) {
        let execution = &result["execution"];
        let scope = if truthy(execution.get("projectId")) {
            json!({"kind":"project","projectId":execution["projectId"]})
        } else {
            json!({"kind":"current-user"})
        };
        invalidation(&service, &owner, scope, &execution["chatId"]);
    }
    if result["receipt"]["method"] == "thread/settings/update" {
        let chat = &result["receipt"]["chatId"];
        invalidation(
            &service,
            &owner,
            json!({"kind":"chat","chatId":chat}),
            &Value::Null,
        );
    }
    authority(&service, &owner, result)
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let phase = request.uri().path().rsplit('/').next().unwrap().to_owned();
    let authorization = middleware::value(request.headers(), "authorization");
    // Match TASK_GOAL_OUTCOME_MAX_BYTES: protected 16 MiB responses expand in base64.
    let limit = if phase == "task-goal-outcome" {
        32 * 1_024 * 1_024
    } else {
        service.config.api_body_limit_bytes
    };
    let body = match body::parse_js(request, limit).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    let input = match wire::parse(
        match phase.as_str() {
            "admit" => "nativeCommandAdmissionSchema",
            "continue" => "nativeCommandContinuationSchema",
            "settings-evidence" => "nativeSettingsEvidenceSchema",
            "receipt" => "nativeCommandSettlementSchema",
            "inference-recovery" => "nativeInferenceRecoverySchema",
            "inference-resource-authorize" => "nativeInferenceResourceAuthorizationSchema",
            "task-input-dispatch" => "taskInferenceInputDispatchSchema",
            "task-goal-outcome" => "taskGoalOutcomeDeliverySchema",
            _ => "nativeCommandDispatchSchema",
        },
        body.as_ref(),
    ) {
        Ok(v) => v,
        Err(_) => {
            return code(
                400,
                match phase.as_str() {
                    "task-input-dispatch" => "invalid-task-input-dispatch",
                    "task-goal-outcome" => "invalid-task-goal-outcome",
                    "inference-recovery" => "invalid-inference-recovery",
                    "inference-resource-authorize" => "invalid-inference-resource",
                    _ => "invalid-native-command",
                },
            );
        }
    };
    let worker = input["workerId"]
        .as_js_string()
        .unwrap()
        .lossy()
        .into_owned();
    let authentication = match credentials::authenticate(
        &service.workers.repository,
        &service.config,
        authorization.as_deref(),
        &worker,
        "worker:agent-tools",
    )
    .await
    {
        Ok(Some(a)) => a,
        Ok(None) => return code(401, "unauthorized"),
        Err(cause) => return middleware::failure(&service, &ctx.id, &cause),
    };
    let owner = authentication.credential.owner_id;
    match service.workers.repository.get_worker(&owner, &worker).await {
        Ok(Some(_)) => {}
        Ok(None) => return code(404, "worker-not-found"),
        Err(cause) => return middleware::failure(&service, &ctx.id, &cause),
    };
    match service
        .scratch_roots
        .owned(apply(service.clone(), owner, input, phase))
        .await
    {
        Ok(v) => json_response(StatusCode::OK, v),
        Err(cause) => {
            if let Some(e) = cause.downcast_ref::<CommandError>() {
                code(e.status, &e.code)
            } else if cause.is::<crate::task_dispatch::Conflict>() {
                code(409, "stale-task-input")
            } else {
                middleware::failure(&service, &ctx.id, &cause)
            }
        }
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/internal/native-commands/admit", post(handle))
        .route("/api/internal/native-commands/dispatch", post(handle))
        .route("/api/internal/native-commands/continue", post(handle))
        .route("/api/internal/native-commands/receipt", post(handle))
        .route(
            "/api/internal/native-commands/inference-resource-authorize",
            post(handle),
        )
        .route(
            "/api/internal/native-commands/task-input-dispatch",
            post(handle),
        )
        .route(
            "/api/internal/native-commands/task-goal-outcome",
            post(handle),
        )
        .route(
            "/api/internal/native-commands/inference-recovery",
            post(handle),
        )
        .route(
            "/api/internal/native-commands/settings-evidence",
            post(handle),
        )
        .route(
            "/api/internal/native-commands/bind-preparation",
            post(handle),
        )
}
