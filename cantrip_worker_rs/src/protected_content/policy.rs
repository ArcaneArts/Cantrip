//! Open the existing policy field format at the endpoint using a verified grant.
use crate::encryption::Service;
use anyhow::{Context, Result};
use cantrip_crypto::content::decrypt_secret;
use cantrip_wire::{Value, value::json};

pub(crate) fn open_policy_summary(
    encryption: &Service,
    id: &Value,
    opaque: &Value,
) -> Result<Value> {
    open_policy(
        encryption,
        id,
        opaque,
        "protected_summary",
        "policyProtectedSummaryContentSchema",
        8 * 1024,
    )
}

pub(crate) fn open_policy_body(encryption: &Service, id: &Value, opaque: &Value) -> Result<Value> {
    open_policy(
        encryption,
        id,
        opaque,
        "protected_body",
        "policyProtectedBodyContentSchema",
        128 * 1024,
    )
}

fn open_policy(
    encryption: &Service,
    id: &Value,
    opaque: &Value,
    field: &str,
    schema: &str,
    limit: usize,
) -> Result<Value> {
    let revision = opaque["keyRevision"]
        .as_u64()
        .context("Policy key revision")?;
    let grant = encryption.bound_component("policy-content", Some(revision))?;
    let binding = json!({
        "ownerId":grant.owner_id, "component":"policy-content", "table":"policies",
        "rowId":id, "field":field, "keyRevision":grant.component.key_revision,
    });
    decrypt_secret(&grant.component.key, &binding, opaque, schema, Some(limit))
}

/// Keep Core's order and resolve the private policy key to its opaque ID
/// before asking Core for the body.
pub(crate) struct EffectivePolicies {
    records: Vec<Value>,
    view: Value,
}

impl EffectivePolicies {
    pub(crate) fn open(encryption: &Service, opaque: &Value) -> Result<Self> {
        let wire = crate::http::checked("effectivePolicyWireListSchema", opaque)?;
        let records = wire["policies"]
            .as_array()
            .context("Effective policy list")?
            .clone();
        let view = records
            .iter()
            .map(|record| {
                let summary =
                    open_policy_summary(encryption, &record["id"], &record["protectedSummary"])?;
                Ok(json!({
                    "key":summary["key"], "name":summary["name"], "summary":summary["summary"],
                    "mandatory":record["mandatory"], "sources":record["sources"],
                }))
            })
            .collect::<Result<Vec<_>>>()?;
        let view = crate::http::checked("policyCliListResultSchema", &json!({"policies":view}))?;
        Ok(Self { records, view })
    }

    pub(crate) fn summaries(&self) -> &[Value] {
        self.view["policies"].as_array().unwrap()
    }

    pub(crate) fn identifier(&self, key: &Value) -> Option<&Value> {
        self.summaries()
            .iter()
            .position(|record| record["key"] == *key)
            .map(|index| &self.records[index]["id"])
    }

    pub(crate) fn summary(&self) -> String {
        let count = self.records.len();
        let plural = if count == 1 { "policy" } else { "policies" };
        format!("Found {count} effective {plural}.")
    }

    pub(crate) fn into_view(self) -> Value {
        self.view
    }
}

pub(crate) fn open_policy_detail(
    encryption: &Service,
    id: &Value,
    key: &Value,
    opaque: &Value,
) -> Result<Value> {
    let wire = crate::http::checked("policyCliWireReadResultSchema", opaque)?;
    let policy = &wire["policy"];
    anyhow::ensure!(
        &policy["id"] == id,
        "The policy read returned a different policy."
    );
    let content = &policy["content"];
    let summary = open_policy_summary(encryption, id, &content["protectedSummary"])?;
    anyhow::ensure!(
        &summary["key"] == key,
        "The policy key changed while reading its content."
    );
    let body = open_policy_body(encryption, id, &content["protectedBody"])?;
    crate::http::checked(
        "policyCliReadResultSchema",
        &json!({"policy":json!({
            "key":summary["key"], "name":summary["name"], "summary":summary["summary"],
            "bodyMarkdown":body["bodyMarkdown"],
        })}),
    )
}
