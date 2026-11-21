use super::{Authorized, Inner};
use anyhow::{Result, ensure};
use cantrip_protocol::{mcp_host, response::response_error};
use cantrip_wire::{Value, value::json};

impl Inner {
    pub(super) async fn terminal(
        &self,
        authorization: &Authorized,
        call: &Value,
        operation: &str,
    ) -> Result<Value> {
        let tool = match operation {
            "terminal.read" => "terminal_read",
            "terminal.send" => "terminal_send",
            "terminal.restart" => "terminal_restart",
            _ => unreachable!("registered terminal operation"),
        };
        let arguments = mcp_host::parse(&format!("mcpStdioInput/{tool}"), call.get("arguments"))
            .map_err(response_error)?;
        let target = &arguments["target"];
        let surface = self.resolve_surface(authorization, target).await?;
        let mut response = match operation {
            "terminal.read" => {
                let (mut result, snapshot) = surface
                    .exchange(
                        operation,
                        "request",
                        "terminalSnapshotRequestContentSchema",
                        &json!({"type":"terminal.snapshot","maxChars":arguments["maxChars"]}),
                    )
                    .await?;
                ensure!(
                    snapshot["type"] == "terminal.snapshot"
                        && snapshot["terminalId"] == target["surfaceId"],
                    "Terminal returned an unexpected protected snapshot."
                );
                let status = snapshot["status"]
                    .as_str()
                    .expect("validated terminal status");
                let suffix = if snapshot["truncated"] == true {
                    "; scrollback was truncated"
                } else {
                    ""
                };
                result["summary"] = json!(format!("Terminal is {status}{suffix}."));
                result["data"] = json!({
                    "status":snapshot["status"],"data":snapshot["data"],
                    "truncated":snapshot["truncated"],"exitCode":snapshot["exitCode"],
                });
                result
            }
            "terminal.send" => {
                let (mut result, receipt) = surface
                    .exchange(
                        operation,
                        "input",
                        "terminalInputContentSchema",
                        &json!({"type":"terminal.input","data":arguments["data"]}),
                    )
                    .await?;
                ensure!(
                    receipt["type"] == "terminal.input.accepted",
                    "Terminal returned an unexpected protected input result."
                );
                result["summary"] = json!("Sent protected terminal input.");
                result["data"] = json!({"accepted":true});
                result
            }
            "terminal.restart" => {
                let mut result = surface.invoke(operation, json!({})).await?;
                result["data"] = json!({"status":"running"});
                result
            }
            _ => unreachable!("registered terminal operation"),
        };
        if operation != "terminal.read" {
            response["worktreeId"] = surface.worktree().clone();
            response["mutated"] = json!(true);
            response["continuationScheduled"] = json!(false);
        }
        mcp_host::parse(&format!("mcpStdioOutput/{tool}"), Some(&response)).map_err(response_error)
    }
}
