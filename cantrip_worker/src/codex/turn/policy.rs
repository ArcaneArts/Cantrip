//! Open the policies selected by Core without sending plaintext back to it.
use crate::{
    encryption::Service,
    protected_content::{EffectivePolicies, open_policy_body, open_policy_summary},
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value};

const CONTEXT_LIMIT: usize = 32 * 1024;

pub(super) fn context(encryption: &Service, command: &Value) -> Result<Option<JsString>> {
    let binding = encryption.bound_identity()?;
    let context = if command["policyProjectId"].is_string() {
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
