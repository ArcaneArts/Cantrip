use super::{Authorized, Inner};
use crate::{
    http::checked,
    mcp::bindings::{RUN_READ_TOOLS, RUN_WRITE_TOOLS},
    run_runtime::protection,
};
use anyhow::{Context, Result, ensure};
use cantrip_protocol::{mcp_host, response::response_error};
use cantrip_wire::{Value, value::json};

impl Inner {
    pub(super) async fn run_configuration(
        &self,
        authorization: &Authorized,
        call: &Value,
        operation: &str,
    ) -> Result<Value> {
        let binding = &authorization.active.binding;
        ensure!(
            binding["contextKind"] == "project",
            "Run configurations require a project MCP binding."
        );
        let tool = RUN_READ_TOOLS
            .into_iter()
            .chain(RUN_WRITE_TOOLS)
            .find(|(name, _)| *name == operation)
            .context("Unsupported Cantrip MCP Run operation.")?
            .1;
        let arguments = mcp_host::parse(&format!("mcpStdioInput/{tool}"), call.get("arguments"))
            .map_err(response_error)?;
        let project = &binding["projectId"];
        let relayed = if operation == "run-configuration.secret-set" {
            let encryption = self
                .encryption
                .as_deref()
                .context("Run encryption is unavailable.")?;
            let grant = encryption.bound_component("run-content", None)?;
            ensure!(
                grant.owner_id == authorization.identity.0
                    && grant.server_id.as_js_string() == Some(&authorization.identity.1),
                "The worker binding changed during protected Run processing."
            );
            let protected = protection::protect_secret_value(
                &grant,
                project,
                &arguments["reference"],
                &arguments["value"],
            )?;
            json!({"operationId":arguments["operationId"],"reference":arguments["reference"],"protectedValue":protected})
        } else {
            arguments.clone()
        };
        let mut result = self
            .relay_project(
                authorization,
                json!({"operation":operation,"arguments":relayed}),
                &uuid::Uuid::new_v4().to_string(),
            )
            .await?;
        if matches!(
            operation,
            "run-configuration.start"
                | "run-configuration.restart"
                | "run-configuration.stop"
                | "run-configuration.read-output"
        ) {
            let target = &result["target"];
            ensure!(
                target["kind"] == "worktree"
                    && &target["projectId"] == project
                    && target["worktreeId"] == result["worktreeId"]
                    && (arguments["worktreeId"].is_null()
                        || arguments["worktreeId"] == target["worktreeId"]),
                "Cantrip returned a Run configuration runtime for another target."
            );
        } else {
            ensure!(
                result["target"]["kind"] == "project" && &result["target"]["projectId"] == project,
                "Cantrip returned Run configuration state for another project."
            );
        }
        if operation == "run-configuration.read-output" {
            let wire = checked(
                "protectedRunConfigurationRuntimeOutputResultSchema",
                &result["data"],
            )?;
            ensure!(
                &wire["projectId"] == project
                    && wire["configurationId"] == arguments["configurationId"]
                    && wire["worktreeId"] == result["worktreeId"]
                    && wire["operationId"] == arguments["operationId"],
                "Cantrip returned output for another Run runtime."
            );
            let encryption = self
                .encryption
                .as_deref()
                .context("Run encryption is unavailable.")?;
            result["data"] =
                protection::open_output(encryption, &json!(authorization.identity.1), &wire)?;
        }
        mcp_host::parse(&format!("mcpStdioOutput/{tool}"), Some(&result)).map_err(response_error)
    }
}
