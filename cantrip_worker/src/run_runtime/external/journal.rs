//! Durable admission and terminal metadata. Arguments and output stay in memory.
use super::{Phase, Receipt, Snapshot};
use anyhow::{Context, Result, ensure};
use std::{
    fs,
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

const MAX_RECEIPTS: usize = 4096;
const RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub(super) fn read(directory: &Path, command: Uuid) -> Result<Option<Receipt>> {
    let file = match fs::File::open(path(directory, command)) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    file.take(8192).read_to_end(&mut bytes)?;
    Ok(Some(
        Receipt::decode(&bytes).context("Invalid command receipt")?,
    ))
}

pub(super) fn write(directory: &Path, receipt: &Receipt, fresh: bool) -> Result<()> {
    let target = path(directory, receipt.snapshot.command_id);
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    file.write_all(&receipt.encode()?)?;
    file.as_file().sync_all()?;
    if fresh {
        file.persist_noclobber(target)
            .context("Command admission changed")?;
    } else {
        file.persist(target)
            .context("Command completion could not be recorded")?;
    }
    #[cfg(unix)]
    fs::File::open(directory)?.sync_all()?;
    Ok(())
}

pub(super) fn maintain(directory: &Path) -> Result<()> {
    let mut total = 0;
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        if !name
            .to_str()
            .and_then(|name| name.strip_suffix(".json"))
            .is_some_and(|id| Uuid::parse_str(id).is_ok())
        {
            continue;
        }
        if entry
            .metadata()?
            .modified()?
            .elapsed()
            .is_ok_and(|age| age >= RETENTION)
        {
            fs::remove_file(entry.path())?;
        } else {
            total += 1;
        }
    }
    ensure!(
        total < MAX_RECEIPTS,
        "The worker has reached its retained external command limit."
    );
    Ok(())
}

pub(super) fn retained(receipt: Receipt, generation: &str) -> Snapshot {
    let mut snapshot = receipt.snapshot;
    if snapshot.phase.active() {
        snapshot.phase = Phase::Interrupted;
        snapshot.revision += 1;
        snapshot.summary = if receipt.generation != generation {
            "The worker restarted before the command finished."
        } else {
            "The worker interrupted the external command."
        }
        .to_owned();
    }
    snapshot.output_start = snapshot.output_end;
    snapshot
}

fn path(directory: &Path, id: Uuid) -> PathBuf {
    directory.join(format!("{id}.json"))
}
