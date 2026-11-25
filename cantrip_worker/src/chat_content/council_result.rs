use super::{Scope, prepare_council_input};
use crate::encryption::Service;
use anyhow::{Context, Result, ensure};
use cantrip_crypto::content::{Communication, decrypt_communication};
use cantrip_history::canonical::open_message;
use cantrip_history::content::Encryption;
use cantrip_wire::{Value, value::json};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};

pub(super) fn prepare(scope: &Scope, encryption: &Service, command: &Value) -> Result<Value> {
    let source = &command["source"];
    let is_task = source["targetKind"] == "task";
    let chat = source["chatId"].as_str().context("Project chat ID")?;
    let project = source["projectId"].as_str().context("Project ID")?;
    let status = source["status"].as_str().context("Project result status")?;
    let mut link = format!(
        "/?councilProject={}&projectChat={}",
        utf8_percent_encode(project, NON_ALPHANUMERIC),
        utf8_percent_encode(chat, NON_ALPHANUMERIC),
    );
    if let Some(input) = source["inputMessageId"].as_str() {
        link.push_str("&message=");
        link.push_str(&utf8_percent_encode(input, NON_ALPHANUMERIC).to_string());
    }
    if is_task {
        link.push_str("&task=true");
    }
    let result = &command["result"];
    let detail = if let Some(revision) = result["protectedContent"]["keyRevision"].as_u64() {
        let content = if is_task {
            let grant = encryption.bound_component("task-content", Some(revision))?;
            ensure!(
                grant.owner_id == scope.owner
                    && grant.server_id.as_js_string() == Some(&scope.server),
                "The Task result encryption binding changed."
            );
            decrypt_communication(
                Communication::TaskMessage,
                &grant.component.key,
                &json!({"ownerId":grant.owner_id,"messageId":result["id"],"keyRevision":revision}),
                &result["protectedContent"],
                Some(&result["classification"]),
            )?["content"]
                .clone()
        } else {
            let grant = scope.material(Some(revision))?;
            open_message(&grant.key, &json!(grant.owner_id), result)?
        };
        content
            .as_array()
            .context("Project result content")?
            .iter()
            .filter(|part| part["type"] == "text")
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n")
            .chars()
            .take(6_000)
            .collect::<String>()
    } else {
        String::new()
    };
    let target = if is_task { "Task" } else { "project chat" };
    prepare_council_input(
        scope,
        command,
        "councilProjectResult",
        format!(
            "A Cantrip {target} you delegated to finished with status {status}. This is a project result.\nSource: {link}\n\n{detail}"
        ),
    )
}
