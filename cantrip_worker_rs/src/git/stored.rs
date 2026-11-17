//! Read existing Node operation records before dispatching a Git query. No
//! journal is rewritten, discarded, or inferred inactive by this adapter.
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{Value, parse_json_text, value::json};
use sha2::{Digest, Sha256};
use std::path::Path;
pub async fn read(
    directory: &Path,
    command: &Value,
    owner: &Value,
    worker: &Value,
) -> Result<Option<Value>> {
    let key = json!([
        command["serverId"].clone(),
        owner.clone(),
        worker.clone(),
        command["projectId"].clone(),
        command["worktreeId"].clone()
    ])
    .stringify();
    let digest = Sha256::digest(key.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let bytes = match tokio::fs::read(
        directory
            .join("repository-operations")
            .join(format!("{digest}.json")),
    )
    .await
    {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => bail!("Stored repository operation is invalid."),
    };
    let record = (|| -> Result<Value> {
        let input = parse_json_text(&String::from_utf8_lossy(&bytes))
            .map_err(|_| anyhow::anyhow!("Invalid stored JSON"))?;
        let record = checked("gitManagedOperationRecordSchema", &input)?;
        if record["projectId"] != command["projectId"]
            || record["worktreeId"] != command["worktreeId"]
            || record["workerId"] != *worker
        {
            bail!("Wrong scope");
        }
        Ok(record)
    })()
    .map_err(|_| anyhow::anyhow!("Stored repository operation is invalid."))?;
    Ok(Some(record))
}
