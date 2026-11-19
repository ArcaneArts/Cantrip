use super::Configuration;
use crate::{encryption::Service, filesystem::paths, protected_content::open_private_state};
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{Value, value::json};

pub fn open(input: &Value, service: &Service) -> Result<Configuration> {
    let configuration = open_host(input, service)?;
    if configuration.command.trim().is_empty() {
        bail!("An enabled terminal service needs a command.");
    }
    Ok(configuration)
}

pub(super) fn open_host(input: &Value, service: &Service) -> Result<Configuration> {
    let owner = service.owner_id()?;
    let binding = json!({"serverId":input["serverId"],"resource":"terminal-row","resourceId":input["terminalId"],"operationId":Value::Null,"recordKind":"terminal-state"});
    let state = checked(
        "terminalPrivateStateProtectedContentSchema",
        &open_private_state(service, &owner, &binding, &input["stateProtection"])?,
    )?;
    let Some(root) = input["worktreePath"].as_js_string() else {
        bail!(
            "Linux terminal services require their delegated service lifecycle; no Host command was started."
        );
    };
    let root = paths::resolve(&paths::native(root))?;
    let cwd = if state["directory"]["kind"] == "project-root" {
        root.clone()
    } else {
        cantrip_config::resolve(
            &root,
            &paths::native(state["directory"]["path"].as_js_string().unwrap()),
        )
    };
    if !paths::within(&root, &cwd) {
        bail!("The protected terminal directory escapes its worktree.");
    }
    let command = state["serviceCommand"].as_js_string().unwrap().clone();
    Ok(Configuration {
        terminal_id: input["terminalId"].as_js_string().unwrap().clone(),
        cwd,
        command,
    })
}
