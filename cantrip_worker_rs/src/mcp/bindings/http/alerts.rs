use super::{Authorized, Inner};
use crate::http::checked;
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_crypto::{Zeroizing, content::encrypt_endpoint};
use cantrip_protocol::{mcp_host, response::response_error};
use cantrip_wire::{Value, value::json};

impl Inner {
    pub(super) async fn alert(
        &self,
        authorization: &Authorized,
        call: &Value,
        operation: &str,
    ) -> Result<Value> {
        let encryption = self
            .encryption
            .as_deref()
            .context("Endpoint content encryption is unavailable.")?;
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
        let grant = encryption
            .bound_component("alert-content", None)
            .map_err(|_| anyhow!("Endpoint content encryption is unavailable."))?;
        ensure!(
            grant.owner_id == authorization.identity.0
                && grant.server_id.as_js_string() == Some(&authorization.identity.1),
            "Alerts require the current project’s authorized worker."
        );
        let context = json!({
            "domain":"alert-content","serverId":grant.server_id,"workerId":binding["workerId"],
            "scopeId":binding["chatId"],"operationId":input["key"],"operation":"agent-alert",
            "direction":"stored","sequence":input["revision"],
        });
        let plaintext = Zeroizing::new(detail.stringify().into_bytes());
        let content = encrypt_endpoint(
            &grant.component.key,
            &json!({"ownerId":grant.owner_id,"keyRevision":grant.component.key_revision,"context":context}),
            &plaintext,
        )?;
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
