//! Activate a stopped, prepared profile without replacing its previous bytes.
//! The journal records an actual directory switch, not database capabilities.
use super::{failure, files, publish};
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivationStep {
    PreparedMoved,
    PreviousRetained,
    NewPublished,
    Completed,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationReceipt {
    pub activation_id: Uuid,
    pub data_directory: PathBuf,
    pub backup_directory: PathBuf,
}

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    Preparing,
    Incoming,
    Retained,
    Complete,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    version: u8,
    activation_id: Uuid,
    destination: PathBuf,
    prepared: PathBuf,
    incoming: PathBuf,
    backup: PathBuf,
    phase: Phase,
}

impl Journal {
    fn receipt(&self) -> ActivationReceipt {
        ActivationReceipt {
            activation_id: self.activation_id,
            data_directory: self.destination.clone(),
            backup_directory: self.backup.clone(),
        }
    }
    fn marker(&self) -> String {
        format!(".cantrip-activation-{}.json", self.activation_id)
    }
}

struct Location {
    destination: PathBuf,
    parent: PathBuf,
    journal: PathBuf,
    lock: PathBuf,
}

#[derive(Debug)]
struct IncomingAborted(std::io::Error);
impl std::fmt::Display for IncomingAborted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Profile activation stopped before retaining the active directory"
        )
    }
}
impl std::error::Error for IncomingAborted {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}

impl Location {
    fn new(destination: &Path) -> Result<Self> {
        let absolute = std::path::absolute(destination)?;
        let parent = absolute.parent().unwrap_or(&absolute);
        files::private_directory(parent)?;
        let parent = fs::canonicalize(parent)?;
        let destination = match absolute.file_name() {
            Some(name) => parent.join(name),
            None => parent.clone(),
        };
        let key = format!(
            "{:x}",
            Sha256::digest(destination.as_os_str().as_encoded_bytes())
        );
        Ok(Self {
            destination,
            journal: parent.join(format!(".cantrip-activation-{key}.json")),
            lock: parent.join(format!(".cantrip-activation-{key}.lock")),
            parent,
        })
    }
    fn open_lock(&self) -> Result<File> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        Ok(options.open(&self.lock)?)
    }
    fn read(&self) -> Result<Option<Journal>> {
        let bytes = match fs::read(&self.journal) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let journal: Journal = serde_json::from_slice(&bytes)?;
        ensure!(
            journal.version == 1,
            "Unsupported profile activation journal"
        );
        ensure!(
            journal.destination == self.destination,
            "Profile activation destination changed"
        );
        ensure!(
            journal.incoming
                == self.parent.join(format!(
                    ".cantrip-activation-incoming-{}",
                    journal.activation_id
                ))
                && journal.backup
                    == self.parent.join(format!(
                        ".cantrip-activation-backup-{}",
                        journal.activation_id
                    )),
            "Profile activation paths changed"
        );
        Ok(Some(journal))
    }
    fn write(&self, journal: &Journal) -> Result<()> {
        let mut temporary = tempfile::NamedTempFile::new_in(&self.parent)?;
        use std::io::Write;
        temporary.write_all(&serde_json::to_vec(journal)?)?;
        temporary.as_file().sync_all()?;
        temporary.persist(&self.journal)?;
        sync_parent(&self.parent)
    }
}

fn sync_parent(parent: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = parent;
    Ok(())
}

fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn active_directory(journal: &Journal) -> Result<()> {
    // A completion record is not evidence that the published data still exists.
    // Missing activated data must not become an ordinary fresh installation.
    if !fs::metadata(&journal.destination)?.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotADirectory,
            "The activated profile directory is unavailable",
        )
        .into());
    }
    Ok(())
}

fn drive(
    location: &Location,
    journal: &mut Journal,
    progress: &mut impl FnMut(ActivationStep),
) -> Result<ActivationReceipt> {
    if journal.phase == Phase::Preparing {
        if !exists(&journal.incoming)? {
            // This is the actual move. Cross-device, permission and missing-source
            // errors leave the original active, with no pending switch to gate it.
            if let Err(error) = publish::directory(&journal.prepared, &journal.incoming) {
                // A directory-sync failure can follow a successful rename.
                // Retain that journal so the moved candidate remains recoverable.
                if !exists(&journal.incoming)? && exists(&journal.destination)? {
                    fs::remove_file(&location.journal)?;
                    sync_parent(&location.parent)?;
                    return Err(IncomingAborted(error).into());
                }
                return Err(error.into());
            }
        }
        ensure!(
            !exists(&journal.prepared)?,
            "Both prepared and staged profiles exist"
        );
        ensure!(
            fs::read(journal.incoming.join(journal.marker()))?
                == journal.activation_id.to_string().as_bytes(),
            "Staged profile activation identity changed"
        );
        progress(ActivationStep::PreparedMoved);
        journal.phase = Phase::Incoming;
        location.write(journal)?;
    }
    if journal.phase == Phase::Incoming {
        if !exists(&journal.backup)? {
            publish::directory(&journal.destination, &journal.backup)?;
        }
        ensure!(
            !exists(&journal.destination)?,
            "Profile destination changed during retention"
        );
        progress(ActivationStep::PreviousRetained);
        journal.phase = Phase::Retained;
        location.write(journal)?;
    }
    if journal.phase == Phase::Retained {
        if exists(&journal.incoming)? {
            publish::directory(&journal.incoming, &journal.destination)?;
        }
        // A crash may occur after publication but before the journal advance.
        // The operation's unique, private marker distinguishes our published
        // directory from an unrelated directory; no database format is inferred.
        ensure!(
            fs::read(journal.destination.join(journal.marker()))?
                == journal.activation_id.to_string().as_bytes(),
            "Published profile activation identity changed"
        );
        progress(ActivationStep::NewPublished);
        journal.phase = Phase::Complete;
        location.write(journal)?;
        progress(ActivationStep::Completed);
    }
    active_directory(journal)?;
    Ok(journal.receipt())
}

/// Holds an OS lock, released even after process death. Native serving takes a
/// shared lease, so multiple external-database instances may share a profile;
/// a directory switch takes the exclusive lease while its sources are stopped.
pub struct ProfileLease {
    _file: Option<File>,
}

fn acquire(destination: &Path, exclusive: bool) -> Result<ProfileLease> {
    let location = Location::new(destination)?;
    let file = match location.open_lock() {
        Ok(file) => file,
        Err(error)
            if !exclusive
                && error.downcast_ref::<std::io::Error>().is_some_and(|e| {
                    matches!(
                        e.kind(),
                        std::io::ErrorKind::PermissionDenied
                            | std::io::ErrorKind::ReadOnlyFilesystem
                    )
                }) =>
        {
            // A writable data mount may have an immutable or root-owned parent.
            // Ordinary serving must continue after this actual lock-open failure;
            // the same identity cannot perform a directory switch there either.
            // A pending switch still needs its real recovery operation to finish.
            match location.read()? {
                None => return Ok(ProfileLease { _file: None }),
                Some(journal) if journal.phase == Phase::Complete => {
                    active_directory(&journal)?;
                    return Ok(ProfileLease { _file: None });
                }
                Some(_) => {}
            }
            return Err(error);
        }
        Err(error) => return Err(error),
    };
    loop {
        if exclusive {
            file.lock()?;
        } else {
            file.lock_shared()?;
        }
        let Some(mut journal) = location.read()? else {
            return Ok(ProfileLease { _file: Some(file) });
        };
        if journal.phase == Phase::Complete {
            if !exclusive {
                active_directory(&journal)?;
            }
            return Ok(ProfileLease { _file: Some(file) });
        }
        if !exclusive {
            file.unlock()?;
            file.lock()?;
            // Another owner may have finished before this exclusive acquisition.
            if let Some(current) = location.read()? {
                journal = current;
            } else {
                // A failed incoming move can remove its uncommitted journal
                // while this reader waits. There is then nothing to recover.
                file.unlock()?;
                continue;
            }
        }
        if let Err(error) = drive(&location, &mut journal, &mut |_| {}) {
            if !error.is::<IncomingAborted>() {
                return Err(error);
            }
            // The actual incoming operation failed before the active directory
            // was touched. Its journal was removed; the current data remains
            // authoritative and ordinary startup must not be gated on that copy.
            eprintln!(
                "{}",
                serde_json::json!({"level":"warn","event":"profile.activation.aborted","activeProfileRetained":true})
            );
        }
        if exclusive {
            return Ok(ProfileLease { _file: Some(file) });
        }
        file.unlock()?;
    }
}

pub fn lease(destination: &Path) -> Result<ProfileLease> {
    acquire(destination, false).map_err(|e| failure(e, "recovering profile activation"))
}

pub fn exclusive_lease(destination: &Path) -> Result<ProfileLease> {
    acquire(destination, true).map_err(|e| failure(e, "recovering profile activation"))
}

pub fn activate_profile(prepared: &Path, destination: &Path) -> Result<ActivationReceipt> {
    activate_profile_with_progress(prepared, destination, |_| {})
}

/// Progress is reported after each real rename, before its journal advance.
/// Embedders may use it for update progress; observers must not mutate profiles.
pub fn activate_profile_with_progress(
    prepared: &Path,
    destination: &Path,
    mut progress: impl FnMut(ActivationStep),
) -> Result<ActivationReceipt> {
    let result = (|| {
        let location = Location::new(destination)?;
        let file = location.open_lock()?;
        file.lock()?;
        activate_locked(&location, prepared, &mut progress)
    })();
    result.map_err(|e| failure(e, "activating the prepared profile"))
}

fn activate_locked(
    location: &Location,
    prepared: &Path,
    progress: &mut impl FnMut(ActivationStep),
) -> Result<ActivationReceipt> {
    let prepared = std::path::absolute(prepared)?;
    if let Some(mut previous) = location.read()? {
        let receipt = drive(location, &mut previous, progress)?;
        if previous.prepared == prepared && !exists(&prepared)? {
            // Repeating an acknowledged or lost-ack activation never swaps
            // an old snapshot back over writes accepted since publication.
            return Ok(receipt);
        }
    }
    ensure!(
        !prepared.starts_with(&location.destination)
            && !location.destination.starts_with(&prepared),
        "Prepared and active profile directories overlap"
    );
    let id = Uuid::new_v4();
    let mut journal = Journal {
        version: 1,
        activation_id: id,
        destination: location.destination.clone(),
        prepared,
        incoming: location
            .parent
            .join(format!(".cantrip-activation-incoming-{id}")),
        backup: location
            .parent
            .join(format!(".cantrip-activation-backup-{id}")),
        phase: Phase::Preparing,
    };
    // Prepared profiles come from a completed offline restore. Opening the
    // directory and creating this marker exercise real filesystem operations.
    fs::read_dir(&journal.prepared)?;
    files::write_private(
        &journal.prepared.join(journal.marker()),
        id.to_string().as_bytes(),
    )?;
    #[cfg(unix)]
    File::open(&journal.prepared)?.sync_all()?;
    location.write(&journal)?;
    drive(location, &mut journal, progress)
}

/// Preparation and publication share one exclusive lease. No native server can
/// accept writes between the stopped-profile snapshot and its directory switch.
pub(super) fn prepare_and_activate<T>(
    destination: &Path,
    prepare: impl FnOnce() -> Result<Option<(PathBuf, T)>>,
) -> Result<Option<ActivationReceipt>> {
    let _lease = exclusive_lease(destination)?;
    let location = Location::new(destination)?;
    if let Some(journal) = location.read()? {
        // Explicit logical restore can repair a missing completed root, but an
        // automatic upgrade must never reinterpret it as a fresh installation.
        active_directory(&journal)?;
    }
    let Some((prepared, _owner)) = prepare()? else {
        return Ok(None);
    };
    activate_locked(&location, &prepared, &mut |step| {
        eprintln!(
            "{}",
            serde_json::json!({"event":"profile.activation.progress","step":step})
        );
    })
    .map(Some)
    .map_err(|e| failure(e, "activating the upgraded profile"))
}

pub fn recover_profile_activation(destination: &Path) -> Result<Option<ActivationReceipt>> {
    let result = (|| {
        let location = Location::new(destination)?;
        match location.read()? {
            None => return Ok(None),
            Some(journal) if journal.phase == Phase::Complete => {
                active_directory(&journal)?;
                return Ok(Some(journal.receipt()));
            }
            Some(_) => {}
        }
        let file = location.open_lock()?;
        file.lock()?;
        location
            .read()?
            .map(|mut journal| drive(&location, &mut journal, &mut |_| {}))
            .transpose()
    })();
    result.map_err(|e| failure(e, "recovering profile activation"))
}
