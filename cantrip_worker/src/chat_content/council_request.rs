use super::{Scope, prepare_council_input};
use crate::encryption::Service;
use anyhow::{Context, Result, ensure};
use cantrip_crypto::content::{Communication, decrypt_communication};
use cantrip_wire::{Value, value::json};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};

pub(super) fn prepare(scope: &Scope, encryption: &Service, command: &Value) -> Result<Value> {
    let source = &command["source"];
    let chat = source["chatId"].as_str().context("Project chat ID")?;
    let request_id = source["requestId"].as_str().context("Project request ID")?;
    let project = source["projectId"].as_str().context("Project ID")?;
    let task = source["targetKind"] == "task";
    let target = if task { "project Task" } else { "project chat" };
    let link = format!(
        "/?councilProject={}&projectChat={}&request={}{}",
        utf8_percent_encode(project, NON_ALPHANUMERIC),
        utf8_percent_encode(chat, NON_ALPHANUMERIC),
        utf8_percent_encode(request_id, NON_ALPHANUMERIC),
        if task { "&task=true" } else { "" },
    );

    let request = &command["request"];
    let protected = &request["protectedPayload"];
    let revision = protected["keyRevision"]
        .as_u64()
        .context("Project request key revision")?;
    let grant = encryption.bound_component("interaction-content", Some(revision))?;
    ensure!(
        grant.owner_id == scope.owner && grant.server_id.as_js_string() == Some(&scope.server),
        "The project request encryption binding changed."
    );
    let opened = decrypt_communication(
        Communication::InteractionRequest,
        &grant.component.key,
        &json!({"ownerId":grant.owner_id,"requestKey":command["requestKey"],"keyRevision":grant.component.key_revision}),
        protected,
        Some(&request["classification"]),
    )?;
    let payload = &opened["payload"];
    let kind = match payload["kind"].as_str() {
        Some("commandExecution") => "command approval",
        Some("fileChange") => "file change approval",
        Some("permissions") => "permission approval",
        Some("userInput") => "question",
        Some("mcpElicitation") => "MCP request",
        _ => "interaction request",
    };
    let detail = ["reason", "command", "message"]
        .into_iter()
        .filter_map(|field| payload[field].as_str())
        .chain(
            payload["questions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|question| question["isSecret"] != true)
                .filter_map(|question| question["question"].as_str()),
        )
        .collect::<Vec<_>>()
        .join("\n")
        .chars()
        .take(3_000)
        .collect::<String>();
    prepare_council_input(
        scope,
        command,
        "councilProjectRequest",
        format!(
            "A Cantrip {target} you delegated to is waiting for a human to answer its {kind}. You can explain this request and point the user to it. The user responds to the original request in Cantrip.\nSource: {link}\n\n{detail}"
        ),
    )
}
