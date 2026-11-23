use super::*;
use crate::{
    computer_use::Activity,
    operations::logging::{self, LogCall},
};
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) async fn open(
    service: &Arc<AuthService>,
    owner: &str,
    chat: &str,
    input: Option<Value>,
) -> Result<Response> {
    let value = input
        .filter(|v| !v.is_null())
        .unwrap_or_else(|| Value::object(std::iter::empty::<(&str, Value)>()));
    if !value.as_object().is_some_and(|fields| fields.is_empty()) {
        return Ok(error(400, "Invalid computer-use preview request."));
    }
    let result: Result<Response> = async {
        let context = Repository::new(service.repository.database.clone()).execution_context(owner, chat).await?;
        let Some(context) = context else { return Ok(error(404, "Chat not found.")); };
        if context["computerUseEnabled"] != true { return Ok(error(403, "Computer use is not enabled.")); }
        let authority = computer_use_authority::preview(owner, &service.server_id, &context)?;
        let domain = if context["experience"] == "task" { "task" } else { "chat" };
        let raw = service.workers.commands.request(text(&context["workerId"])?, json!({"type":"computer-use.preview.open","authority":authority,"contentDomain":domain}), Some(Duration::from_secs(30)), None).await?;
        let lease = crate::settings::parse_response("cuaPreviewLeaseSchema", raw.as_ref())?;
        ensure!(lease["workerId"] == authority["workerId"] && lease["chatId"] == authority["chatId"] && lease["contentDomain"] == domain && lease["generation"] == authority["generation"], "Invalid preview lease.");
        Ok(super::super::json_response(StatusCode::OK, lease))
    }.await;
    Ok(result.unwrap_or_else(|cause| {
        error(
            if unavailable(&cause) { 503 } else { 502 },
            "Computer-use preview could not be opened.",
        )
    }))
}
pub(super) async fn stop(
    service: &Arc<AuthService>,
    owner: &str,
    chat: &str,
    input: Option<Value>,
) -> Result<Response> {
    let input = match wire::parse("cuaPreviewStopSchema", input.as_ref()) {
        Ok(value) => value,
        Err(_) => return Ok(error(400, "Invalid computer-use Stop request.")),
    };
    let result: Result<Response> = async {
        let worker_id = input["workerId"].as_js_string().expect("Validated Stop worker").lossy();
        let worker = service.workers.repository.get_worker(owner, &worker_id).await?;
        let Some(worker) = worker else { return Ok(error(404, "Worker not found.")); };
        let operation = uuid::Uuid::new_v4().to_string();
        let activity = Arc::new(Activity::new(service.computer_use.clone(), owner.into(), chat.into(), operation.clone(), None));
        let audit_failed = Arc::new(AtomicBool::new(false));
        let failed = audit_failed.clone();
        let event: EventHandler = Arc::new(move |event| {
            let (activity, failed) = (activity.clone(), failed.clone());
            async move { if activity.publish(&event).await.is_err() { failed.store(true, Ordering::Release); } Ok(()) }.boxed()
        });
        let raw = service.workers.commands.request(worker["workerId"].as_str().expect("Worker identity"), json!({"type":"computer-use.preview.stop","operationId":operation,"ownerId":owner,"serverId":service.server_id,"chatId":chat,"leaseId":input["leaseId"]}), Some(Duration::from_secs(30)), Some(event)).await?;
        let closed = crate::settings::parse_response("cuaPreviewStoppedSchema", raw.as_ref())?;
        if audit_failed.load(Ordering::Acquire) || closed["activityPublicationFailed"] == true {
            logging::server_logger()(LogCall::event("warn", "Computer-use Stop completed without a durable activity.", json!({"event":"computer-use.activity.publication-failed"})));
        }
        Ok(super::super::json_response(StatusCode::OK, json!({"closed":true})))
    }.await;
    Ok(result.unwrap_or_else(|cause| {
        error(
            if unavailable(&cause) { 503 } else { 409 },
            "Computer-use preview could not be stopped.",
        )
    }))
}
