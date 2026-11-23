use crate::filesystem::{explorer::io_error, paths, storage};
use anyhow::Result;
use cantrip_wire::{Value, parse_json_text};
use std::{
    io::Write,
    path::{Path, PathBuf},
};
pub(super) async fn entry(path: &Path) -> Result<Option<std::fs::Metadata>> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(io_error("lstat", path, error)),
    }
}
pub(super) fn permission(error: &anyhow::Error) -> bool {
    error.downcast_ref::<std::io::Error>().is_some_and(|e| {
        e.kind() == std::io::ErrorKind::PermissionDenied
            || e.kind() == std::io::ErrorKind::ReadOnlyFilesystem
    }) || ["EACCES:", "EPERM:", "EROFS:"]
        .iter()
        .any(|prefix| error.to_string().starts_with(prefix))
}
pub(super) fn link_type(path: &Path, metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        // Unlike exists(), get_target() also recognizes a broken junction.
        metadata.file_type().is_symlink() || junction::get_target(path).is_ok()
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        metadata.file_type().is_symlink()
    }
}
pub(super) async fn mkdir(path: &Path, recursive: bool) -> Result<()> {
    storage::make_directory(path, recursive)
        .await
        .map_err(|e| io_error("mkdir", path, e))
}
pub(super) async fn canonical(path: &Path) -> Result<PathBuf> {
    paths::canonical(path)
        .await
        .map_err(|e| io_error("realpath", path, e))
}
pub(super) async fn parse(path: &Path) -> Result<Value> {
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| io_error("open", path, e))?;
    parse_json_text(&String::from_utf8_lossy(&bytes)).map_err(|e| crate::error::WireError(e).into())
}
pub(super) async fn exclusive(path: &Path, value: &Value) -> Result<()> {
    let target = path.to_owned();
    let bytes = format!("{}\n", value.stringify());
    tokio::task::spawn_blocking(move || {
        let mut file =
            cantrip_host::files::open_private(&target).map_err(|e| io_error("open", &target, e))?;
        file.write_all(bytes.as_bytes())
            .map_err(|e| io_error("write", &target, e))
    })
    .await?
}
pub(super) async fn publish(path: &Path, value: &Value) -> Result<()> {
    let temporary = path.with_file_name(format!(
        "{}.{}.tmp",
        path.file_name().unwrap().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    exclusive(&temporary, value).await?;
    tokio::fs::rename(&temporary, path)
        .await
        .map_err(|e| io_error("rename", &temporary, e))
}
pub(super) async fn remove(path: &Path, recursive: bool) -> Result<()> {
    let result = if recursive {
        match tokio::fs::symlink_metadata(path).await {
            Ok(metadata) if metadata.is_dir() && !link_type(path, &metadata) => {
                tokio::fs::remove_dir_all(path).await
            }
            Ok(_) => unlink_raw(path).await,
            Err(e) => Err(e),
        }
    } else {
        unlink_raw(path).await
    };
    match result {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_error(
            if recursive { "rmdir" } else { "unlink" },
            path,
            e,
        )),
    }
}
pub(super) async fn unlink_raw(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        let metadata = tokio::fs::symlink_metadata(path).await?;
        if metadata.file_type().is_symlink_dir() || junction::get_target(path).is_ok() {
            // Remove the directory entry itself; deleting only the reparse
            // metadata leaves an empty directory and breaks replay/repair.
            return tokio::fs::remove_dir(path).await;
        }
    }
    tokio::fs::remove_file(path).await
}
pub(super) async fn unlink(path: &Path) -> Result<()> {
    unlink_raw(path)
        .await
        .map_err(|e| io_error("unlink", path, e))
}
pub(super) async fn directory_link(target: &Path, link: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        tokio::fs::symlink(target, link).await
    }
    #[cfg(windows)]
    {
        let target = target.to_owned();
        let link = link.to_owned();
        tokio::task::spawn_blocking(move || junction::create(target, link))
            .await
            .map_err(std::io::Error::other)?
    }
}
