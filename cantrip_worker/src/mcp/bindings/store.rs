use super::{Attachment, Entry};
use anyhow::{Result, anyhow};
use cantrip_wire::{JsString, Value};
use std::{
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};
use subtle::ConstantTimeEq;

pub(super) fn authorized(header: Option<&str>, credential: &JsString) -> bool {
    let Some(token) = header.and_then(|value| value.strip_prefix("Bearer ")) else {
        return false;
    };
    let expected = credential
        .as_str()
        .expect("generated ASCII broker credential");
    token.len() == expected.len() && bool::from(token.as_bytes().ct_eq(expected.as_bytes()))
}

pub(super) fn publish(attachment: &Attachment) -> Result<()> {
    let parent = attachment
        .connection_path
        .parent()
        .ok_or_else(|| anyhow!("Missing MCP binding directory."))?;
    cantrip_host::files::private_directory(parent)?;
    let mut file = tempfile::Builder::new()
        .prefix(".connection-")
        .suffix(".tmp")
        .tempfile_in(parent)?;
    writeln!(file, "{}", attachment.connection.stringify_pretty())?;
    file.as_file().sync_all()?;
    file.persist(&attachment.connection_path)
        .map_err(|error| error.error)?;
    Ok(())
}

pub(super) fn connection_path(data: &Path, binding: &str) -> PathBuf {
    data.join("agent-mcp-bindings")
        .join(binding)
        .join("connection.json")
}

pub(super) fn remove(entry: &Entry) -> Result<()> {
    let path = &entry.attachment.connection_path;
    if let Err(error) = std::fs::remove_file(path)
        && error.kind() != ErrorKind::NotFound
    {
        return Err(error.into());
    }
    if let Some(directory) = path.parent()
        && let Err(error) = std::fs::remove_dir(directory)
        && !matches!(
            error.kind(),
            ErrorKind::NotFound | ErrorKind::DirectoryNotEmpty
        )
    {
        return Err(error.into());
    }
    Ok(())
}

pub(super) fn same_scope(left: &Value, right: &Value) -> bool {
    [
        "ownerId",
        "contextKind",
        "projectId",
        "scratchRootId",
        "chatId",
        "workerId",
    ]
    .iter()
    .all(|key| left[*key] == right[*key])
}
