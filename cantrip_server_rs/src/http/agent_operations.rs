//! MCP failures and audits share the authenticated worker's owner, never its session.
use super::json_response;
use crate::{
    auth::{repository::AuditRecord, service::AuthService},
    wire::{JsString, Value, value::json},
};
use anyhow::Result;
use axum::{http::StatusCode, response::Response};

#[derive(Debug)]
pub(super) struct OperationError {
    pub status: u16,
    pub code: &'static str,
    pub message: JsString,
}
impl OperationError {
    pub fn new(status: u16, code: &'static str, message: impl Into<JsString>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }
    pub fn validation() -> Self {
        Self::new(
            400,
            "invalid",
            "Cantrip MCP operation validation failed on the server.",
        )
    }
    pub fn response(&self) -> Response {
        json_response(
            StatusCode::from_u16(self.status).expect("MCP operation status"),
            json!({"code":self.code,"error":self.message}),
        )
    }
    pub fn from_cause(cause: &anyhow::Error) -> Self {
        if let Some(error) = cause.downcast_ref::<Self>() {
            return Self::new(error.status, error.code, error.message.clone());
        }
        if let Some(error) = cause.downcast_ref::<crate::projects::placement::Unavailable>() {
            let offline = matches!(error.code, "worker-offline" | "capability-unavailable");
            return Self::new(
                if offline { 503 } else { 409 },
                if offline { "unavailable" } else { "conflict" },
                error.message.clone(),
            );
        }
        if let Some(error) = cause.downcast_ref::<crate::chats::agent_delivery::DeliveryError>() {
            let (status, code) = match error {
                crate::chats::agent_delivery::DeliveryError::ReceiverUnavailable => {
                    (404, "not-found")
                }
                crate::chats::agent_delivery::DeliveryError::ModelRequired => (409, "conflict"),
            };
            return Self::new(status, code, error.to_string());
        }
        if cause
            .downcast_ref::<crate::settings::ResponseValidationError>()
            .is_some()
            || cause.is::<crate::policies::StoredPolicyValidationError>()
            || cause.is::<crate::projects::targets::StoredTargetValidationError>()
        {
            return Self::validation();
        }
        let message = cause
            .downcast_ref::<crate::database::query_error::QueryError>()
            .map(|error| &error.message)
            .or_else(|| {
                cause
                    .downcast_ref::<crate::policies::PolicyQueryError>()
                    .map(|error| &error.message)
            })
            .map_or_else(|| JsString::from(cause.to_string()), Clone::clone);
        Self::new(
            400,
            "invalid",
            JsString::new(message.units()[..message.len().min(2000)].to_vec()),
        )
    }
}
impl std::fmt::Display for OperationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message.lossy())
    }
}
impl std::error::Error for OperationError {}

pub(super) fn parse(schema: &str, input: &Value) -> Result<Value> {
    crate::wire::parse(schema, Some(input)).map_err(|_| OperationError::validation().into())
}

pub(super) async fn project_chats(
    service: &AuthService,
    owner: &str,
    project: &str,
) -> Result<Vec<Value>> {
    crate::chats::Repository::new(service.repository.database.clone())
        .list_project_with_query_context(
            owner,
            project,
            Some((
                crate::chats::mcp_read_queries::sql("list"),
                &[json!(owner), json!(project)],
            )),
        )
        .await
}

pub(super) async fn audit(
    service: &AuthService,
    owner: &str,
    binding: &Value,
    request_id: &str,
    action: &'static str,
    result: &'static str,
) {
    if service
        .repository
        .audit(AuditRecord {
            action,
            result,
            owner: Some(owner),
            actor: None,
            session: None,
            resource_type: "mcp-binding",
            resource: binding["bindingId"].as_str(),
            request_id,
        })
        .await
        .is_err()
    {
        eprintln!(
            "{}",
            serde_json::json!({"event":"security.audit-write-failed","action":action,"requestId":request_id})
        );
    }
}
