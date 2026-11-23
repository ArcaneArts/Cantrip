use super::{Authorized, Inner};
use crate::{
    http::checked,
    mcp::bindings::{WORKTREE_READ_TOOLS, WORKTREE_WRITE_TOOLS},
};
use anyhow::{Context, Result, ensure};
use cantrip_protocol::{mcp_host, response::response_error};
use cantrip_wire::{Value, value::json};

impl Inner {
    pub(super) async fn worktree(
        &self,
        authorization: &Authorized,
        call: &Value,
        operation: &str,
    ) -> Result<Value> {
        let binding = &authorization.active.binding;
        ensure!(
            binding["contextKind"] == "project",
            "Worktree operations require a project MCP binding."
        );
        let tool = WORKTREE_READ_TOOLS
            .into_iter()
            .chain(WORKTREE_WRITE_TOOLS)
            .find(|(name, _)| *name == operation)
            .context("Unsupported Cantrip MCP worktree operation.")?
            .1;
        let arguments = mcp_host::parse(&format!("mcpStdioInput/{tool}"), call.get("arguments"))
            .map_err(response_error)?;
        let project = &binding["projectId"];
        let target = &arguments["target"];
        ensure!(
            target.is_null() || &target["projectId"] == project,
            "The worktree target belongs to a different project."
        );
        let mut result = self
            .relay_project(
                authorization,
                json!({"operation":operation,"arguments":arguments}),
                &uuid::Uuid::new_v4().to_string(),
            )
            .await?;
        match operation {
            "worktree.list" => {
                let rows = result["data"]["worktrees"]
                    .as_array()
                    .context("Missing worktree inventory.")?;
                let trees = rows
                    .iter()
                    .map(|row| project_worktree(row, project))
                    .collect::<Result<Vec<_>>>()?;
                result["data"]["worktrees"] = Value::Array(trees);
            }
            "worktree.status" => {
                let id = target.get("worktreeId").unwrap_or(&binding["worktreeId"]);
                ensure!(
                    result["target"] == worktree_target(project, id) && &result["worktreeId"] == id,
                    "Cantrip returned status for a different worktree."
                );
                let status = checked("worktreeStatusResultSchema", &result["data"])?;
                let worktree = remove_paths(status["worktree"].clone())?;
                result["data"] = json!({
                    "worktree":worktree,"status":status["status"],
                    "filesTruncated":result["data"]["filesTruncated"],
                    "branchesTruncated":result["data"]["branchesTruncated"],
                });
            }
            "worktree.create" => {
                let worktree = project_worktree(&result["data"], project)?;
                ensure!(
                    worktree["workerId"] == binding["workerId"] && worktree["origin"] == "agent",
                    "Cantrip created a worktree outside the MCP binding."
                );
                result["target"] = worktree_target(project, &worktree["id"]);
                result["worktreeId"] = worktree["id"].clone();
                result["data"] = json!({"worktree":worktree});
            }
            "worktree.switch" | "worktree.release" => {
                apply_transition(&mut result, binding, target, operation)?;
            }
            "worktree.remove" => {
                checked("worktreeRemoveResultSchema", &result["data"])?;
                ensure!(
                    result["worktreeId"] == target["worktreeId"],
                    "Cantrip removed a different worktree."
                );
                result["target"] = target.clone();
                result["data"] =
                    json!({"removedWorktreeId":target["worktreeId"],"branchRetained":true});
            }
            _ => unreachable!("registered Worktree tool"),
        }
        mcp_host::parse(&format!("mcpStdioOutput/{tool}"), Some(&result)).map_err(response_error)
    }
}

fn worktree_target(project: &Value, id: &Value) -> Value {
    json!({"kind":"worktree","projectId":project,"worktreeId":id})
}

fn project_worktree(input: &Value, project: &Value) -> Result<Value> {
    let worktree = checked("projectWorktreeSummarySchema", input)?;
    ensure!(
        &worktree["projectId"] == project,
        "Cantrip returned a worktree from another project."
    );
    remove_paths(worktree)
}

fn remove_paths(mut worktree: Value) -> Result<Value> {
    let Value::Object(fields) = &mut worktree else {
        anyhow::bail!("Missing worktree details.");
    };
    fields.shift_remove("path");
    fields.shift_remove("displayPath");
    Ok(worktree)
}

fn apply_transition(
    result: &mut Value,
    binding: &Value,
    target: &Value,
    operation: &str,
) -> Result<()> {
    let project = &binding["projectId"];
    let worktree = project_worktree(&result["data"]["worktree"], project)?;
    let lanes = checked(
        "chatExecutionLaneListSchema",
        &Value::Array(vec![result["data"]["lane"].clone()]),
    )?;
    let lane = &lanes.as_array().expect("validated lane list")[0];
    let kind = if operation == "worktree.switch" {
        "switch"
    } else {
        "release"
    };
    ensure!(
        lane["worktreeId"] == worktree["id"]
            && lane["transitionKind"] == kind
            && lane["chatId"] == binding["chatId"]
            && result["worktreeId"] == worktree["id"]
            && (target.is_null() || target["worktreeId"] == worktree["id"]),
        "Cantrip returned a malformed worktree transition."
    );
    result["target"] = worktree_target(project, &worktree["id"]);
    result["data"] = json!({
        "lane":json!({"id":lane["id"],"state":lane["state"],"transitionKind":lane["transitionKind"]}),
        "worktree":worktree,
    });
    Ok(())
}
