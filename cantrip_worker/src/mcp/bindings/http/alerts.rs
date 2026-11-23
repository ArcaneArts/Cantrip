use super::{Authorized, Inner};
use crate::http::checked;
use anyhow::{Result, ensure};
use cantrip_protocol::{mcp_host, response::response_error};
use cantrip_wire::{Value, value::json};

impl Inner {
    pub(super) async fn alert(
        &self,
        authorization: &Authorized,
        call: &Value,
        operation: &str,
    ) -> Result<Value> {
        let binding = &authorization.active.binding;
        ensure!(
            binding["contextKind"] == "project",
            "Alerts require the current project’s authorized worker."
        );
        let resolving = operation == "alert.resolve";
        let tool = if resolving {
            "alert_resolve"
        } else {
            "alert_raise"
        };
        let input = mcp_host::parse(&format!("mcpStdioInput/{tool}"), call.get("arguments"))
            .map_err(response_error)?;
        let (kind, status, detail) = if resolving {
            (
                json!("blocked"),
                "resolved",
                json!({"title":"Alert resolved","message":"The originating agent resolved this Alert.","nextStep":""}),
            )
        } else {
            (
                input["kind"].clone(),
                "open",
                json!({"title":input["title"],"message":input["message"],"nextStep":input["nextStep"]}),
            )
        };
        let context = json!({
            "domain":"alert-content","serverId":authorization.identity.1,"workerId":binding["workerId"],
            "scopeId":binding["chatId"],"operationId":input["key"],"operation":"agent-alert",
            "direction":"stored","sequence":input["revision"],
        });
        let content = self.protect_endpoint(authorization, &context, &detail)?;
        let wire = checked(
            "agentAlertMutationWireSchema",
            &json!({
                "key":input["key"],"revision":input["revision"],"kind":kind,"status":status,
                "protectedDetail":json!({"context":context,"protectedContent":content}),
            }),
        )?;
        let result = self
            .relay_project(
                authorization,
                json!({"operation":operation,"arguments":wire}),
                &uuid::Uuid::new_v4().to_string(),
            )
            .await?;
        mcp_host::parse(&format!("mcpStdioOutput/{tool}"), Some(&result)).map_err(response_error)
    }
}
