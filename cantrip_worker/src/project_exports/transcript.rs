use crate::{encryption::Service, native_items::concat};
use anyhow::{Context, Result, ensure};
use cantrip_crypto::content::decrypt_private_label;
use cantrip_wire::{JsString, Value, value::json};

pub(super) struct Transcript {
    pub records: Vec<Value>,
    pub title: JsString,
    pub turns: usize,
    pub message_count: usize,
}

pub(super) fn open(bytes: &[u8], command: &Value, service: &Service) -> Result<Transcript> {
    let bound = service.bound_identity()?;
    let payload = crate::codex::relocation::transcript::open(bytes, service, &bound)?.payload;
    let opaque = &command["titleProtection"];
    let revision = opaque["protectedLabel"]["keyRevision"]
        .as_u64()
        .context("Missing export title key revision.")?;
    let grant = service.bound_component("private-surface-metadata", Some(revision))?;
    ensure!(
        (grant.owner_id.clone(), grant.server_id.clone()) == bound
            && service.bound_identity()? == bound,
        "The worker binding changed during project export."
    );
    let title = decrypt_private_label(
        &grant.component.key,
        &json!({"ownerId":grant.owner_id,"keyRevision":revision,"recordKind":"chat","rowId":command["chatId"]}),
        opaque,
    )?;
    let title = title
        .as_js_string()
        .context("Missing export title.")?
        .trim();
    let title = if title.is_empty() {
        "Exported Cantrip chat".into()
    } else {
        JsString::new(title.units().iter().take(120).copied().collect())
    };
    records(&payload, &command["cwd"], title)
}

fn records(payload: &Value, cwd: &Value, title: JsString) -> Result<Transcript> {
    let messages = payload["messages"]
        .as_array()
        .context("Missing export messages.")?;
    let mut records = vec![json!({"type":"custom-title","customTitle":title})];
    let mut turns = 0;
    for message in messages {
        let (item, text) = crate::codex::relocation::transcript::response_item(message)?;
        let role = item["role"]
            .as_str()
            .context("Invalid export message role.")?;
        let leading = role == "assistant" && turns == 0;
        let text = match (role, leading) {
            ("developer", _) => concat(&["[Cantrip developer message]\n".into(), text]),
            ("assistant", true) => concat(&["[Cantrip assistant message]\n".into(), text]),
            _ => text,
        };
        let kind = if role == "assistant" && !leading {
            "assistant"
        } else {
            "user"
        };
        turns += usize::from(kind == "user");
        // Current Cursor imports read the role field. Retain the record type
        // used by earlier bundled importers.
        records.push(
            json!({"type":kind,"role":kind,"cwd":cwd,"timestamp":message["createdAt"],
            "message":json!({"content":text})}),
        );
    }
    ensure!(
        turns != 0,
        "A Codex export requires at least one visible message."
    );
    Ok(Transcript {
        records,
        title,
        turns,
        message_count: messages.len(),
    })
}
