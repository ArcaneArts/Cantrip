//! Worker queue requests share the durable GUI/native queue authority and the
//! production execution graph's receipt notifications and owned dispatcher.
use super::{
    body, json_response,
    middleware::{self, Context},
};
use crate::{
    auth::service::AuthService,
    native_commands::{CommandError, managed_queue::QueueRepository},
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
use std::{sync::Arc, time::Duration};
use tokio::{sync::watch, task::AbortHandle};

fn code(status: u16, key: &str) -> Response {
    json_response(StatusCode::from_u16(status).unwrap(), json!({"code":key}))
}

type Abort = watch::Sender<Option<Arc<str>>>;
fn abort(sender: &Abort, reason: &'static str) {
    sender.send_if_modified(|state| {
        if state.is_some() {
            return false;
        }
        *state = Some(Arc::from(reason));
        true
    });
}
struct View(Abort);
impl Drop for View {
    fn drop(&mut self) {
        abort(&self.0, "The queue receipt view disconnected.");
    }
}
struct Deadline(AbortHandle);
impl Drop for Deadline {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn receipt(service: Arc<AuthService>, owner: String, input: Value) -> Result<Value> {
    let (controller, signal) = watch::channel(None);
    let _view = View(controller.clone());
    let expires = tokio::time::Instant::now() + Duration::from_secs(90);
    let deadline = Deadline(
        tokio::spawn(async move {
            tokio::time::sleep_until(expires).await;
            abort(&controller, "The queued action is still pending.");
        })
        .abort_handle(),
    );
    let read_service = service.clone();
    service
        .scratch_roots
        .owned(async move {
            let _deadline = deadline;
            let queue = QueueRepository::new(read_service.repository.database.clone());
            let result = read_service
                .execution
                .receipt_notifications
                .wait_for_receipt(
                    &queue,
                    &owner,
                    &input["workerId"],
                    &input["session"],
                    input["claimId"].as_str().expect("Validated queue claim"),
                    signal,
                )
                .await?;
            crate::settings::parse_response("managedQueueStartReceiptResultSchema", Some(&result))
        })
        .await
}

async fn apply(
    service: Arc<AuthService>,
    owner: String,
    action: &str,
    input: Value,
) -> Result<Value> {
    let queue = QueueRepository::new(service.repository.database.clone());
    match action {
        "lookup" => queue.lookup(&owner, &input["admission"]).await,
        "read" => {
            queue
                .read(&owner, &input["workerId"], &input["session"])
                .await
        }
        "import" => queue.import_native(&owner, &input).await,
        "import-ack" => {
            let result = queue.acknowledge_import(&owner, &input).await?;
            let chat = input["session"]["chatId"]
                .as_str()
                .expect("Validated queue Chat");
            service
                .chat_mutations
                .publish_invalidation(&owner, chat, "chat-queue", None);
            if truthy(input["receipt"].get("deleted")) && !truthy(input["receipt"].get("conflict"))
            {
                drop(service.execution.recovery.dispatch(&owner, chat));
            }
            Ok(result)
        }
        "mutate" => {
            let result = queue
                .mutate(&owner, &input, &Value::object([] as [(&str, Value); 0]))
                .await?;
            let chat = input["admission"]["session"]["chatId"]
                .as_js_string()
                .expect("Validated queue Chat");
            service
                .chat_mutations
                .publish_invalidation(&owner, &chat.lossy(), "chat-queue", None);
            service.execution.receipt_notifications.notify(chat);
            if result["receipt"]["status"] == "applied"
                && matches!(
                    input["mutation"]["kind"].as_str(),
                    Some("add" | "update" | "start")
                )
            {
                drop(service.execution.recovery.dispatch(&owner, &chat.lossy()));
            }
            Ok(result)
        }
        _ => unreachable!("Registered native queue action"),
    }
}

async fn handle(
    State(service): State<Arc<AuthService>>,
    Extension(ctx): Extension<Arc<Context>>,
    request: Request,
) -> Response {
    let action = request.uri().path().rsplit('/').next().unwrap().to_owned();
    let schema = match action.as_str() {
        "lookup" => "managedQueueLookupSchema",
        "read" => "managedQueueReadSchema",
        "mutate" => "managedQueueMutateSchema",
        "import" => "managedQueueImportSchema",
        "import-ack" => "managedQueueImportAckSchema",
        "start-receipt" => "managedQueueStartReceiptSchema",
        _ => unreachable!("Registered native queue action"),
    };
    let authorization = middleware::value(request.headers(), "authorization");
    let binary = middleware::value(request.headers(), "content-type").is_some_and(|value| {
        value
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("application/octet-stream")
    });
    // The registered Buffer parser reads binary input under its upload limit.
    // A Buffer supplies neither workerId nor admission, so every queue schema
    // rejects it with the same fixed validation code after parsing succeeds.
    let parsed = if binary {
        body::parse_ignored(
            request,
            service.config.api_body_limit_bytes,
            (service.config.upload_limit_bytes * 3).div_ceil(2) + 1024 * 1024,
        )
        .await
        .map(|()| None)
    } else {
        body::parse_js(request, service.config.api_body_limit_bytes).await
    };
    let body = match parsed {
        Ok(value) => value,
        Err(response) => return response,
    };
    let input = match wire::parse(schema, body.as_ref()) {
        Ok(value) => value,
        Err(_) => return code(400, "invalid-queue-request"),
    };
    let worker = if input.get("admission").is_some() {
        &input["admission"]["workerId"]
    } else {
        &input["workerId"]
    };
    let authentication = match credentials::authenticate(
        &service.workers.repository,
        &service.config,
        authorization.as_deref(),
        &worker.as_js_string().unwrap().lossy(),
        "worker:agent-tools",
    )
    .await
    {
        Ok(Some(value)) => value,
        Ok(None) => return code(401, "unauthorized"),
        Err(cause) => return middleware::failure(&service, &ctx.id, &cause),
    };
    let owner = authentication.credential.owner_id;
    let is_receipt = action == "start-receipt";
    // Source returns these promises without awaiting them inside its try block;
    // their rejections reach Fastify's default error handler.
    let default_errors = matches!(action.as_str(), "lookup" | "read" | "import");
    let result = if is_receipt {
        receipt(service.clone(), owner, input).await
    } else {
        let apply_service = service.clone();
        service
            .scratch_roots
            .owned(async move { apply(apply_service, owner, &action, input).await })
            .await
    };
    match result {
        Ok(value) => json_response(StatusCode::OK, value),
        Err(cause) => {
            if let Some(error) = cause.downcast_ref::<CommandError>() {
                if default_errors {
                    let status = StatusCode::from_u16(error.status).unwrap();
                    json_response(
                        status,
                        json!({"statusCode":error.status,"code":error.code,"error":status.canonical_reason().unwrap_or("Error"),"message":error.message}),
                    )
                } else {
                    code(error.status, &error.code)
                }
            } else if is_receipt {
                code(409, "queue-receipt-pending")
            } else {
                middleware::failure(&service, &ctx.id, &cause)
            }
        }
    }
}

pub(super) fn routes() -> Router<Arc<AuthService>> {
    [
        "lookup",
        "read",
        "mutate",
        "start-receipt",
        "import",
        "import-ack",
    ]
    .into_iter()
    .fold(Router::new(), |router, action| {
        router.route(
            &format!("/api/internal/native-queue/{action}"),
            post(handle),
        )
    })
}
