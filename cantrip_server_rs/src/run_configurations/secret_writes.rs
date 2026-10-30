//! Transactional opaque-secret writes and durable operation receipts.
use super::{Repository, raw, text};
use crate::{
    database::Transaction,
    wire::{Value, value::json},
};
use anyhow::{Context, Result, ensure};
use sha2::{Digest, Sha256};

fn timestamp(row: &Value, column: &str) -> Result<Value> {
    let millis = row[column]
        .as_js_string()
        .and_then(crate::wire::date_milliseconds)
        .context("Invalid time value")?;
    Ok(Value::String(
        crate::wire::date_iso_milliseconds(millis)
            .context("Invalid time value")?
            .into(),
    ))
}
fn summary(row: &Value) -> Result<Value> {
    Ok(
        json!({"reference":row["reference"],"available":true,"revision":row["revision"],"updatedAt":timestamp(row,"updated_at")?}),
    )
}
fn replay(row: &Value, owner: &str, project: &str, input: &Value, digest: &str) -> Result<Value> {
    ensure!(
        row["owner_id"] == owner
            && row["project_id"] == project
            && row["reference"] == input["reference"]
            && row["protected_value_digest"] == digest,
        "The Run configuration secret operation identity is already in use."
    );
    ensure!(
        !row["revision"].is_null(),
        "The Run configuration secret operation is incomplete."
    );
    crate::settings::parse_response(
        "runConfigurationSecretSetResultSchema",
        Some(
            &json!({"operationId":row["id"],"projectId":row["project_id"],"replayed":true,"secret":json!({"reference":row["reference"],"available":true,"revision":row["revision"],"updatedAt":timestamp(row,"created_at")?})}),
        ),
    )
}
async fn receipt(tx: &Transaction<'_>, id: &str) -> Result<Option<Value>> {
    tx.query(
        "SELECT to_jsonb(o)::text FROM run_configuration_secret_operations o WHERE id=$1 LIMIT 1",
        &[&id],
    )
    .await?
    .first()
    .map(|row| raw(row.get(0)?))
    .transpose()
}
impl Repository {
    pub async fn list_secret_summaries(&self, owner: &str, project: &str) -> Result<Value> {
        let rows=self.database.query("SELECT to_jsonb(s)::text FROM run_configuration_secrets s INNER JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 WHERE s.project_id=$2 ORDER BY s.reference ASC LIMIT 256", &[&owner,&project]).await?;
        let values = rows
            .iter()
            .map(|row| summary(&raw(row.get(0)?)?))
            .collect::<Result<Vec<_>>>()?;
        crate::settings::parse_response(
            "runConfigurationSecretSummaryListSchema",
            Some(&Value::Array(values)),
        )
    }
    pub async fn set_secret(&self, owner: &str, project: &str, input: &Value) -> Result<Value> {
        let input =
            crate::settings::parse_response("runConfigurationSecretSetRequestSchema", Some(input))?;
        // Hash the parsed protocol object using JavaScript-compatible property
        // order and serialization, before PostgreSQL JSONB reorders its keys.
        let digest = format!(
            "{:x}",
            Sha256::digest(input["protectedValue"].stringify().as_bytes())
        );
        let (owner, project) = (owner.to_owned(), project.to_owned());
        self.database
            .transaction(|tx| Box::pin(write(tx, owner, project, input, digest)))
            .await
    }
}
async fn write(
    tx: &Transaction<'_>,
    owner: String,
    project: String,
    input: Value,
    digest: String,
) -> Result<Value> {
    let id = text(&input, "operationId")?;
    if let Some(row) = receipt(tx, id).await? {
        return replay(&row, &owner, &project, &input, &digest);
    }
    let now = crate::auth::now();
    let reference = text(&input, "reference")?;
    let claimed=tx.query("INSERT INTO run_configuration_secret_operations(id,owner_id,project_id,reference,revision,protected_value_digest,created_at) VALUES($1,$2,$3,$4,NULL,$5,$6) ON CONFLICT(id) DO NOTHING RETURNING id", &[&id,&owner,&project,&reference,&digest,&now]).await?;
    if claimed.is_empty() {
        let row = receipt(tx, id)
            .await?
            .context("Could not recover the Run configuration secret operation.")?;
        return replay(&row, &owner, &project, &input, &digest);
    }
    ensure!(
        !tx.query(
            "SELECT id FROM projects WHERE id=$1 AND owner_id=$2 LIMIT 1",
            &[&project, &owner]
        )
        .await?
        .is_empty(),
        "The Run configuration secret project was not found."
    );
    let protected = input["protectedValue"].stringify();
    let secret_id = uuid::Uuid::new_v4().to_string();
    let rows=tx.query("INSERT INTO run_configuration_secrets(id,owner_id,project_id,reference,protected_value,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5::text::jsonb,1,$6,$6) ON CONFLICT(project_id,reference) DO UPDATE SET owner_id=EXCLUDED.owner_id,protected_value=EXCLUDED.protected_value,revision=run_configuration_secrets.revision+1,updated_at=EXCLUDED.updated_at RETURNING to_jsonb(run_configuration_secrets)::text", &[&secret_id,&owner,&project,&reference,&protected,&now]).await?;
    let secret = raw(rows
        .first()
        .context("Could not store the Run configuration secret.")?
        .get(0)?)?;
    let revision = i32::try_from(secret["revision"].as_i64().context("Secret revision")?)?;
    ensure!(!tx.query("UPDATE run_configuration_secret_operations SET revision=$1 WHERE id=$2 AND revision IS NULL RETURNING id", &[&revision,&id]).await?.is_empty(),"Could not complete the Run configuration secret operation.");
    crate::settings::parse_response(
        "runConfigurationSecretSetResultSchema",
        Some(
            &json!({"operationId":id,"projectId":project,"replayed":false,"secret":summary(&secret)?}),
        ),
    )
}
