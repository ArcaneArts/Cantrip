use super::{Authorized, Inner};
use crate::{http::checked, mcp::bindings::server::TargetInspection};
use anyhow::{Context, Result, ensure};
use cantrip_protocol::{mcp_host, response::response_error};
use cantrip_wire::{Value, value::json};

impl Inner {
    pub(super) async fn client_control(
        &self,
        authorization: &Authorized,
        call: &Value,
        operation: &str,
    ) -> Result<Value> {
        let binding = &authorization.active.binding;
        ensure!(
            binding["contextKind"] == "project",
            "Client-control operations require a project MCP binding."
        );
        let tool = crate::mcp::bindings::CLIENT_TOOLS
            .iter()
            .find(|(candidate, _)| *candidate == operation)
            .map(|(_, tool)| *tool)
            .context("Unsupported Cantrip MCP client control.")?;
        let mut arguments =
            mcp_host::parse(&format!("mcpStdioInput/{tool}"), call.get("arguments"))
                .map_err(response_error)?;
        let request_id = uuid::Uuid::new_v4().to_string();
        let project = &binding["projectId"];
        let (target, worktree) = if operation == "client.focus-surface" {
            let target = &arguments["target"];
            ensure!(
                &target["projectId"] == project,
                "The client-control target belongs to another project."
            );
            let inspected = self
                .relay_project(
                    authorization,
                    json!({"operation":"target.inspect","arguments":json!({"target":target})}),
                    &format!("{request_id}:inspect-target"),
                )
                .await?;
            let resolution = TargetInspection::parse(&inspected)?.resolution;
            ensure!(
                &inspected["target"] == target
                    && &resolution["target"] == target
                    && resolution["availability"] == "available"
                    && &resolution["placement"]["projectId"] == project,
                "The client-control target is no longer available."
            );
            (
                target.clone(),
                resolution["placement"]["worktreeId"].clone(),
            )
        } else {
            let target = if operation == "client.show-interaction" {
                json!({"kind":"surface","projectId":project,"surfaceKind":"chat","surfaceId":binding["chatId"]})
            } else {
                json!({"kind":"project","projectId":project})
            };
            (target, binding["worktreeId"].clone())
        };
        if operation == "client.notify" {
            let context = json!({
                "domain":"client-control-content","serverId":authorization.identity.1,
                "workerId":binding["workerId"],"scopeId":project,"operationId":request_id,
                "operation":operation,"direction":"event","sequence":0,
            });
            let content = self.protect_endpoint(authorization, &context, &arguments)?;
            arguments = checked(
                "protectedClientNotificationSchema",
                &json!({"operationId":request_id,"protectedContent":content}),
            )?;
        }
        let result = self
            .relay_project(
                authorization,
                json!({"operation":operation,"arguments":arguments}),
                &request_id,
            )
            .await?;
        let data = &result["data"];
        let response = json!({
            "summary":result["summary"],"target":target,"worktreeId":worktree,
            "continuationScheduled":false,"mutated":data["status"]=="applied",
            "data":json!({"correlationId":data["correlationId"],"status":data["status"]}),
        });
        mcp_host::parse(&format!("mcpStdioOutput/{tool}"), Some(&response)).map_err(response_error)
    }
}
