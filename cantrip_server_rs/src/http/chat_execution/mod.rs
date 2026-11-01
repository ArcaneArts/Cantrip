//! Public encrypted turn and queue routes share the production turn graph and
//! canonical queue authority. Admitted mutations survive a lost HTTP waiter.
mod changes;
mod controls;
mod queue;
mod retry;
mod steer;
mod submit;

use super::{
    body, json_response,
    middleware::{self, Context},
    settings::{error, output, parse},
};
use crate::{
    auth::service::AuthService,
    chats::{self, message_queries::MessageKind, turn_runtime::engine::Hooks},
    native_commands::{
        self, managed_queue::QueueRepository, queued_prompt::PromptRepository,
        runtime::gui_queue::GuiQueue,
    },
    operations::{
        logging::{self, LogCall},
        shared_failure::downcast_ref,
    },
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::{Context as _, Result};
use axum::{
    Extension, Router,
    body::Body,
    extract::{MatchedPath, Path, Request, State},
    http::{Method, StatusCode},
    response::Response,
    routing::{get, patch, post},
};
use std::{collections::HashMap, sync::Arc};

struct Execution {
    service: Arc<AuthService>,
    owner: String,
    chats: chats::Repository,
    prompts: PromptRepository,
    queue: QueueRepository,
    gui: GuiQueue,
    native: native_commands::Repository,
}
fn text(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("Execution identity")?
        .lossy()
        .into_owned())
}
fn message(error: &anyhow::Error) -> crate::wire::JsString {
    crate::settings::operation_error_message(error)
}
fn executing(context: &Value) -> bool {
    matches!(
        context["status"].as_str(),
        Some("running" | "waiting-for-approval")
    )
}
fn managed(context: &Value) -> bool {
    chats::managed_console::session_context(context).is_some()
}
fn empty() -> Response {
    Response::builder()
        .status(StatusCode::NO_CONTENT)
        .body(Body::empty())
        .unwrap()
}
fn object() -> Value {
    Value::object([] as [(&str, Value); 0])
}
fn copy(target: &mut Value, source: &Value, fields: &[&str]) {
    for field in fields {
        if let Some(value) = source.get(field) {
            target[*field] = value.clone();
        }
    }
}
fn configuration_failure(error: &anyhow::Error) -> Result<Option<Response>> {
    downcast_ref::<crate::settings::reasoning::ConfigurationFailure>(error)
        .map(|e| {
            output(
                if e.0["code"] == "worker-offline" {
                    503
                } else {
                    409
                },
                "modelConfigurationFailureSchema",
                &e.0,
            )
        })
        .transpose()
}
fn turn_failure(cause: &anyhow::Error, retry: bool) -> Result<Response> {
    if let Some(response) = configuration_failure(cause)? {
        return Ok(response);
    }
    if let Some(e) = downcast_ref::<native_commands::CommandError>(cause) {
        return Ok(json_response(
            StatusCode::from_u16(e.status)?,
            json!({"error":e.message,"code":e.code}),
        ));
    }
    let detail = message(cause);
    let value = detail.lossy();
    let status = if value.contains("offline") {
        503
    } else if retry
        || ["model", "Model", "Cantrip Code", "unsaved"]
            .iter()
            .any(|part| value.contains(part))
    {
        409
    } else {
        400
    };
    Ok(error(status, detail))
}
fn start_fields(message: &Value, configuration: &Value, label: &str) -> Value {
    let mut input = json!({"text":label,"attachmentIds":message["classification"]["attachmentIds"],
        "mode":message["classification"]["mode"],"idempotencyKey":message["idempotencyKey"]});
    copy(&mut input, message, &["reasoningEffort"]);
    copy(
        &mut input,
        configuration,
        &[
            "modelId",
            "customSubagentModel",
            "subagentModelId",
            "subagentReasoningEffort",
        ],
    );
    input
}
fn start_options(message: &Value) -> Value {
    json!({"encryptedChatMessages":json!({"userMessage":message,"response":json!({
        "id":uuid::Uuid::new_v4().to_string(),"idempotencyKey":format!("assistant:{}",message["id"].as_str().expect("Protected message identity"))
    })})})
}
impl Execution {
    fn new(service: Arc<AuthService>, owner: String) -> Self {
        let database = service.repository.database.clone();
        Self {
            service,
            owner,
            chats: chats::Repository::new(database.clone()),
            prompts: PromptRepository::new(database.clone()),
            queue: QueueRepository::new(database.clone()),
            gui: GuiQueue::new(database.clone()),
            native: native_commands::Repository::new(database),
        }
    }
    async fn attachments(&self, context: &Value, ids: &Value) -> Result<Value> {
        Ok(Value::Array(
            self.chats
                .prompt_attachments(&self.owner, context, ids)
                .await?
                .iter()
                .map(chats::turn_storage::attachment_summary)
                .collect(),
        ))
    }
    async fn begin(&self, context: &Value, input: &Value, options: &Value) -> Result<()> {
        self.service
            .execution
            .runtime
            .begin(&self.owner, context, input, options, Hooks::default())
            .await?;
        Ok(())
    }
    fn dispatch(&self, chat: &str) {
        // The coordinator admits and owns its dispatch before returning.
        drop(self.service.execution.recovery.dispatch(&self.owner, chat));
    }
    fn log(&self, detail: &'static str, context: Value) {
        logging::server_logger()(LogCall::event("info", detail, context));
    }
    async fn prompt_create(
        &self,
        context: &Value,
        prompt: &Value,
        attachments: &Value,
    ) -> Result<Option<Value>> {
        let chat = text(&context["chatId"])?;
        if managed(context) {
            let accepted = self
                .gui
                .mutate(
                    &self.owner,
                    context,
                    &json!({"kind":"add","prompt":prompt,"attachments":attachments}),
                    &json!({"operationId":format!("gui-queue:add:{chat}:{}",text(&prompt["id"])?)}),
                )
                .await?;
            if let Some(item) = accepted.get("acceptedItem").filter(|v| !v.is_null()) {
                return Ok(Some(item.clone()));
            }
            self.prompts
                .get_encrypted(&self.owner, &text(&prompt["id"])?)
                .await
        } else {
            self.prompts
                .create_encrypted(&self.owner, &chat, prompt, attachments)
                .await
        }
    }
}

async fn execute(
    execution: Execution,
    params: HashMap<String, String>,
    method: Method,
    input: Option<Value>,
    query: Value,
    path: String,
) -> Result<Response> {
    let input = input.as_ref();
    if let Some(project) = params.get("projectId") {
        return execution.project_pause(project, method, input).await;
    }
    if let Some(prompt) = params.get("promptId") {
        if path.ends_with("/steer") {
            return execution.steer(prompt, input).await;
        }
        return if method == Method::DELETE {
            execution.delete(prompt, &query).await
        } else {
            execution.update(prompt, input).await
        };
    }
    let chat = params.get("chatId").context("Execution route chat")?;
    if path.ends_with("/pause") {
        return execution.pause(chat, input).await;
    }
    if let Some(operation) = params.get("operationId") {
        return match execution
            .queue
            .gui_operation(&execution.owner, chat, operation)
            .await
        {
            Ok(value) => Ok(json_response(StatusCode::OK, value)),
            Err(cause) => {
                if let Some(e) = downcast_ref::<native_commands::CommandError>(&cause) {
                    Ok(json_response(
                        StatusCode::from_u16(e.status)?,
                        json!({"code":e.code}),
                    ))
                } else {
                    Err(cause)
                }
            }
        };
    }
    if path.ends_with("/retry") {
        return execution
            .retry(
                chat,
                params.get("messageId").context("Retry message")?,
                input,
            )
            .await;
    }
    if path.ends_with("/turns") {
        return execution.submit(chat, input).await;
    }
    if path.ends_with("/order") {
        return execution.reorder(chat, input).await;
    }
    if matches!(method, Method::GET | Method::HEAD) {
        execution.list(chat).await
    } else {
        execution.add(chat, input).await
    }
}
async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    Path(params): Path<HashMap<String, String>>,
    matched: MatchedPath,
    request: Request,
) -> Response {
    let (method, path, query) = (
        request.method().clone(),
        matched.as_str().to_owned(),
        super::account::query(request.uri()),
    );
    let input = if matches!(method, Method::GET | Method::HEAD) {
        None
    } else {
        match body::parse_js(request, service.config.api_body_limit_bytes).await {
            Ok(v) => v,
            Err(r) => return r,
        }
    };
    let owner = ctx
        .principal
        .user
        .as_ref()
        .expect("Authenticated execution owner")
        .id
        .clone();
    let execution = Execution::new(service.clone(), owner);
    match service
        .scratch_roots
        .owned(execute(execution, params, method, input, query, path))
        .await
    {
        Ok(response) => response,
        Err(cause) => middleware::failure(&service, &ctx.id, &cause),
    }
}
pub(super) fn routes() -> Router<Arc<AuthService>> {
    Router::new()
        .route("/api/chats/{chatId}/turns", post(handle))
        .route("/api/chats/{chatId}/pause", patch(handle))
        .route(
            "/api/projects/{projectId}/tasks/pause",
            get(handle).patch(handle),
        )
        .route("/api/chats/{chatId}/turns/{messageId}/retry", post(handle))
        .route("/api/chats/{chatId}/queue", get(handle).post(handle))
        .route("/api/chats/{chatId}/queue/order", patch(handle))
        .route(
            "/api/chats/{chatId}/queue/operations/{operationId}",
            get(handle),
        )
        .route(
            "/api/queued-prompts/{promptId}",
            patch(handle).delete(handle),
        )
        .route("/api/queued-prompts/{promptId}/steer", post(handle))
}
