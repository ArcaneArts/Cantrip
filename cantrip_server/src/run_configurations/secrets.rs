//! Owner-scoped secret metadata and opaque envelopes used during Run admission.
use super::{Repository, raw};
use crate::wire::{Value, value::json};
use anyhow::{Context, Result};
use std::collections::HashSet;

pub fn references(document: &Value) -> Result<Vec<String>> {
    let mut references = HashSet::new();
    let mut add = |environment: &Value| {
        if let Some(secrets) = environment["secrets"].as_array() {
            for secret in secrets {
                if let Some(reference) = secret["secret"].as_str() {
                    references.insert(reference.to_owned());
                }
            }
        }
    };
    add(&document["environment"]);
    if let Some(overrides) = document["platformOverrides"].as_object() {
        for (_, value) in overrides.iter() {
            add(&value["environment"]);
        }
    }
    let collator = crate::projects::placement::collator()?;
    let mut references: Vec<_> = references.into_iter().collect();
    references.sort_by(|a, b| collator.compare(a, b));
    Ok(references)
}
fn ordered(references: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    references
        .iter()
        .filter(|value| seen.insert(*value))
        .take(256)
        .cloned()
        .collect()
}
impl Repository {
    pub async fn protected_secrets(
        &self,
        owner: &str,
        project: &str,
        references: &[String],
    ) -> Result<Vec<Value>> {
        let references = ordered(references);
        if references.is_empty() {
            return Ok(Vec::new());
        }
        let rows=self.database.query("SELECT to_jsonb(s)::text FROM run_configuration_secrets s INNER JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 WHERE s.project_id=$2 AND s.reference=ANY($3::text[]) ORDER BY s.reference ASC", &[&owner,&project,&references]).await?;
        let rows = rows
            .iter()
            .map(|row| raw(row.get(0)?))
            .collect::<Result<Vec<_>>>()?;
        let values=Value::Array(rows.iter().map(|row|json!({"reference":row["reference"],"revision":row["revision"],"protectedValue":row["protected_value"]})).collect());
        let parsed = crate::settings::parse_response(
            "runConfigurationProtectedSecretListSchema",
            Some(&values),
        )?;
        parsed
            .as_array()
            .context("Run secrets")?
            .iter()
            .zip(&rows)
            .map(|(value, row)| {
                let mut value = value.clone();
                value["updatedAt"] = Value::String(
                    crate::wire::date_iso_milliseconds(
                        row["updated_at"]
                            .as_js_string()
                            .and_then(crate::wire::date_milliseconds)
                            .context("Invalid time value")?,
                    )
                    .context("Invalid time value")?
                    .into(),
                );
                Ok(value)
            })
            .collect()
    }
    pub async fn secret_statuses(
        &self,
        owner: &str,
        project: &str,
        references: &[String],
    ) -> Result<Vec<Value>> {
        let ordered = ordered(references);
        if ordered.is_empty() {
            return Ok(Vec::new());
        }
        let records = self.protected_secrets(owner, project, &ordered).await?;
        let values=Value::Array(ordered.iter().map(|reference| {
            match records.iter().find(|record|record["reference"]==reference.as_str()) {
                Some(record)=>json!({"reference":reference,"available":true,"revision":record["revision"],"updatedAt":record["updatedAt"]}),
                None=>json!({"reference":reference,"available":false,"revision":Value::Null,"updatedAt":Value::Null}),
            }
        }).collect());
        Ok(crate::settings::parse_response(
            "runConfigurationSecretSummaryListSchema",
            Some(&values),
        )?
        .as_array()
        .context("Run secret summaries")?
        .clone())
    }
}
