use super::release::{BINARY, BINARY_LIMIT, Release, Version, is_digest};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{Value, parse_json_text, value::json};
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Installed {
    pub version: Version,
    pub checksum: String,
    pub size: u64,
}

impl From<&Release> for Installed {
    fn from(release: &Release) -> Self {
        Self {
            version: release.version,
            checksum: release.checksum.clone(),
            size: release.size,
        }
    }
}

impl Installed {
    fn read(value: &Value) -> Result<Self> {
        Ok(Self {
            version: Version::parse(
                value["version"]
                    .as_str()
                    .context("Missing installed version.")?,
            )?,
            checksum: value["checksum"]
                .as_str()
                .filter(|value| is_digest(value))
                .context("Invalid installed checksum.")?
                .to_owned(),
            size: value["size"]
                .as_u64()
                .filter(|size| (1..=BINARY_LIMIT).contains(size))
                .context("Invalid installed binary size.")?,
        })
    }

    fn wire(&self) -> Value {
        json!({"version": self.version.to_string(), "checksum": self.checksum, "size": self.size})
    }
}

pub(super) struct Pointer {
    pub active: Installed,
    pub previous: Option<Installed>,
}

pub(super) struct Storage {
    pub root: PathBuf,
}

impl Storage {
    pub fn new(data: &Path) -> Self {
        Self {
            root: data.join("managed-runtimes").join("claude-code"),
        }
    }

    pub fn prepare(&self) -> Result<()> {
        private(
            self.root
                .parent()
                .context("Missing runtime parent directory.")?,
        )?;
        private(&self.root)?;
        for name in ["versions", "staging", "leases", "profiles"] {
            private(&self.root.join(name))?;
        }
        Ok(())
    }

    pub async fn lock(&self, name: &str) -> Result<File> {
        let file = lock_file(&self.root.join(name))?;
        tokio::time::timeout(Duration::from_secs(250), async {
            loop {
                match file.try_lock() {
                    Ok(()) => return Ok(file),
                    Err(TryLockError::WouldBlock) => {
                        tokio::time::sleep(Duration::from_millis(100)).await
                    }
                    Err(TryLockError::Error(error)) => return Err(error),
                }
            }
        })
        .await
        .context("Timed out waiting for Claude Code installation.")?
        .map_err(Into::into)
    }

    pub fn read(&self) -> Result<Option<Pointer>> {
        let path = self.root.join("current.json");
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            result => ensure!(
                result?.is_file(),
                "Invalid Claude Code installation pointer."
            ),
        }
        let mut text = String::new();
        File::open(path)?.take(4097).read_to_string(&mut text)?;
        ensure!(
            text.len() <= 4096,
            "Claude Code installation pointer is too large."
        );
        let value = parse_json_text(&text)
            .map_err(|_| anyhow::anyhow!("Invalid Claude Code installation pointer."))?;
        ensure!(
            value["schemaVersion"] == 1,
            "Unsupported Claude Code installation pointer."
        );
        Ok(Some(Pointer {
            active: Installed::read(&value["active"])?,
            previous: value
                .get("previous")
                .filter(|value| !value.is_null())
                .map(Installed::read)
                .transpose()?,
        }))
    }

    pub fn write(&self, pointer: &Pointer) -> Result<()> {
        let previous = pointer
            .previous
            .as_ref()
            .map(Installed::wire)
            .unwrap_or(Value::Null);
        let value =
            json!({"schemaVersion": 1, "active": pointer.active.wire(), "previous": previous});
        let mut file = tempfile::NamedTempFile::new_in(&self.root)?;
        file.write_all(value.stringify().as_bytes())?;
        file.as_file().sync_all()?;
        file.persist(self.root.join("current.json"))?;
        Ok(())
    }

    pub fn stage(&self) -> Result<tempfile::TempDir> {
        Ok(tempfile::tempdir_in(self.root.join("staging"))?)
    }

    fn version_dir(&self, version: &Installed) -> PathBuf {
        self.root.join("versions").join(&version.checksum)
    }

    pub fn binary(&self, version: &Installed) -> Result<PathBuf> {
        let directory = self.version_dir(version);
        ensure!(
            fs::symlink_metadata(&directory)?.is_dir(),
            "Invalid Claude Code version directory."
        );
        let binary = directory.join(BINARY);
        let metadata = fs::symlink_metadata(&binary)?;
        ensure!(
            metadata.is_file() && metadata.len() == version.size,
            "Invalid installed Claude Code binary."
        );
        Ok(crate::filesystem::paths::canonical_sync(&binary)?)
    }

    pub fn promote(&self, stage: &Path, version: &Installed) -> Result<()> {
        let destination = self.version_dir(version);
        // An interrupted activation may already have left the verified version on disk.
        if destination.try_exists()? {
            let _lease = self
                .exclusive_lease(&version.checksum)?
                .context("The Claude Code version is still in use.")?;
            ensure!(
                fs::symlink_metadata(&destination)?.is_dir(),
                "Invalid Claude Code version directory."
            );
            fs::remove_dir_all(&destination)?;
        }
        fs::rename(stage, destination)?;
        Ok(())
    }

    pub fn lease(&self, version: &Installed) -> Result<File> {
        let file = lock_file(&self.root.join("leases").join(&version.checksum))?;
        file.try_lock_shared()?;
        Ok(file)
    }

    fn exclusive_lease(&self, checksum: &str) -> Result<Option<File>> {
        let file = lock_file(&self.root.join("leases").join(checksum))?;
        match file.try_lock() {
            Ok(()) => Ok(Some(file)),
            Err(TryLockError::WouldBlock) => Ok(None),
            Err(TryLockError::Error(error)) => Err(error.into()),
        }
    }

    pub fn cleanup(&self, pointer: &Pointer) -> Result<()> {
        for entry in fs::read_dir(self.root.join("versions"))? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(checksum) = name.to_str().filter(|name| is_digest(name)) else {
                continue;
            };
            if !entry.file_type()?.is_dir()
                || checksum == pointer.active.checksum
                || pointer
                    .previous
                    .as_ref()
                    .is_some_and(|version| checksum == version.checksum)
            {
                continue;
            }
            if let Some(lease) = self.exclusive_lease(checksum)? {
                fs::remove_dir_all(entry.path())?;
                // The caller holds the installation lock while acquiring and deleting leases.
                drop(lease);
                fs::remove_file(self.root.join("leases").join(checksum))?;
            }
        }
        let cutoff = Duration::from_secs(10 * 60);
        for entry in fs::read_dir(self.root.join("staging"))? {
            let entry = entry?;
            if entry.file_type()?.is_dir()
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with(".tmp"))
                && entry
                    .metadata()?
                    .modified()?
                    .elapsed()
                    .is_ok_and(|age| age >= cutoff)
            {
                fs::remove_dir_all(entry.path())?;
            }
        }
        Ok(())
    }
}

pub(super) fn private(path: &Path) -> Result<()> {
    cantrip_host::files::private_directory(path)?;
    ensure!(
        fs::symlink_metadata(path)?.is_dir(),
        "Claude Code storage is not a regular directory."
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn lock_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    Ok(options.open(path)?)
}
