use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Entry {
    #[serde(with = "portable_path")]
    pub path: PathBuf,
    pub directory: bool,
    pub bytes: u64,
    pub sha256: String,
    pub executable: bool,
    pub modified_nanos: Option<u64>,
}
mod portable_path {
    use super::*;
    use serde::{Deserializer, Serializer, de::Error as _, ser::Error as _};
    pub fn serialize<S: Serializer>(
        path: &Path,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        let pieces = path
            .components()
            .map(|component| match component {
                Component::Normal(value) => value
                    .to_str()
                    .ok_or_else(|| S::Error::custom("Profile file path must be UTF-8")),
                _ => Err(S::Error::custom("Profile file path must be relative")),
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        serializer.serialize_str(&pieces.join("/"))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<PathBuf, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.contains('\\') {
            return Err(D::Error::custom("Profile path contains a separator alias"));
        }
        Ok(PathBuf::from(value))
    }
}
pub(super) fn private_directory(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}
fn reserved(path: &Path) -> bool {
    matches!(path.components().next(),Some(Component::Normal(name)) if ["server-db","postgres","server-database.json","server-profile-receipt.json"].iter().any(|value| name==*value))
}
fn safe(path: &Path) -> Result<()> {
    ensure!(
        !path.as_os_str().is_empty()
            && path.components().all(|c| matches!(c, Component::Normal(_))),
        "Profile file path must be relative"
    );
    for component in path.components() {
        let Component::Normal(name) = component else {
            unreachable!()
        };
        let name = name.to_str().context("Profile file path must be UTF-8")?;
        ensure!(
            !name.contains(['\\', ':']),
            "Profile file path contains a separator alias"
        );
    }
    ensure!(
        !reserved(path),
        "Profile file path collides with managed storage"
    );
    Ok(())
}
fn mode(file: &File, executable: bool) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(if executable {
            0o700
        } else {
            0o600
        }))?;
    }
    #[cfg(not(unix))]
    let _ = (file, executable);
    Ok(())
}
fn copy_file(source: &Path, destination: &Path, expected: Option<&Entry>) -> Result<Entry> {
    let mut input = File::open(source)?;
    let metadata = input.metadata()?;
    ensure!(metadata.is_file(), "Profile asset is not a regular file");
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options.open(destination)?;
    let mut digest = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = [0; 65536];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count])?;
        digest.update(&buffer[..count]);
        bytes = bytes
            .checked_add(count as u64)
            .context("Profile file is too large")?;
    }
    let sha256 = format!("{:x}", digest.finalize());
    if let Some(entry) = expected {
        ensure!(
            bytes == entry.bytes && sha256 == entry.sha256,
            "Profile asset checksum does not match its manifest"
        );
    }
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o100 != 0
    };
    #[cfg(not(unix))]
    let executable = false;
    let executable = expected.map_or(executable, |e| e.executable);
    mode(&output, executable)?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|time| time.as_nanos().try_into().ok());
    let modified = expected.map_or(modified_nanos, |e| e.modified_nanos);
    if let Some(nanos) = modified {
        output.set_times(
            fs::FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_nanos(nanos)),
        )?;
    }
    output.sync_all()?;
    Ok(Entry {
        path: PathBuf::new(),
        directory: false,
        bytes,
        sha256,
        executable,
        modified_nanos: modified,
    })
}

/// Materialize file references into an opaque snapshot. Directory cycles are
/// actual unsnapshotable input; never recurse through our own output staging.
pub(super) fn snapshot(source: &Path, destination: &Path, staging: &Path) -> Result<Vec<Entry>> {
    private_directory(destination)?;
    let source = match source.canonicalize() {
        Ok(path) => path,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let staging = staging.canonicalize()?;
    let mut pending = vec![(source.clone(), PathBuf::new(), vec![source])];
    let mut entries = Vec::new();
    while let Some((directory, relative, ancestors)) = pending.pop() {
        for item in fs::read_dir(directory)? {
            let item = item?;
            let path = relative.join(item.file_name());
            if reserved(&path) {
                continue;
            }
            safe(&path)?;
            let location = item.path();
            let metadata = fs::metadata(&location)?;
            if metadata.is_dir() {
                let canonical = location.canonicalize()?;
                if canonical == staging {
                    continue;
                }
                ensure!(
                    !ancestors.contains(&canonical),
                    "Profile contains a cyclic directory reference"
                );
                private_directory(&destination.join(&path))?;
                entries.push(Entry {
                    path: path.clone(),
                    directory: true,
                    bytes: 0,
                    sha256: String::new(),
                    executable: false,
                    modified_nanos: None,
                });
                let mut next = ancestors.clone();
                next.push(canonical);
                pending.push((location, path, next));
            } else if metadata.is_file() {
                let mut entry = copy_file(&location, &destination.join(&path), None)?;
                entry.path = path;
                entries.push(entry);
            } else {
                bail!("Profile contains a non-file asset");
            }
        }
    }
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    #[cfg(unix)]
    for entry in entries.iter().rev().filter(|e| e.directory) {
        File::open(destination.join(&entry.path))?.sync_all()?;
    }
    Ok(entries)
}
pub(super) fn restore(source: &Path, destination: &Path, entries: &[Entry]) -> Result<()> {
    let mut seen = std::collections::HashSet::new();
    for entry in entries {
        safe(&entry.path)?;
        ensure!(seen.insert(&entry.path), "Duplicate profile file path");
    }
    for entry in entries {
        let target = destination.join(&entry.path);
        if entry.directory {
            private_directory(&target)?;
        } else {
            private_directory(target.parent().context("Profile asset parent")?)?;
            copy_file(&source.join(&entry.path), &target, Some(entry))?;
        }
    }
    // Directory entries and each file are durable before the profile is exposed.
    #[cfg(unix)]
    for entry in entries.iter().rev().filter(|e| e.directory) {
        File::open(destination.join(&entry.path))?.sync_all()?;
    }
    Ok(())
}
pub(super) fn digest_copy(source: &Path, destination: &Path) -> Result<(u64, String)> {
    let entry = copy_file(source, destination, None)?;
    Ok((entry.bytes, entry.sha256))
}
pub(super) fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
