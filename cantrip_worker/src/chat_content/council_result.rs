use super::{Scope, prepare_council_input};
use anyhow::{Context, Result};
use cantrip_history::canonical::open_message;
use cantrip_history::content::Encryption;
use cantrip_wire::{Value, value::json};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};

pub(super) fn prepare(scope: &Scope, command: &Value) -> Result<Value> {
    let source = &command["source"];
    let chat = source["chatId"].as_str().context("Project chat ID")?;
    let input = source["inputMessageId"]
        .as_str()
        .context("Project input ID")?;
    let project = source["projectId"].as_str().context("Project ID")?;
    let status = source["status"].as_str().context("Project result status")?;
    let link = format!(
        "/?councilProject={}&projectChat={}&message={}",
        utf8_percent_encode(project, NON_ALPHANUMERIC),
        utf8_percent_encode(chat, NON_ALPHANUMERIC),
        utf8_percent_encode(input, NON_ALPHANUMERIC),
    );
    let result = &command["result"];
    let detail = if let Some(revision) = result["protectedContent"]["keyRevision"].as_u64() {
        let grant = scope.material(Some(revision))?;
        let content = open_message(&grant.key, &json!(grant.owner_id), result)?;
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
    prepare_council_input(
        scope,
        command,
        "councilProjectResult",
        format!(
            "A Cantrip project chat you delegated to finished with status {status}. This is a project result.\nSource: {link}\n\n{detail}"
        ),
    )
}
