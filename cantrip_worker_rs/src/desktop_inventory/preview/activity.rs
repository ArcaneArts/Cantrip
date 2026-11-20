//! Publish the preview's terminal operation as an opaque trajectory message.
use super::{
    Lease,
    native::{Rejected, ResultData, activity_session},
};
use crate::{chat_content::Scope, encryption::Service, http::checked, task_content};
use anyhow::{Context, Result, ensure};
use cantrip_protocol::history::event_id;
use cantrip_wire::{Value, value::json};
use std::sync::Arc;

pub(super) struct Audit {
    started_at: i64,
    pub(super) before: Value,
    target: Value,
    session: Value,
    image: Value,
    error: Option<String>,
}

impl Audit {
    pub(super) fn new(started_at: i64) -> Self {
        Self {
            started_at,
            before: Value::Null,
            target: Value::Null,
            session: Value::Null,
            image: Value::Null,
            error: None,
        }
    }

    pub(super) fn action(&mut self, lease: &Lease, action: &Value) {
        if let Some(session) = action.get("sessionId") {
            self.before = activity_session(lease, Some(session));
        }
        if let Some(target) = action.get("targetId") {
            self.target = json!({"targetId":target,"targetGeneration":action["targetGeneration"]});
        }
    }

    pub(super) fn result(&mut self, result: &Result<ResultData>) {
        match result {
            Ok(result) => {
                self.session = result.data["session"].clone();
                self.image = result.data["image"].clone();
            }
            Err(error) => {
                self.error = Some(
                    error
                        .downcast_ref::<Rejected>()
                        .map_or_else(|| "operation-failed".to_owned(), |error| error.code.clone()),
                );
            }
        }
    }

    pub(super) fn event(
        self,
        encryption: &Arc<Service>,
        lease: &Lease,
        operation: &Value,
        operation_id: &Value,
        delivery_failed: bool,
    ) -> Result<Value> {
        let is_task = lease.domain == "task";
        let chat = &lease.authority["chatId"];
        let activity = self.build(lease, operation, operation_id, delivery_failed, is_task)?;
        let activity_id = activity["id"].as_str().context("Missing activity ID.")?;
        let part = json!({"type":"activity","activity":activity});
        let (kind, message) = if is_task {
            let grant = encryption.bound_component("task-content", None)?;
            identity(lease, &json!(grant.owner_id), &grant.server_id)?;
            let message = task_content::seal_message(
                &grant.component.key,
                &json!({
                    "ownerId":grant.owner_id,"keyRevision":grant.component.key_revision,
                    "messageId":uuid::Uuid::new_v4().to_string(),
                }),
                "assistant",
                "default",
                &json!(format!("activity:turn:{activity_id}")),
                part,
            )?;
            ("agent.protected-task-message", message)
        } else {
            let scope = Scope::new(encryption.clone())?;
            identity(lease, &json!(scope.owner), &json!(scope.server))?;
            let key = format!("activity:root:turn:{activity_id}");
            let id = event_id(
                &chat
                    .as_js_string()
                    .context("Missing activity chat.")?
                    .lossy(),
                &key,
            );
            let message = scope.protect(&json!({
                "id":id,"role":"assistant","content":vec![part],"idempotencyKey":key,
            }))?;
            ("agent.protected-message", message)
        };
        let (owner, server) = encryption.bound_identity()?;
        identity(lease, &json!(owner), &server)?;
        checked(
            "computerUseActivityEventSchema",
            &json!({
                "type":"computer-use.activity","operationId":operation_id,"event":json!({
                    "type":kind,"message":message,
                    "telemetry":json!({"kind":"activity","activityType":"computerUse","turnId":Value::Null}),
                }),
            }),
        )
    }

    fn build(
        self,
        lease: &Lease,
        operation: &Value,
        id: &Value,
        delivery_failed: bool,
        is_task: bool,
    ) -> Result<Value> {
        let name = operation.as_str().context("Missing activity operation.")?;
        let completed_at = self.started_at.max(chrono::Utc::now().timestamp_millis());
        let duration = completed_at - self.started_at;
        let code = self
            .error
            .as_deref()
            .or(delivery_failed.then_some("operation-failed"));
        let cancelled =
            !matches!(name, "preview.stop" | "session.close") && lease.signal.check().is_err();
        let outcome = match code {
            _ if cancelled => "cancelled",
            Some("cancelled" | "revoked" | "closed") => "cancelled",
            Some("denied") => "declined",
            Some(_) => "failed",
            None => "completed",
        };
        let status = if outcome == "cancelled" {
            "failed"
        } else {
            outcome
        };
        let chat = &lease.authority["chatId"];
        let task_id = if is_task { chat.clone() } else { Value::Null };
        let session = if self.session.is_null() {
            &self.before
        } else {
            &self.session
        };
        let target = if !self.target.is_null() {
            self.target
        } else if !session["target"].is_null() {
            target_reference(&session["target"])
        } else {
            target_reference(&self.before["target"])
        };
        let observation = if !self.image.is_null() && !session.is_null() {
            json!({"revision":session["observationRevision"],"image":self.image})
        } else {
            Value::Null
        };
        checked(
            "agentActivitySchema",
            &json!({
                "id":uuid::Uuid::new_v4().to_string(),"type":"computerUse","status":status,
                "startedAtMs":self.started_at,"updatedAtMs":completed_at,"completedAtMs":completed_at,
                "source":"user-preview","operation":operation,"operationId":id,"requestId":Value::Null,
                "binding":json!({
                    "chatId":chat,"taskId":task_id,"workerId":lease.authority["workerId"],
                    "threadId":Value::Null,"turnId":Value::Null,"sessionId":session["binding"]["sessionId"],
                }),
                "target":target,"cursor":session["cursor"],"input":Value::Null,"observation":observation,
                "outcome":outcome,"errorCode":code,"durationMs":duration,
                "correlation":json!({
                    "sourceMethod":format!("computer-use/{name}"),"diagnosticId":id,
                    "threadId":Value::Null,"turnId":Value::Null,"itemId":Value::Null,
                }),
                "raw":json!({
                    "schemaVersion":1,"request":Value::Null,"response":Value::Null,
                    "metadata":json!({
                        "source":"user-preview","operation":operation,"operationId":id,
                        "outcome":outcome,"errorCode":code.unwrap_or(""),"durationMs":duration.to_string(),
                    }),
                }),
            }),
        )
    }
}

fn target_reference(target: &Value) -> Value {
    if target.is_null() {
        Value::Null
    } else {
        json!({"targetId":target["id"],"targetGeneration":target["generation"]})
    }
}

fn identity(lease: &Lease, owner: &Value, server: &Value) -> Result<()> {
    ensure!(
        lease.authority["ownerId"] == *owner && lease.authority["serverId"] == *server,
        "The computer-use activity encryption binding changed."
    );
    Ok(())
}
