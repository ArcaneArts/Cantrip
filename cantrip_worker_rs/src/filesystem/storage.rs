use super::paths;
use anyhow::{Result, bail};
use cantrip_wire::{JsString, Value, value::json};
use std::path::{Path, PathBuf};

pub struct WorkspaceRoot {
    pub display_prefix: Option<PathBuf>,
    pub root: PathBuf,
}
pub struct FolderLocation {
    pub display_path: PathBuf,
    pub root: PathBuf,
    pub target: PathBuf,
}
fn uuid(value: &JsString) -> Option<String> {
    let text = value.as_str()?;
    let bytes = text.as_bytes();
    if bytes.len() != 36
        || !bytes.iter().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                *b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
        || !(b'1'..=b'8').contains(&bytes[14])
        || !b"89abAB".contains(&bytes[19])
    {
        return None;
    }
    Some(text.to_ascii_lowercase())
}
pub fn workspace_root(data: &Path, storage: &Value) -> Result<WorkspaceRoot> {
    if storage["kind"] != "managed" {
        return Ok(WorkspaceRoot {
            display_prefix: None,
            root: paths::resolve(data)?,
        });
    }
    let id = storage["workspaceId"]
        .as_js_string()
        .and_then(uuid)
        .ok_or_else(|| anyhow::anyhow!("Managed workspace storage requires a workspace UUID."))?;
    let parent = paths::resolve(data)?.join("workspaces");
    let root = parent.join(&id);
    if root.parent() != Some(parent.as_path()) {
        bail!("Managed workspace root escaped worker storage.");
    }
    Ok(WorkspaceRoot {
        display_prefix: Some(PathBuf::from("workspaces").join(&id)),
        root,
    })
}
pub fn folder_location(data: &Path, project: &JsString, storage: &Value) -> Result<FolderLocation> {
    let id = uuid(project)
        .ok_or_else(|| anyhow::anyhow!("Managed folder commands require a project UUID."))?;
    let workspace = workspace_root(data, storage)?;
    let root = workspace.root.join("folders");
    let target = root.join(&id);
    if target.parent() != Some(root.as_path()) {
        bail!("Managed folder target escaped its storage root.");
    }
    let display_path = workspace
        .display_prefix
        .unwrap_or_default()
        .join("folders")
        .join(id);
    Ok(FolderLocation {
        display_path,
        root,
        target,
    })
}
impl FolderLocation {
    pub fn value(&self) -> Value {
        json!({"displayPath":paths::text(&self.display_path),"root":paths::text(&self.root),"target":paths::text(&self.target)})
    }
}
fn safe_segment(value: &JsString) -> bool {
    !value.is_empty()
        && value != &JsString::from(".")
        && value != &JsString::from("..")
        && !value.units().iter().any(|u| [47, 92].contains(u))
}
pub async fn make_directory(path: &Path, recursive: bool) -> std::io::Result<()> {
    let mut builder = tokio::fs::DirBuilder::new();
    builder.recursive(recursive);
    #[cfg(unix)]
    {
        builder.mode(0o700);
    }
    builder.create(path).await
}
pub async fn ensure_workspace_directory(
    data: &Path,
    storage: &Value,
    segments: &[JsString],
) -> Result<PathBuf> {
    if storage["kind"] != "managed" {
        let mut path = data.to_owned();
        for segment in segments {
            path.push(paths::native(segment));
        }
        return Ok(paths::resolve(&path)?);
    }
    if segments.iter().any(|value| !safe_segment(value)) {
        bail!("Managed workspace storage contains an unsafe path segment.");
    }
    let workspace = workspace_root(data, storage)?;
    make_directory(data, true).await?;
    let mut current = paths::canonical(data).await?;
    let lexical_base = paths::resolve(data)?;
    let relative = workspace.root.strip_prefix(lexical_base)?;
    let mut all = relative
        .components()
        .map(|p| paths::text(Path::new(p.as_os_str())))
        .collect::<Vec<_>>();
    all.extend_from_slice(segments);
    for segment in all {
        if !safe_segment(&segment) {
            bail!("Managed workspace storage contains an unsafe path segment.");
        }
        let next = current.join(paths::native(&segment));
        match make_directory(&next, false).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        let entry = tokio::fs::symlink_metadata(&next).await?;
        if !entry.is_dir() || entry.file_type().is_symlink() {
            bail!("Managed workspace storage contains an unsafe directory boundary.");
        }
        let canonical = paths::canonical(&next).await?;
        if canonical.parent() != Some(current.as_path()) {
            bail!("Managed workspace storage escaped worker storage.");
        }
        current = canonical;
    }
    Ok(current)
}
