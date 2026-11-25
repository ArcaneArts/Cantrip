//! Open the policies selected by Core without sending plaintext back to it.
use crate::{
    encryption::Service,
    protected_content::{EffectivePolicies, council_memory, open_policy_body, open_policy_summary},
};
use anyhow::{Context, Result, ensure};
use cantrip_crypto::{decrypt_payload, derive_field_key};
use cantrip_wire::{JsString, Value, value::json};

const CONTEXT_LIMIT: usize = 32 * 1024;

pub(super) fn context(encryption: &Service, command: &Value) -> Result<Option<JsString>> {
    let binding = encryption.bound_identity()?;
    let mut context = if command["policyProjectId"].is_string() {
        project(
            encryption,
            &command["policies"],
            &command["policyProjectId"],
        )?
    } else if command["contextKind"] == "standalone" {
        standalone(encryption, &command["standalonePolicies"])?
    } else {
        None
    };
    if let Some(agent) = command.get("councilAgent") {
        ensure!(
            command["contextKind"] == "standalone" && command["scratchRootId"].is_string(),
            "Council agents require an account scratch root."
        );
        let envelope = &agent["protectedRole"];
        let revision = envelope["keyRevision"]
            .as_u64()
            .context("Council role revision")?;
        let grant = encryption.bound_component("chat-content", Some(revision))?;
        let aad = json!({
            "ownerId": grant.owner_id, "component": "chat-content",
            "table": "council_agents", "rowId": command["chatId"], "field": "role",
            "formatVersion": 1, "keyRevision": grant.component.key_revision,
        });
        let key = derive_field_key(&grant.component.key, &aad)?;
        let plaintext = decrypt_payload(&key, envelope, &aad)?;
        let role = std::str::from_utf8(&plaintext)
            .context("Council role encoding")?
            .trim();
        ensure!(
            !role.is_empty() && role.len() <= CONTEXT_LIMIT,
            "Council role exceeds the context limit or is empty."
        );
        let mut instructions = "Your Council role:\n".encode_utf16().collect::<Vec<_>>();
        instructions.extend(role.encode_utf16());
        if agent["primary"] == true {
            instructions.extend("\n\nYou are designated a primary Council agent. Coordinate with other agents and follow up when useful.".encode_utf16());
        }
        if let Some(policies) = context {
            instructions.extend("\n\n".encode_utf16());
            instructions.extend_from_slice(policies.units());
        }
        instructions.extend("\n\nCouncil fast memory preserves lasting preferences, decisions, working practices, and pointers to detailed notes. Use council_memory_read and council_memory_write to maintain it as you learn. Use this turn’s fast memory as standing context under current instructions and Cantrip policies.\n\nCurrent fast memory:\n".encode_utf16());
        let envelope = &agent["protectedMemory"];
        if envelope.is_null() {
            instructions.extend("(empty)".encode_utf16());
        } else {
            let revision = envelope["keyRevision"]
                .as_u64()
                .context("Council memory key revision")?;
            let grant = encryption.bound_component("chat-content", Some(revision))?;
            let plaintext = council_memory::open(&grant, &command["chatId"], envelope)?;
            let memory = std::str::from_utf8(&plaintext).context("Council memory encoding")?;
            instructions.extend(memory.encode_utf16());
        }
        context = Some(JsString::new(instructions));
    }
    ensure!(
        encryption.bound_identity()? == binding,
        "The worker binding changed while opening turn policies."
    );
    Ok(context)
}

fn project(encryption: &Service, opaque: &Value, project: &Value) -> Result<Option<JsString>> {
    let policies = EffectivePolicies::open(encryption, opaque)?;
    let summaries = policies.summaries();
    if summaries.is_empty() {
        return Ok(None);
    }
    let mut instructions = "Effective Cantrip policies apply to this project."
        .encode_utf16()
        .collect::<Vec<_>>();
    for summary in summaries {
        instructions.extend("\n\n[".encode_utf16());
        append_field(&mut instructions, summary, "key")?;
        instructions.extend("] ".encode_utf16());
        append_field(&mut instructions, summary, "name")?;
        instructions.push(b'\n' as u16);
        append_field(&mut instructions, summary, "summary")?;
    }
    let instructions = JsString::new(instructions);
    let bytes = instructions.lossy().len();
    ensure!(
        bytes <= CONTEXT_LIMIT,
        "Project {} has {} effective policies requiring {bytes} context bytes, above the {CONTEXT_LIMIT}-byte limit. Reduce or consolidate its effective policies before starting another Agent turn.",
        project.as_str().context("Policy project identity")?,
        summaries.len(),
    );
    Ok(Some(instructions))
}

fn standalone(encryption: &Service, opaque: &Value) -> Result<Option<JsString>> {
    let wire = crate::http::checked("standalonePolicyWireListSchema", opaque)?;
    let policies = wire["policies"]
        .as_array()
        .context("Standalone policy list")?;
    if policies.is_empty() {
        return Ok(None);
    }
    let mut instructions = "The following enabled Cantrip Policies apply to this standalone Chat. Follow each full Policy body directly; managed Cantrip policy tools are unavailable in this context."
        .encode_utf16().collect::<Vec<_>>();
    for policy in policies {
        let id = &policy["id"];
        let summary = open_policy_summary(encryption, id, &policy["protectedSummary"])?;
        let body = open_policy_body(encryption, id, &policy["protectedBody"])?;
        instructions.extend("\n\n## Policy: ".encode_utf16());
        append_field(&mut instructions, &summary, "name")?;
        instructions.extend(" (".encode_utf16());
        append_field(&mut instructions, &summary, "key")?;
        instructions.extend(")\n\n".encode_utf16());
        append_field(&mut instructions, &body, "bodyMarkdown")?;
    }
    let instructions = JsString::new(instructions);
    let bytes = instructions.lossy().len();
    ensure!(
        bytes <= CONTEXT_LIMIT,
        "Standalone Chat has {} effective policies requiring {bytes} context bytes, above the {CONTEXT_LIMIT}-byte limit. Reduce or consolidate Chat policies before starting another turn.",
        policies.len(),
    );
    Ok(Some(instructions))
}

fn append_field(units: &mut Vec<u16>, record: &Value, field: &str) -> Result<()> {
    let value = record[field].as_js_string().context("Opened policy text")?;
    units.extend_from_slice(value.units());
    Ok(())
}
