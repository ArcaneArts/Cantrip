use anyhow::{Context, Result, ensure};
use cantrip_wire::{Value, parse_json_text, value::json};
use std::{
    fs::{self, File},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::sync::watch;

const LOCK_STALE: Duration = Duration::from_secs(30 * 60);
const PARTIAL_STALE: Duration = Duration::from_secs(24 * 60 * 60);
const METADATA_LIMIT: u64 = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Entry {
    pub version: String,
    pub archive: String,
}

impl Entry {
    fn read(value: &Value) -> Result<Self> {
        let version = value["version"]
            .as_js_string()
            .filter(|version| (1..=100).contains(&version.len()))
            .and_then(|version| version.as_str())
            .context("Runtime pointer has an invalid version.")?;
        let archive = value["archiveSha256"]
            .as_str()
            .filter(|hash| is_digest(hash))
            .context("Runtime pointer has an invalid digest.")?;
        Ok(Self {
            version: version.into(),
            archive: archive.into(),
        })
    }

    fn wire(&self) -> Value {
        json!({"version":self.version,"archiveSha256":self.archive})
    }
}

#[derive(Clone)]
pub(super) struct Pointer {
    pub current: Entry,
    pub previous: Option<Entry>,
    pub verified_at: String,
}

pub(super) struct Storage {
    pub root: PathBuf,
    component: &'static str,
}

impl Storage {
    pub fn new(data: &Path, component: &'static str) -> Self {
        Self {
            root: data.join("managed-runtimes").join(component),
            component,
        }
    }

    pub fn ensure(&self) -> Result<()> {
        private(self.root.parent().unwrap())?;
        private(&self.root)?;
        for directory in ["versions", "downloads", "staging"] {
            private(&self.root.join(directory))?;
        }
        Ok(())
    }

    pub fn version(&self, entry: &Entry) -> PathBuf {
        self.root.join("versions").join(&entry.archive)
    }

    pub async fn lock(&self, mut stop: watch::Receiver<bool>) -> Result<Lock> {
        let path = self.root.join("install.lock");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            ensure!(!*stop.borrow(), "Managed runtime installation stopped.");
            match mkdir_exclusive(&path) {
                Ok(()) => return Ok(Lock(path)),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    match fs::symlink_metadata(&path) {
                        Ok(metadata) => {
                            ensure!(
                                metadata.is_dir(),
                                "Managed runtime installation lock is invalid."
                            );
                            if metadata
                                .modified()
                                .ok()
                                .and_then(|date| date.elapsed().ok())
                                .is_some_and(|age| age >= LOCK_STALE)
                                && fs::remove_dir(&path).is_ok()
                            {
                                continue;
                            }
                        }
                        Err(error) if error.kind() == ErrorKind::NotFound => continue,
                        Err(error) => return Err(error.into()),
                    }
                }
                Err(error) => return Err(error.into()),
            }
            ensure!(
                tokio::time::Instant::now() < deadline,
                "Timed out waiting for the managed runtime installation lock."
            );
            tokio::select! {
                _ = super::source::cancelled(&mut stop) => anyhow::bail!("Managed runtime installation stopped."),
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
        }
    }

    pub fn current(&self) -> Result<Option<Pointer>> {
        let path = self.root.join("current.json");
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            result => ensure!(
                result?.is_file(),
                "Managed runtime pointer is not a regular file."
            ),
        }
        let value = parse_json_text(&read_small(&path)?)
            .map_err(|_| anyhow::anyhow!("Managed runtime pointer is invalid."))?;
        ensure!(
            value["schemaVersion"] == 1 && value["component"] == self.component,
            "Managed runtime pointer has an unsupported format."
        );
        let verified_at = value["verifiedAt"]
            .as_js_string()
            .filter(|value| cantrip_wire::date::parse(value).is_some())
            .and_then(|value| value.as_str())
            .context("Managed runtime pointer has an invalid verification date.")?
            .into();
        let current = Entry::read(&value)?;
        let previous = match value.get("previous") {
            Some(Value::Null) => None,
            Some(value) => Some(Entry::read(value)?),
            None => anyhow::bail!("Managed runtime previous pointer is missing."),
        };
        self.restore(&current)?;
        Ok(Some(Pointer {
            current,
            previous,
            verified_at,
        }))
    }

    fn restore(&self, entry: &Entry) -> Result<()> {
        let directory = self.version(entry);
        if matches!(fs::symlink_metadata(&directory), Err(error) if error.kind() == ErrorKind::NotFound)
        {
            let prefix = format!(".reinstall-{}-", entry.archive);
            let candidates: Vec<_> = fs::read_dir(self.root.join("versions"))?
                .collect::<std::io::Result<Vec<_>>>()?
                .into_iter()
                .filter(|entry| {
                    entry
                        .file_name()
                        .to_str()
                        .is_some_and(|name| name.starts_with(&prefix))
                })
                .collect();
            if let [backup] = candidates.as_slice() {
                require_directory(&backup.path())?;
                fs::rename(backup.path(), &directory)?;
            }
        }
        require_directory(&directory)
    }

    pub fn write(&self, pointer: &Pointer) -> Result<()> {
        let previous = pointer.previous.as_ref().map_or(Value::Null, Entry::wire);
        let value = json!({"schemaVersion":1,"component":self.component,"version":pointer.current.version,
            "archiveSha256":pointer.current.archive,"previous":previous,"verifiedAt":pointer.verified_at});
        let mut file = tempfile::NamedTempFile::new_in(&self.root)?;
        writeln!(&mut file, "{}", value.stringify())?;
        file.as_file().sync_all()?;
        file.persist(self.root.join("current.json"))?;
        Ok(())
    }

    pub fn promote(&self, staging: &Path, pointer: &Pointer) -> Result<()> {
        let destination = self.version(&pointer.current);
        let backup = match fs::symlink_metadata(&destination) {
            Ok(metadata) => {
                ensure!(metadata.is_dir(), "Managed runtime destination is invalid.");
                let path = self.root.join("versions").join(format!(
                    ".reinstall-{}-{}",
                    pointer.current.archive,
                    uuid::Uuid::new_v4()
                ));
                fs::rename(&destination, &path)?;
                Some(path)
            }
            Err(error) if error.kind() == ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let result = fs::rename(staging, &destination);
        let moved = result.is_ok();
        let result = result
            .map_err(anyhow::Error::from)
            .and_then(|()| self.write(pointer));
        if let Err(error) = result {
            if moved {
                fs::rename(&destination, staging)
                    .context("Could not restore the failed runtime staging directory.")?;
            }
            if let Some(backup) = backup {
                fs::rename(backup, &destination)
                    .context("Could not restore the previous runtime directory.")?;
            }
            return Err(error);
        }
        if let Some(backup) = backup {
            let _ = fs::remove_dir_all(backup);
        }
        Ok(())
    }

    pub fn purge(&self, names: &[&str]) -> Result<()> {
        if names.iter().any(|name| name.starts_with("state/")) {
            private(&self.root.join("state"))?;
        }
        for name in names {
            let path = self.root.join(name);
            match fs::symlink_metadata(&path) {
                Ok(metadata) => {
                    ensure!(
                        metadata.is_dir(),
                        "Managed runtime cache directory is invalid."
                    );
                    fs::remove_dir_all(&path)?;
                }
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            private(&path)?;
        }
        Ok(())
    }

    pub fn cleanup(
        &self,
        pointer: &Pointer,
        leased: impl Fn(&str) -> bool,
        sessions_live: bool,
    ) -> Result<()> {
        for entry in fs::read_dir(self.root.join("versions"))? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if is_digest(name)
                && !leased(name)
                && name != pointer.current.archive
                && pointer
                    .previous
                    .as_ref()
                    .is_none_or(|previous| name != previous.archive)
                && entry.file_type()?.is_dir()
            {
                fs::remove_dir_all(entry.path())?;
            }
        }
        for name in ["staging", "downloads"] {
            for entry in fs::read_dir(self.root.join(name))? {
                let entry = entry?;
                if sessions_live
                    && name == "staging"
                    && entry.file_name().to_string_lossy().starts_with("session-")
                {
                    continue;
                }
                let metadata = fs::symlink_metadata(entry.path())?;
                if metadata
                    .modified()
                    .ok()
                    .and_then(|stamp| stamp.elapsed().ok())
                    .is_some_and(|age| age >= PARTIAL_STALE)
                {
                    if metadata.is_dir() {
                        fs::remove_dir_all(entry.path())?;
                    } else if metadata.is_file() {
                        fs::remove_file(entry.path())?;
                    }
                }
            }
        }
        Ok(())
    }
}

fn is_digest(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub(super) fn require_directory(path: &Path) -> Result<()> {
    ensure!(
        fs::symlink_metadata(path)?.is_dir(),
        "Managed runtime storage is not a regular directory."
    );
    Ok(())
}

pub(super) fn private(path: &Path) -> Result<()> {
    cantrip_host::files::private_directory(path)?;
    require_directory(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn mkdir_exclusive(path: &Path) -> std::io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

pub(super) fn read_small(path: &Path) -> Result<String> {
    ensure!(
        fs::symlink_metadata(path)?.is_file(),
        "Runtime metadata is not a regular file."
    );
    let mut bytes = String::new();
    File::open(path)?
        .take(METADATA_LIMIT + 1)
        .read_to_string(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= METADATA_LIMIT,
        "Runtime metadata is too large."
    );
    Ok(bytes)
}

pub(super) struct Lock(PathBuf);

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.0);
    }
}
