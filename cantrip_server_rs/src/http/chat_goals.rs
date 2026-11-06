//! Public Goal controls use the same runtime, lease and encrypted Task services
//! as background execution. Worker-owned objectives remain on the worker.
use super::{
    body,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    chats::{
        self,
        goals::{self, Observation},
        managed_console,
        turn_runtime::engine::Hooks,
    },
    tasks,
    wire::{Value, coercion::truthy, value::json},
    workers::command_bus::RequestTimeout,
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    extract::{Path, Request, State},
    http::Method,
    response::Response,
    routing::get,
};
use std::sync::Arc;

fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Goal identity")?
        .lossy()
        .into_owned())
}
fn executing(context: &Value) -> bool {
    matches!(
        context["status"].as_str(),
        Some("running" | "waiting-for-approval")
    )
}
async fn request(
    service: &AuthService,
    context: &Value,
    command: Value,
    schema: &str,
) -> Result<Value> {
    let reply = service
        .workers
        .commands
        .request_with_timeout(
            &text(&context["workerId"])?,
            command,
            RequestTimeout::Default,
            None,
        )
        .await?;
    crate::settings::parse_response(schema, reply.as_ref())
}
fn command(context: &Value, runtime: &Value, kind: &str) -> Value {
    json!({"type":kind,"chatId":context["chatId"],"cwd":context["cwd"],"threadId":context["threadId"],"model":runtime["model"],"provider":runtime["provider"],"permissionProfileId":managed_console::permission_profile(context)["effectiveId"]})
}
async fn managed(
    service: &AuthService,
    owner: &str,
    context: &Value,
    runtime: &Value,
    command: &mut Value,
) -> Result<bool> {
    if managed_console::session_context(context).is_none() {
        return Ok(false);
    }
    let prepared = service
        .managed_console
        .prepare_launch(owner, context, runtime)
        .await?;
    for key in ["session", "subagentDefaults", "mcpServers", "planMode"] {
        if let Some(value) = prepared.get(key) {
            command[key] = value.clone();
        }
    }
    Ok(true)
}

async fn read(
    service: &AuthService,
    owner: &str,
    context: &Value,
    encrypted: bool,
) -> Result<Response> {
    if !truthy(context.get("threadId")) {
        return output(
            200,
            "chatGoalWireResponseSchema",
            &if context["experience"] == "task" {
                json!({"kind":"task-encrypted","goal":Value::Null})
            } else {
                json!({"goal":Value::Null})
            },
        );
    }
    if !service
        .workers
        .bridge
        .is_connected(&text(&context["workerId"])?)
    {
        return Ok(error(503, "Project worker is offline."));
    }
    let task = context["experience"] == "task";
    let result: Result<Response> = async {
        if task {
            let Some(source) = tasks::Repository::new(service.repository.database.clone())
                .get(owner, &text(&context["chatId"])?)
                .await?
            else {
                return Ok(error(404, "Task not found."));
            };
            let observed = service
                .execution
                .goals
                .read(owner, context, &source, Observation::default())
                .await?;
            return output(
                200,
                "chatGoalWireResponseSchema",
                &json!({"kind":"task-encrypted","goal":observed["goal"]}),
            );
        }
        let runtime = if context["contextKind"] == "project" && truthy(context.get("modelRouteId"))
        {
            Some(
                service
                    .model_routing
                    .bound_managed_runtime(owner, context)
                    .await?,
            )
        } else {
            service
                .model_routing
                .runtime_for_context(owner, context)
                .await?
        };
        let Some(runtime) = runtime else {
            return Ok(error(409, "Selected model was not found."));
        };
        let mut command = command(context, &runtime, "chat.goal.get");
        command["protectObjective"] = json!(encrypted);
        let response = request(service, context, command, "chatGoalWireResponseSchema").await?;
        output(200, "chatGoalWireResponseSchema", &response)
    }
    .await;
    match result {
        Ok(response) => Ok(response),
        Err(cause) => Ok(error(
            409,
            if task {
                "Encrypted Goal status is unavailable.".into()
            } else {
                crate::settings::operation_error_message(&cause)
            },
        )),
    }
}

async fn update_task(
    service: &AuthService,
    owner: &str,
    context: &Value,
    runtime: &Value,
    input: &Value,
) -> Result<Response> {
    let chat = text(&context["chatId"])?;
    let repository = tasks::Repository::new(service.repository.database.clone());
    let Some(task) = repository.get(owner, &chat).await? else {
        return Ok(error(404, "Task not found."));
    };
    let message = if input["status"] == "active"
        && !truthy(context.get("automationPaused"))
        && !executing(context)
    {
        json!({"id":uuid::Uuid::new_v4().to_string(),"idempotencyKey":format!("task-goal-resume:{}",uuid::Uuid::new_v4()),"kind":"resume"})
    } else {
        Value::Null
    };
    let mut command = command(context, runtime, "chat.goal.update");
    for key in ["status", "protectedObjective"] {
        if let Some(value) = input.get(key) {
            command[key] = value.clone();
        }
    }
    command["taskContext"] = json!({"task":goals::content_from_summary(&task),"automationPaused":context["automationPaused"],"chatStatus":context["status"],"message":message});
    if let Some(cycle) = goals::native_cycle_from_summary(&task) {
        command["taskContext"]["nativeCycle"] = cycle;
    }
    let response = request(service, context, command, "taskGoalWorkerResultSchema").await?;
    anyhow::ensure!(
        response["goal"]["chatId"] == context["chatId"]
            && (!truthy(Some(&message))
                || (response["message"]["id"] == message["id"]
                    && response["message"]["idempotencyKey"] == message["idempotencyKey"])),
        "Encrypted Goal metadata is invalid."
    );
    let synchronized = repository
        .sync_implementation_state(
            owner,
            &chat,
            &json!({"rowVersion":task["rowVersion"],"task":response["task"]}),
        )
        .await?;
    service
        .execution
        .goals
        .reconcile(
            owner,
            &task,
            &synchronized.as_ref().unwrap_or(&task)["state"],
        )
        .await?;
    if response["goal"]["status"] == "active" && truthy(response.get("message")) {
        let lease = goals::goal_dispatch_lease(&task)?;
        if let Some(lease) = &lease {
            service.execution.goals.retain(lease).await?;
        }
        let configuration = &task["dispatch"]["modelConfiguration"];
        let model = match configuration.get("modelId").filter(|v| !v.is_null()) {
            Some(model) => model.clone(),
            None => {
                service
                    .model_routing
                    .resolve_model_id(owner, context, None)
                    .await?
            }
        };
        let mut turn = json!({"text":"Resume the active encrypted Task Goal.","mode":"goal","modelId":model,"idempotencyKey":response["message"]["idempotencyKey"]});
        for key in [
            "reasoningEffort",
            "customSubagentModel",
            "subagentModelId",
            "subagentReasoningEffort",
        ] {
            if let Some(value) = configuration.get(key) {
                turn[key] = value.clone();
            }
        }
        let mut options = json!({"encryptedTaskMessages":json!({"userMessage":response["message"],"response":json!({"id":uuid::Uuid::new_v4().to_string(),"idempotencyKey":format!("assistant:{}",text(&response["message"]["id"])?) })}),"purpose":"Resume encrypted Task Goal","runtimes":vec![runtime.clone()],"workerPrompt":goals::RESUME_PROMPT});
        let hooks = if let Some(lease) = lease {
            options["taskDispatchLease"] = lease.clone();
            service.execution.goals.scheduled_hooks(owner, &lease)
        } else {
            Hooks::default()
        };
        service
            .execution
            .runtime
            .begin(owner, context, &turn, &options, hooks)
            .await?;
    }
    output(
        200,
        "chatGoalWireResponseSchema",
        &json!({"kind":"task-encrypted","goal":response["goal"]}),
    )
}

async fn change(
    service: &AuthService,
    owner: &str,
    context: &Value,
    input: Option<&Value>,
    encrypted: bool,
) -> Result<Response> {
    if !truthy(context.get("threadId")) {
        return if input.is_some() {
            Ok(error(409, "This chat has no goal."))
        } else {
            output(200, "chatGoalClearSchema", &json!({"cleared":false}))
        };
    }
    if !service
        .workers
        .bridge
        .is_connected(&text(&context["workerId"])?)
    {
        return Ok(error(503, "Project worker is offline."));
    }
    let result: Result<Response> = async {
        let runtime = service.model_routing.runtime_for_context(owner, context).await?.context("Selected model was not found.")?;
        if let Some(input) = input && context["experience"] == "task" {
            return update_task(service, owner, context, &runtime, input).await;
        }
        let mut command = command(context, &runtime, if input.is_some() {"chat.goal.update"} else {"chat.goal.clear"});
        let managed = managed(service, owner, context, &runtime, &mut command).await?;
        if let Some(input) = input {
            command["protectObjective"] = json!(encrypted || truthy(input.get("protectedObjective")));
            for key in ["status","protectedObjective"] { if let Some(value) = input.get(key) { command[key] = value.clone(); } }
        }
        let schema = if input.is_some() {"chatGoalWireResponseSchema"} else {"chatGoalClearSchema"};
        let response = request(service, context, command, schema).await?;
        if !managed && input.is_some_and(|input| input["status"] == "active") && !truthy(context.get("automationPaused")) && !executing(context) && truthy(response.get("goal")) {
            let model = service.model_routing.resolve_model_id(owner, context, None).await?;
            let updated = crate::wire::coercion::string(&response["goal"]["updatedAt"]).map_err(|()| anyhow::anyhow!("Goal update time cannot be converted to text"))?;
            service.execution.runtime.begin(owner, context, &json!({"text":"Resume the existing goal.","mode":"goal","modelId":model,"idempotencyKey":format!("goal-resume:{}:{}",updated.lossy(),uuid::Uuid::new_v4())}), &json!({"purpose":"Resume Codex goal","runtimes":vec![runtime],"workerPrompt":goals::RESUME_PROMPT}), Hooks::default()).await?;
        }
        output(200, schema, &response)
    }.await;
    match result {
        Ok(response) => Ok(response),
        Err(cause) => Ok(error(
            409,
            if context["experience"] == "task" {
                if input.is_some() {
                    "Encrypted Goal update failed.".into()
                } else {
                    "Encrypted Goal removal failed.".into()
                }
            } else {
                crate::settings::operation_error_message(&cause)
            },
        )),
    }
}

async fn execute(
    service: Arc<AuthService>,
    owner: String,
    chat: String,
    method: Method,
    input: Option<Value>,
    encrypted: bool,
) -> Result<Response> {
    if !matches!(method, Method::GET | Method::HEAD | Method::POST) {
        let handoffs = crate::native_handoffs::Repository::new(service.repository.database.clone());
        if let Err(cause) = crate::native_handoffs::service::settle_task_control(
            &handoffs,
            &service.workers.commands,
            &owner,
            &chat,
        )
        .await
        {
            return Ok(error(409, crate::settings::operation_error_message(&cause)));
        }
    }
    let Some(context) = chats::Repository::new(service.repository.database.clone())
        .execution_context(&owner, &chat)
        .await?
    else {
        return Ok(error(404, "Chat source not found."));
    };
    if matches!(method, Method::GET | Method::HEAD) {
        return read(&service, &owner, &context, encrypted).await;
    }
    if method != Method::POST {
        return change(&service, &owner, &context, input.as_ref(), encrypted).await;
    }
    if context["experience"] == "task" {
        return Ok(error(
            409,
            "Task Goals are created by encrypted Task finalization.",
        ));
    }
    if executing(&context) {
        return Ok(error(409, "Wait for the active turn to finish."));
    }
    if truthy(context.get("automationPaused")) {
        return Ok(error(409, "Resume this chat before starting a goal."));
    }
    if !service
        .workers
        .bridge
        .is_connected(&text(&context["workerId"])?)
    {
        return Ok(error(503, "Project worker is offline."));
    }
    let input = input.context("Parsed Goal creation")?;
    let started: Result<Response> = async {
        let started = service.execution.goals.start_goal(&owner, &context, &json!({"attachmentIds":Value::Array(Vec::new()),"text":input["objective"],"mode":"goal","idempotencyKey":format!("goal:{}",uuid::Uuid::new_v4())}), &json!({"tokenBudget":input.get("tokenBudget").unwrap_or(&Value::Null)})).await?;
        output(202, "chatGoalWireResponseSchema", &started["goal"])
    }.await;
    match started {
        Ok(response) => Ok(response),
        Err(cause) => Ok(error(409, crate::settings::operation_error_message(&cause))),
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(context): Extension<Arc<Context>>,
    Path(chat): Path<String>,
    request: Request,
) -> Response {
    let result: Result<Response> = async {
        let owner = context
            .principal
            .user
            .as_ref()
            .context("Authenticated Goal owner")?
            .id
            .clone();
        let method = request.method().clone();
        let encrypted = super::account::query(request.uri())["encrypted"] == "1";
        let input = if matches!(method, Method::GET | Method::HEAD) {
            None
        } else {
            let body = match body::parse_js(request, service.config.api_body_limit_bytes).await {
                Ok(body) => body,
                Err(response) => return Ok(response),
            };
            if method == Method::POST || method == Method::PATCH {
                match parse(
                    if method == Method::POST {
                        "chatGoalCreateSchema"
                    } else {
                        "chatGoalUpdateSchema"
                    },
                    body.as_ref(),
                )? {
                    Ok(input) => Some(input),
                    Err(response) => return Ok(response),
                }
            } else {
                None
            }
        };
        service
            .scratch_roots
            .owned(execute(
                service.clone(),
                owner,
                chat,
                method,
                input,
                encrypted,
            ))
            .await
    }
    .await;
    match result {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &context.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new().route(
        "/api/chats/{chatId}/goal",
        get(handle).post(handle).patch(handle).delete(handle),
    )
}
