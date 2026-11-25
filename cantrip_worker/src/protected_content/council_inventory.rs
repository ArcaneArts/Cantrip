use crate::{encryption::Service, http::checked};
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
    result["entries"] = json!(entries.iter().map(|entry| {
        let mut record = entry.as_object().context("Council inventory entry")?.clone();
        let protection = record.shift_remove(&JsString::from("titleProtection")).context("Council inventory label")?;
        let revision = protection["protectedLabel"]["keyRevision"].as_u64().context("Council inventory label revision")?;
        let kind = if entry["kind"] == "project" { "project" } else { "chat" };
        let title = match service.bound_component("private-surface-metadata", Some(revision)) {
            Ok(key) => {
                ensure!(key.owner_id == identity.0 && key.server_id == identity.1, "The worker binding changed during Council discovery.");
                decrypt_private_label(&key.component.key,
                    &json!({"ownerId":key.owner_id,"keyRevision":revision,"recordKind":kind,"rowId":entry["id"]}),
                    &protection).unwrap_or(Value::Null)
            }
            Err(error) if error.code == Some("missing-scope") => Value::Null,
            Err(error) => return Err(error.into()),
        };
        record.insert("title".into(), title);
        Ok(Value::Object(record))
    }).collect::<Result<Vec<_>>>()?);
    ensure!(
        &service.bound_identity()? == identity,
        "The worker binding changed during Council discovery."
    );
    checked("councilInventoryResultSchema", &result)
}
