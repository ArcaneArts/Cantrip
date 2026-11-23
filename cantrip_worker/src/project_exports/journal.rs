use crate::filesystem::paths;
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
};

pub(super) fn directory(root: &Path, command: &Value) -> Result<PathBuf> {
    let operation = command["operationId"]
        .as_str()
        .context("Project export operation id is invalid.")?;
    uuid::Uuid::parse_str(operation)?;
    let chat = command["chatId"]
        .as_js_string()
        .context("Missing project export chat identity.")?;
    Ok(root.join(operation).join(digest(chat.lossy().as_bytes())))
}

pub(super) fn identity(command: &Value, destination: &str) -> Result<Value> {
    let chat = command["chatId"]
        .as_js_string()
        .context("Missing project export chat identity.")?;
    let cwd = paths::native(
        command["cwd"]
            .as_js_string()
            .context("Missing project export worktree.")?,
    );
    let cwd = paths::text(&paths::resolve(&cwd)?);
    Ok(
        json!({"chatIdHash":digest(chat.lossy().as_bytes()), "cwdFingerprint":digest(cwd.lossy().as_bytes()),
        "destinationFingerprint":destination, "operationId":command["operationId"],
        "targetKind":command["target"]["kind"],"transcriptSha256":command["transcriptSha256"]}),
    )
}

pub(super) fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn read(directory: &Path, identity: &Value) -> Result<Option<Value>> {
    let path = directory.join("state.json");
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    const LIMIT: u64 = 64 * 1024;
    let mut text = String::new();
    file.take(LIMIT + 1).read_to_string(&mut text)?;
    ensure!(
        text.len() as u64 <= LIMIT,
        "Stored project export state is invalid."
    );
    let stored = parse_json_text(&text)
        .map_err(|_| anyhow::anyhow!("Stored project export state is invalid."))?;
    for field in [
        "chatIdHash",
        "cwdFingerprint",
        "destinationFingerprint",
        "operationId",
        "targetKind",
        "transcriptSha256",
    ] {
        ensure!(
            stored[field] == identity[field],
            "This project export operation is already associated with different source data."
        );
    }
    ensure!(
        matches!(stored["status"].as_str(), Some("exported" | "exporting"))
            && stored["messageCount"].as_u64().is_some()
            && stored["destinationLabel"].is_string()
            && stored["threadId"]
                .as_js_string()
                .is_some_and(|id| !id.is_empty()),
        "Stored project export state is invalid."
    );
    Ok(Some(stored))
}

pub(super) fn save(
    directory: &Path,
    identity: &Value,
    status: &str,
    thread: &JsString,
    label: &str,
    count: usize,
) -> Result<()> {
    let mut value = identity.clone();
    value["status"] = json!(status);
    value["threadId"] = json!(thread);
    value["destinationLabel"] = json!(label);
    value["messageCount"] = json!(count);
    let mut file = tempfile::Builder::new()
        .prefix(".state-")
        .tempfile_in(directory)?;
    writeln!(file, "{}", value.stringify())?;
    file.as_file().sync_all()?;
    file.persist(directory.join("state.json"))
        .map_err(|error| error.error)?;
    #[cfg(unix)]
    fs::File::open(directory)?.sync_all()?;
    Ok(())
}
