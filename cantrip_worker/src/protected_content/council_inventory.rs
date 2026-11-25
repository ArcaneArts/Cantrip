use crate::{
    encryption::{Service, ServiceError},
    http::checked,
    mcp::bindings::COUNCIL_TOOLS,
    protected_content::open_policy_summary,
    protected_secrets::open_mcp_servers,
};
use anyhow::{Context, Result, ensure};
use cantrip_crypto::content::decrypt_private_label;
use cantrip_wire::{JsString, Value, value::json};

pub(crate) fn open(service: &Service, identity: &(JsString, Value), raw: &Value) -> Result<Value> {
    ensure!(
        &service.bound_identity()? == identity,
        "The worker binding changed during Council discovery."
    );
    let mut result = checked("councilInventoryWireSchema", raw)?;
    let entries = result["entries"]
        .as_array()
        .context("Council inventory entries")?;
    result["entries"] = json!(
        entries
            .iter()
            .map(|entry| open_entry(service, identity, entry))
            .collect::<Result<Vec<_>>>()?
    );
    if result["section"] == "tools" {
        result["managedTools"] = json!(
            COUNCIL_TOOLS
                .iter()
                .map(|(_, name)| *name)
                .collect::<Vec<_>>()
        );
    }
    ensure!(
        &service.bound_identity()? == identity,
        "The worker binding changed during Council discovery."
    );
    checked("councilInventoryResultSchema", &result)
}

fn open_entry(service: &Service, identity: &(JsString, Value), entry: &Value) -> Result<Value> {
    match entry["kind"].as_str() {
        Some("setting" | "model") => Ok(entry.clone()),
        Some("policy") => {
            let summary = optional_grant(open_policy_summary(
                service,
                &entry["id"],
                &entry["protectedSummary"],
            ))?;
            Ok(
                json!({"id":entry["id"],"kind":"policy","title":summary["name"],"key":summary["key"]}),
            )
        }
        Some("mcp-server") => {
            let server = optional_grant(
                open_mcp_servers(service, std::slice::from_ref(entry))
                    .and_then(|servers| servers.into_iter().next().context("Effective MCP server")),
            )?;
            Ok(
                json!({"id":entry["id"],"kind":"mcp-server","title":server["name"],"transport":server["transport"]}),
            )
        }
        _ => open_label(service, identity, entry),
    }
}

fn optional_grant(result: Result<Value>) -> Result<Value> {
    match result {
        Err(error)
            if error
                .downcast_ref::<ServiceError>()
                .is_some_and(|error| error.code == Some("missing-scope")) =>
        {
            Ok(Value::Null)
        }
        result => result,
    }
}

fn open_label(service: &Service, identity: &(JsString, Value), entry: &Value) -> Result<Value> {
    let mut record = entry
        .as_object()
        .context("Council inventory entry")?
        .clone();
    let protection = record
        .shift_remove(&JsString::from("titleProtection"))
        .context("Council inventory label")?;
    let revision = protection["protectedLabel"]["keyRevision"]
        .as_u64()
        .context("Council inventory label revision")?;
    let kind = if entry["kind"] == "project" {
        "project"
    } else {
        "chat"
    };
    let title = match service.bound_component("private-surface-metadata", Some(revision)) {
        Ok(key) => {
            ensure!(
                key.owner_id == identity.0 && key.server_id == identity.1,
                "The worker binding changed during Council discovery."
            );
            decrypt_private_label(&key.component.key,
                    &json!({"ownerId":key.owner_id,"keyRevision":revision,"recordKind":kind,"rowId":entry["id"]}),
                    &protection).unwrap_or(Value::Null)
        }
        Err(error) if error.code == Some("missing-scope") => Value::Null,
        Err(error) => return Err(error.into()),
    };
    record.insert("title".into(), title);
    Ok(Value::Object(record))
}
