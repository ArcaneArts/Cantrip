//! Scoped, Node-compatible managed-operation records and atomic publication.
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{Value, parse_json_text, value::json};
use sha2::{Digest, Sha256};
use std::path::Path;
pub fn active(record: Option<&Value>) -> bool {
    record.is_some_and(|record| {
        !matches!(
            record["state"].as_str(),
            Some("completed" | "failed" | "aborted")
        )
    })
}
pub async fn read(
    directory: &Path,
    command: &Value,
    owner: &Value,
    worker: &Value,
) -> Result<Option<Value>> {
    let destination = destination(directory, command, owner, worker);
    let bytes = match tokio::fs::read(destination).await {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => bail!("Stored repository operation is invalid."),
    };
    let record = (|| -> Result<Value> {
        let input = parse_json_text(&String::from_utf8_lossy(&bytes))
            .map_err(|_| anyhow::anyhow!("Invalid stored JSON"))?;
        let record = checked("gitManagedOperationRecordSchema", &input)?;
        if !matches_scope(&record, command, worker) {
            bail!("Wrong scope");
        }
        Ok(record)
    })()
    .map_err(|_| anyhow::anyhow!("Stored repository operation is invalid."))?;
    Ok(Some(record))
}
fn destination(
    directory: &Path,
    command: &Value,
    owner: &Value,
    worker: &Value,
) -> std::path::PathBuf {
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
    directory
        .join("repository-operations")
        .join(format!("{digest}.json"))
}
fn matches_scope(record: &Value, command: &Value, worker: &Value) -> bool {
    record["projectId"] == command["projectId"]
        && record["worktreeId"] == command["worktreeId"]
        && record["workerId"] == *worker
}
pub fn record(
    command: &Value,
    worker: &Value,
    state: &Value,
    existing: Option<&Value>,
    id: Option<&Value>,
    now: Option<&str>,
) -> Result<Value> {
    let now = now.map(str::to_owned).unwrap_or_else(|| {
        cantrip_wire::date::iso_milliseconds(chrono::Utc::now().timestamp_millis()).unwrap()
    });
    let mut result = state.clone();
    result["id"] = existing
        .map(|v| v["id"].clone())
        .or_else(|| id.cloned())
        .unwrap_or_else(|| json!(uuid::Uuid::new_v4().to_string()));
    for field in ["projectId", "worktreeId"] {
        result[field] = command[field].clone();
    }
    result["workerId"] = worker.clone();
    result["error"] = Value::Null;
    result["createdAt"] = existing.map_or_else(|| json!(now.clone()), |v| v["createdAt"].clone());
    result["updatedAt"] = json!(now.clone());
    result["completedAt"] = if active(Some(state)) {
        Value::Null
    } else {
        existing
            .and_then(|v| v.get("completedAt"))
            .filter(|v| !v.is_null())
            .cloned()
            .unwrap_or_else(|| json!(now))
    };
    checked("gitManagedOperationRecordSchema", &result)
}
pub async fn put(
    directory: &Path,
    command: &Value,
    owner: &Value,
    worker: &Value,
    record: &Value,
) -> Result<()> {
    use crate::filesystem::explorer::io_error;
    let record = checked("gitManagedOperationRecordSchema", record)?;
    if !matches_scope(&record, command, worker) {
        bail!("Repository operation escaped its worker scope.");
    }
    let destination = destination(directory, command, owner, worker);
    let root = destination.parent().unwrap().to_owned();
    let temporary = destination.with_file_name(format!(
        "{}.{}.tmp",
        destination.file_name().unwrap().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let bytes = format!("{}\n", record.stringify()).into_bytes();
    let pending = temporary.clone();
    tokio::task::spawn_blocking(move || -> Result<()> {
        cantrip_host::files::private_directory(&root).map_err(|e| io_error("mkdir", &root, e))?;
        cantrip_host::files::write_private(&pending, &bytes)
            .map_err(|e| io_error("open", &pending, e))?;
        Ok(())
    })
    .await??;
    tokio::fs::rename(&temporary, &destination)
        .await
        .map_err(|e| io_error("rename", &temporary, e))?;
    Ok(())
}
