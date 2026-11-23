use super::{checked, entry, io_error, joined, markdown, modified, paths, search::Sorting};
use crate::filesystem::paths as host;
use anyhow::{Result, bail};
use cantrip_wire::{JsString, Value, value::json};
use std::path::Path;
use tokio::fs;
pub(super) async fn entries(path: &Path) -> Result<Vec<(JsString, std::fs::FileType)>> {
    let mut reader = fs::read_dir(path)
        .await
        .map_err(|e| io_error("scandir", path, e))?;
    let mut result = Vec::new();
    while let Some(entry) = reader.next_entry().await? {
        result.push((
            host::text(Path::new(&entry.file_name())),
            entry.file_type().await?,
        ));
    }
    // libuv sorts names before JS stable locale sorting, which matters when
    // primary collation considers different names equal.
    result.sort_by(|a, b| host::native(&a.0).cmp(&host::native(&b.0)));
    Ok(result)
}
pub async fn list_directory(root: &Path, relative: &JsString) -> Result<Value> {
    let (metadata, target) = paths::resolve(root, relative).await?;
    if !metadata.is_dir() {
        bail!("Explorer path is not a directory.");
    }
    let sorting = Sorting::new()?;
    let mut entries = entries(&target).await?;
    entries.retain(|(name, _)| name.as_str() != Some(".git"));
    let rank = |kind: &std::fs::FileType| {
        if kind.is_dir() || kind.is_symlink() {
            0
        } else if kind.is_file() {
            1
        } else {
            2
        }
    };
    entries.sort_by(|a, b| {
        rank(&a.1)
            .cmp(&rank(&b.1))
            .then_with(|| sorting.base(&a.0, &b.0))
    });
    let truncated = entries.len() > 1000;
    entries.truncate(1000);
    let output = futures::future::join_all(entries.into_iter().map(|(name, _)| {
        let target = target.join(host::native(&name));
        async move {
            let metadata = paths::metadata(&target).await?;
            let symbolic_link = metadata.file_type().is_symlink();
            let metadata = if symbolic_link {
                match paths::canonical(&target).await {
                    Ok(resolved) => paths::metadata(&resolved).await.unwrap_or(metadata),
                    Err(_) => metadata,
                }
            } else {
                metadata
            };
            entry(&name, &joined(relative, &name), &metadata, symbolic_link)
        }
    }))
    .await
    .into_iter()
    .collect::<Result<Vec<_>>>()?;
    checked(
        "explorerDirectorySchema",
        &json!({"path":relative,"entries":output,"truncated":truncated}),
    )
}
pub async fn create_file(root: &Path, relative: &JsString, name: &JsString) -> Result<Value> {
    let name = checked("explorerEntryNameSchema", &json!(name))?
        .as_js_string()
        .unwrap()
        .clone();
    let directory = paths::mutable_directory(root, relative).await?;
    let target = directory.join(host::native(&name));
    if paths::existing(&target).await?.is_some() {
        bail!("An entry with that name already exists.");
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    let file = match options.open(&target).await {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            bail!("An entry with that name already exists.")
        }
        Err(e) => return Err(io_error("open", &target, e)),
    };
    let mut segments = paths::segments(relative)?;
    segments.push(name.clone());
    let relative = segments
        .into_iter()
        .fold(JsString::from(""), |p, n| joined(&p, &n));
    checked(
        "explorerEntrySchema",
        &json!({"name":name,"path":relative,"kind":"file","size":0,"modifiedAt":modified(&file.metadata().await?)?,"viewable":true,"markdown":markdown(&name),"symbolicLink":false}),
    )
}
pub async fn create_directory(root: &Path, relative: &JsString) -> Result<Value> {
    let directory = paths::mutable_directory(root, relative).await?;
    for suffix in 1u64.. {
        let name: JsString = if suffix == 1 {
            "New Folder".into()
        } else {
            format!("New Folder {suffix}").into()
        };
        let target = directory.join(host::native(&name));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        builder.mode(0o700);
        match builder.create(&target).await {
            Ok(()) => {
                return checked(
                    "explorerEntrySchema",
                    &json!({"name":name,"path":joined(relative,&name),"kind":"directory","size":Value::Null,"modifiedAt":modified(&paths::metadata(&target).await?)?,"viewable":false,"markdown":false,"symbolicLink":false}),
                );
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(io_error("mkdir", &target, e)),
        }
    }
    unreachable!()
}
pub async fn rename_entry(root: &Path, relative: &JsString, name: &JsString) -> Result<Value> {
    let input = checked(
        "explorerEntryRenameSchema",
        &json!({"path":relative,"name":name}),
    )?;
    let name = input["name"].as_js_string().unwrap();
    let separator = relative
        .units()
        .iter()
        .rposition(|u| *u == 47)
        .map_or(0, |n| n + 1);
    let new_path = JsString::new([&relative.units()[..separator], name.units()].concat());
    let result = checked(
        "explorerEntryMutationResultSchema",
        &json!({"path":relative,"newPath":new_path}),
    )?;
    let (_, target) = paths::mutable_entry(root, relative).await?;
    let destination = target.parent().unwrap().join(host::native(name));
    if destination != target {
        let existing = paths::existing(&destination).await?;
        let case_only = host::text(&destination).lowercase() == host::text(&target).lowercase();
        if existing.is_some() && !case_only {
            bail!("A file or folder with that name already exists.");
        }
        fs::rename(&target, &destination)
            .await
            .map_err(|e| io_error("rename", &target, e))?;
    }
    Ok(result)
}
pub async fn delete_entry(root: &Path, relative: &JsString) -> Result<Value> {
    let (metadata, target) = paths::mutable_entry(root, relative).await?;
    if metadata.is_dir() {
        fs::remove_dir_all(&target).await?;
    } else {
        fs::remove_file(&target).await?;
    }
    checked(
        "explorerEntryMutationResultSchema",
        &json!({"path":relative,"newPath":Value::Null}),
    )
}
