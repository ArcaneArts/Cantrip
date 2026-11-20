//! The v1 profile pointer and update lock shared with the legacy worker.
use super::runtime::{is_digest, now, version};
use crate::filesystem::{Scope, paths};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{Value, parse_json_text, value::json};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};

const POINTER_LIMIT: usize = 65_536;
const LOCK_STALE: Duration = Duration::from_secs(600);
const LOCK_WAIT: Duration = Duration::from_secs(30);
static OWNED_PACKAGE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?-[0-9a-f]{12}(?:-[0-9A-Za-z]+)?$",
    )
    .expect("CodeGraph package directory")
});

pub(super) struct Storage {
    pub root: PathBuf,
}

pub(super) struct Current {
    pub archive: String,
    pub executable: PathBuf,
    pub package: PathBuf,
    pub version: String,
}

fn relative(raw: &Value) -> Result<PathBuf> {
    let path = paths::native(
        raw.as_js_string()
            .context("Missing CodeGraph installation path.")?,
    );
    ensure!(
        !path.as_os_str().is_empty()
            && path
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "CodeGraph installation path escapes the version directory."
    );
    Ok(path)
}

impl Storage {
    pub(super) fn new(data: &Path) -> Self {
        Self {
            root: data.join("tools").join("codegraph"),
        }
    }

    pub(super) fn prepare(&self) -> Result<()> {
        for directory in [
            self.root.parent().unwrap().to_owned(),
            self.root.clone(),
            self.root.join("bin"),
            self.root.join("versions"),
            self.root.join("staging"),
        ] {
            cantrip_host::files::private_directory(&directory)?;
            ensure!(
                fs::symlink_metadata(directory)?.is_dir(),
                "CodeGraph runtime storage is not a regular directory."
            );
        }
        Ok(())
    }

    fn pointer(&self) -> PathBuf {
        self.root.join("bin").join("current.json")
    }

    pub(super) fn current(&self) -> Result<Option<Current>> {
        let Some(manifest) = read_document(&self.pointer(), POINTER_LIMIT)? else {
            return Ok(None);
        };
        let hash = manifest["archiveSha256"]
            .as_str()
            .filter(|value| is_digest(value))
            .context("Invalid CodeGraph installation digest.")?;
        let version = manifest["version"]
            .as_str()
            .and_then(version)
            .context("Invalid CodeGraph installation version.")?;
        ensure!(
            manifest["schemaVersion"] == 1,
            "Invalid CodeGraph installation pointer version."
        );
        let executable = relative(&manifest["executable"])?;
        let package = relative(&manifest["packageDirectory"])?;
        ensure!(
            package.components().count() == 1,
            "CodeGraph package is outside its managed version directory."
        );
        Ok(Some(Current {
            archive: hash.into(),
            executable,
            package,
            version: version.into(),
        }))
    }

    pub(super) fn publish(&self, current: &Current) -> Result<()> {
        write_document(
            &self.pointer(),
            &json!({
                "schemaVersion":1,
                "archiveSha256":current.archive,
                "executable":paths::text(&current.executable),
                "packageDirectory":paths::text(&current.package),
                "telemetryDisabled":true,
                "verifiedAt":now(),
                "version":current.version
            }),
        )
    }

    pub(super) fn prune(&self, keep: &[PathBuf]) -> Result<()> {
        for entry in fs::read_dir(self.root.join("versions"))? {
            let entry = entry?;
            let name = entry.file_name();
            if !keep.iter().any(|package| package == Path::new(&name))
                && name
                    .to_str()
                    .is_some_and(|name| OWNED_PACKAGE.is_match(name))
                && entry.file_type()?.is_dir()
            {
                fs::remove_dir_all(entry.path())?;
            }
        }
        Ok(())
    }

    pub(super) fn clear_staging(&self, prefix: &str) -> Result<()> {
        for entry in fs::read_dir(self.root.join("staging"))? {
            let entry = entry?;
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.starts_with(prefix))
                && entry.file_type()?.is_dir()
            {
                fs::remove_dir_all(entry.path())?;
            }
        }
        Ok(())
    }

    pub(super) async fn lock(&self, scope: &Scope) -> Result<UpdateLock> {
        let path = self.root.join("update.lock");
        let deadline = tokio::time::Instant::now() + LOCK_WAIT;
        loop {
            scope.check()?;
            match cantrip_host::files::open_private(&path) {
                Ok(file) => {
                    let mut lock = UpdateLock {
                        path,
                        file: Some(file),
                    };
                    writeln!(
                        lock.file.as_mut().unwrap(),
                        "{}\n{}",
                        std::process::id(),
                        now()
                    )?;
                    return Ok(lock);
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    match fs::symlink_metadata(&path) {
                        Ok(metadata) => {
                            ensure!(
                                metadata.is_file(),
                                "CodeGraph update lock is not a regular file."
                            );
                            if metadata
                                .modified()
                                .ok()
                                .and_then(|date| date.elapsed().ok())
                                .is_some_and(|age| age > LOCK_STALE)
                                && fs::remove_file(&path).is_ok()
                            {
                                continue;
                            }
                        }
                        Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                        Err(error) => return Err(error.into()),
                    }
                }
                Err(error) => return Err(error.into()),
            }
            ensure!(
                tokio::time::Instant::now() < deadline,
                "Timed out waiting for another CodeGraph runtime update."
            );
            tokio::select! {
                _ = scope.stopped() => anyhow::bail!("CodeGraph update stopped."),
                _ = tokio::time::sleep(Duration::from_millis(250)) => {},
            }
        }
    }
}

pub(super) struct UpdateLock {
    path: PathBuf,
    file: Option<File>,
}

impl Drop for UpdateLock {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = fs::remove_file(&self.path);
    }
}

pub(super) fn read_document(path: &Path, limit: usize) -> Result<Option<Value>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        result => ensure!(
            result?.is_file(),
            "CodeGraph metadata is not a regular file."
        ),
    }
    let mut data = String::new();
    File::open(path)?
        .take(limit as u64 + 1)
        .read_to_string(&mut data)?;
    ensure!(
        data.len() <= limit,
        "CodeGraph metadata exceeded its size limit."
    );
    Ok(Some(parse_json_text(&data).map_err(|_| {
        anyhow::anyhow!("CodeGraph metadata is invalid JSON.")
    })?))
}

pub(super) fn write_document(path: &Path, value: &Value) -> Result<()> {
    let mut temporary = tempfile::NamedTempFile::new_in(
        path.parent()
            .context("Missing CodeGraph metadata directory.")?,
    )?;
    writeln!(temporary, "{}", value.stringify())?;
    temporary.as_file().sync_all()?;
    temporary.persist(path)?;
    Ok(())
}
