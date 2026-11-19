use super::Configuration;
use crate::{
    encryption::Service,
    filesystem::paths,
    protected_content::{open_private_state, protect_private_state},
};
use anyhow::{Result, bail};
use cantrip_crypto::{checked, content::encrypt_private_label};
use cantrip_wire::{Value, value::json};

pub fn open(input: &Value, service: &Service) -> Result<Configuration> {
    let configuration = open_host(input, service)?;
    if configuration.command.trim().is_empty() {
        bail!("An enabled terminal service needs a command.");
    }
    Ok(configuration)
}

fn binding(input: &Value) -> Value {
    json!({"serverId":input["serverId"],"resource":"terminal-row","resourceId":input["terminalId"],"operationId":Value::Null,"recordKind":"terminal-state"})
}

pub(super) fn open_state(input: &Value, service: &Service) -> Result<Value> {
    checked(
        "terminalPrivateStateProtectedContentSchema",
        &open_private_state(
            service,
            &service.owner_id()?,
            &binding(input),
            &input["stateProtection"],
        )?,
    )
}

pub(super) fn prepare_console(input: &Value, service: &Service) -> Result<Value> {
    let grant = service.bound_component("private-surface-metadata", None)?;
    anyhow::ensure!(
        grant.server_id == input["serverId"],
        "Terminal belongs to another server."
    );
    let key = grant.component;
    let title = encrypt_private_label(
        &key.key,
        &json!({"ownerId":grant.owner_id,"rowId":input["terminalId"],"recordKind":"terminal","keyRevision":key.key_revision}),
        &json!("Console"),
    )?;
    let state = protect_private_state(
        service,
        &grant.owner_id,
        &binding(input),
        &json!({"version":1,"classification":json!({"recordKind":"terminal-state"}),
            "directory":json!({"kind":"project-root"}),"serviceCommand":""}),
    )?;
    checked(
        "encryptedLinkedConsoleCreateSchema",
        &json!({
            "id":input["terminalId"],"titleProtection":title,"stateProtection":state,
        }),
    )
}

pub(super) fn open_host(input: &Value, service: &Service) -> Result<Configuration> {
    let state = open_state(input, service)?;
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
