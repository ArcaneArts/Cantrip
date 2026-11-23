//! Encrypted project and Host-terminal command discovery.
mod manifests;

use crate::{
    encryption::Service,
    filesystem::{Scope, paths},
    protected_content::protect_repository_content,
    terminal_services::host_private_state,
};
use anyhow::{Context, Result, anyhow, bail};
use cantrip_wire::{Value, value::json};

pub(crate) const PROJECT: &str = "project.script-commands.inspect";
pub(crate) const TERMINAL: &str = "project.script-commands";

pub(crate) async fn execute(input: &Value, service: &Service, scope: Scope) -> Result<Value> {
    let terminal = input["type"] == TERMINAL;
    if terminal && input["worktreePath"].as_js_string().is_none() {
        bail!(
            "Linux script discovery requires its delegated filesystem path; no Host files were read."
        );
    }
    let discover = async {
        let (cwd, project, worktree) = if terminal {
            let state = host_private_state(input, service)?;
            (state.cwd, &input["terminalId"], &input["terminalId"])
        } else {
            (
                paths::native(
                    input["sourcePath"]
                        .as_js_string()
                        .context("Project source path")?,
                ),
                &input["projectId"],
                &input["worktreeId"],
            )
        };
        scope.check()?;
        let commands =
            tokio::task::spawn_blocking(move || manifests::discover(&cwd, cfg!(windows), &scope))
                .await??;
        let binding = json!({
            "serverId":input["serverId"],"projectId":project,"worktreeId":worktree,
            "operationId":input["operationId"],"direction":"response",
        });
        protect_repository_content(service, &binding, &commands, "scriptCommandListSchema")
    };
    discover.await.map_err(|_: anyhow::Error| {
        if terminal {
            anyhow!("Could not discover terminal script commands.")
        } else {
            anyhow!("Could not discover project script commands.")
        }
    })
}
