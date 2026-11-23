use super::{Root, files, library};
use crate::filesystem::paths;
use anyhow::{Context, Result, ensure};
use cantrip_wire::{Value, value::json};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

pub(super) fn write(
    roots: &[Root],
    request: &Value,
    check: impl Fn() -> Result<()>,
) -> Result<Value> {
    let content = request["content"]
        .as_js_string()
        .context("Missing skill content.")?
        .lossy();
    ensure!(
        content.len() as u64 <= library::MAX_SKILL_BYTES,
        "Skill files must be 1 MB or smaller."
    );
    ensure!(
        !content.contains('\0'),
        "Binary content cannot be written through the skill editor."
    );
    let (_, skill) = files::select(roots, &request["skillId"], true)?;
    let file = files::file_path(&skill.canonical, &request["file"])?;
    let (_, metadata) = files::open_regular(&file)?;
    if paths::equal(&file, &skill.canonical.join("SKILL.md")) {
        validate_manifest(&content)?;
    }
    let mut staged = tempfile::NamedTempFile::new_in(
        file.parent()
            .context("The skill file has no parent directory.")?,
    )?;
    staged.write_all(content.as_bytes())?;
    staged.as_file().set_permissions(metadata.permissions())?;
    staged.as_file().sync_all()?;
    ensure!(
        paths::equal(&skill.canonical, &paths::canonical_sync(&skill.directory)?)
            && paths::equal(
                &file,
                &files::file_path(&skill.canonical, &request["file"])?
            )
            && unchanged(&metadata, &file.symlink_metadata()?)?,
        "The skill file changed during the edit."
    );
    check()?;
    staged.persist(&file).map_err(|error| error.error)?;
    Ok(json!({"changed":true,"recoveryPath":Value::Null}))
}

fn validate_manifest(content: &str) -> Result<()> {
    let (name, description) = files::frontmatter(content);
    let (Some(name), Some(description)) = (name, description) else {
        anyhow::bail!("SKILL.md must include non-empty name and description frontmatter.");
    };
    ensure!(
        name.encode_utf16().count() <= 64,
        "The skill name must be 64 characters or fewer."
    );
    ensure!(
        description.encode_utf16().count() <= 1_024,
        "The skill description must be 1,024 characters or fewer."
    );
    Ok(())
}

pub(super) fn delete(
    roots: &[Root],
    input: &Value,
    data: &Path,
    check: impl Fn() -> Result<()>,
) -> Result<Value> {
    let (_, skill) = files::select(roots, &input["skillId"], true)?;
    let recovery = data
        .join("skill-recovery")
        .join(chrono::Utc::now().format("%Y-%m-%d").to_string());
    cantrip_host::files::private_directory(&recovery)?;
    let name = skill
        .directory
        .file_name()
        .context("The skill directory has no name.")?;
    let mut name = name.to_os_string();
    name.push(format!("-{}", uuid::Uuid::new_v4()));
    let destination = recovery.join(name);
    let source = &skill.directory;
    ensure!(
        paths::equal(&skill.canonical, &paths::canonical_sync(source)?)
            && !library::is_link(&source.symlink_metadata()?),
        "The skill directory changed before deletion."
    );
    check()?;
    match cantrip_host::publish::directory(source, &destination) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::CrossesDevices => {
            copy_then_retire(source, &destination, check)?
        }
        Err(error) => return Err(error.into()),
    }
    Ok(json!({"changed":true,"recoveryPath":paths::text(&destination)}))
}

fn copy_then_retire(
    source: &Path,
    destination: &Path,
    check: impl Fn() -> Result<()>,
) -> Result<()> {
    let recovery = destination
        .parent()
        .context("Missing skill recovery directory.")?;
    let staging = tempfile::Builder::new()
        .prefix(".skill-recovery-")
        .tempdir_in(recovery)?;
    let contents = staging.path().join("contents");
    let root = source.symlink_metadata()?;
    ensure!(
        root.is_dir() && !library::is_link(&root),
        "The skill directory changed before recovery."
    );
    let copied = copy_tree(source, &contents)?;
    let parent = source.parent().context("Missing skill directory parent.")?;
    let retired = tempfile::Builder::new()
        .prefix(".cantrip-skill-")
        .tempdir_in(parent)?;
    check()?;
    // Publish the complete recovery tree before retiring the live name. If
    // retirement fails, the original and its recoverable copy both remain.
    cantrip_host::publish::directory(&contents, destination)?;
    for (path, metadata) in copied {
        ensure!(
            unchanged(&metadata, &path.symlink_metadata()?)?,
            "The skill directory changed during recovery."
        );
    }
    check()?;
    cantrip_host::publish::directory(source, &retired.path().join("original"))?;
    retired.close().with_context(|| format!(
        "The live skill was moved to recovery at {}, but the temporary original could not be removed.", destination.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_copy_preserves_content_and_retires_the_original() -> Result<()> {
        let fixture = tempfile::tempdir()?;
        let original = fixture.path().join("skill");
        let recovery = fixture.path().join("recovery");
        fs::create_dir_all(original.join("notes"))?;
        fs::write(original.join("notes/body.md"), b"retained")?;
        #[cfg(unix)]
        std::os::unix::fs::symlink("notes/body.md", original.join("linked"))?;
        copy_then_retire(&original, &recovery, || Ok(()))?;
        assert!(!original.exists());
        assert_eq!(fs::read(recovery.join("notes/body.md"))?, b"retained");
        #[cfg(unix)]
        assert_eq!(
            fs::read_link(recovery.join("linked"))?,
            Path::new("notes/body.md")
        );
        Ok(())
    }

    #[test]
    fn losing_authority_before_retirement_preserves_live_and_recovery_trees() -> Result<()> {
        let fixture = tempfile::tempdir()?;
        let original = fixture.path().join("skill");
        let recovery = fixture.path().join("recovery");
        fs::create_dir(&original)?;
        fs::write(original.join("SKILL.md"), b"retained")?;
        let checks = std::cell::Cell::new(0);
        assert!(
            copy_then_retire(&original, &recovery, || {
                checks.set(checks.get() + 1);
                ensure!(checks.get() == 1, "test binding revoked");
                Ok(())
            })
            .is_err()
        );
        assert_eq!(fs::read(original.join("SKILL.md"))?, b"retained");
        assert_eq!(fs::read(recovery.join("SKILL.md"))?, b"retained");
        Ok(())
    }
}

fn copy_tree(source: &Path, destination: &Path) -> Result<Vec<(PathBuf, fs::Metadata)>> {
    let mut pending = vec![(source.to_owned(), destination.to_owned())];
    let mut copied = Vec::new();
    let mut directories = Vec::new();
    while let Some((source, destination)) = pending.pop() {
        let metadata = source.symlink_metadata()?;
        if library::is_link(&metadata) {
            copy_link(&source, &destination, &metadata)?;
        } else if metadata.is_dir() {
            fs::create_dir(&destination)?;
            for entry in fs::read_dir(&source)? {
                let entry = entry?;
                pending.push((entry.path(), destination.join(entry.file_name())));
            }
            directories.push((destination, metadata.permissions()));
        } else {
            let (mut input, opened) = files::open_regular(&source)?;
            ensure!(
                unchanged(&metadata, &opened)?,
                "The skill file changed during recovery."
            );
            let mut output = cantrip_host::files::open_private(&destination)?;
            io::copy(&mut input, &mut output)?;
            output.set_permissions(metadata.permissions())?;
            output.sync_all()?;
        }
        copied.push((source, metadata));
    }
    for (directory, permissions) in directories.into_iter().rev() {
        fs::set_permissions(&directory, permissions)?;
        #[cfg(unix)]
        fs::File::open(directory)?.sync_all()?;
    }
    Ok(copied)
}

fn unchanged(previous: &fs::Metadata, current: &fs::Metadata) -> io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if previous.dev() != current.dev() || previous.ino() != current.ino() {
            return Ok(false);
        }
    }
    Ok(previous.file_type() == current.file_type()
        && previous.len() == current.len()
        && previous.modified()? == current.modified()?
        && previous.permissions() == current.permissions())
}

fn copy_link(source: &Path, target: &Path, _metadata: &fs::Metadata) -> io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(fs::read_link(source)?, target)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        let kind = _metadata.file_type();
        if kind.is_symlink_dir() {
            std::os::windows::fs::symlink_dir(fs::read_link(source)?, target)
        } else if kind.is_symlink_file() {
            std::os::windows::fs::symlink_file(fs::read_link(source)?, target)
        } else {
            junction::create(junction::get_target(source)?, target)
        }
    }
}
