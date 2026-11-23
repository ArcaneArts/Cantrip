use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::RUNTIME_TAR;

pub(crate) fn prepare() -> io::Result<PathBuf> {
    if let Ok(configured) = std::env::var("PGLITE_RUNTIME_DIR") {
        let directory = PathBuf::from(configured);
        // Let initdb/backend initialization use existing configured assets
        // directly, including read-only distribution assets.
        if !directory.is_dir() {
            publish(&directory)?;
        }
        return Ok(directory);
    }

    let parent = std::env::temp_dir();
    let name = format!(
        "pglite-rs-runtime-{}-{:x}",
        env!("CARGO_PKG_VERSION"),
        fingerprint()
    );
    let mut directory = parent.join(&name);
    for generation in 1_u64.. {
        if (!directory.exists() && publish(&directory)?) || is_complete(&directory)? {
            return Ok(directory);
        }
        // Another server can still have files open in this directory. Keep
        // it in place and let all new starts converge on a complete sibling.
        directory = parent.join(format!("{name}-recovery-{generation}"));
    }
    unreachable!("exhausted runtime cache generations")
}

fn is_complete(directory: &Path) -> io::Result<bool> {
    if !directory.is_dir() {
        return Ok(false);
    }
    for entry in tar::Archive::new(RUNTIME_TAR).entries()? {
        let entry = entry?;
        let kind = entry.header().entry_type();
        if kind.is_file() || kind.is_hard_link() || kind.is_symlink() {
            let Ok(metadata) = fs::metadata(directory.join(entry.path()?)) else {
                return Ok(false);
            };
            if kind.is_file() && (!metadata.is_file() || metadata.len() != entry.size()) {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

fn publish(directory: &Path) -> io::Result<bool> {
    let parent = directory
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let staging = tempfile::Builder::new()
        .prefix(".pglite-runtime-staging-")
        .tempdir_in(parent)?;
    let runtime = staging.path().join("runtime");
    fs::create_dir(&runtime)?;
    tar::Archive::new(RUNTIME_TAR).unpack(&runtime)?;
    fs::write(runtime.join(".extracted"), b"")?;
    match fs::rename(runtime, directory) {
        Ok(()) => Ok(true),
        // A concurrent publisher won. Its directory can now be inspected.
        Err(_) if directory.is_dir() => Ok(false),
        Err(error) => Err(error),
    }
}

fn fingerprint() -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for chunk in RUNTIME_TAR.chunks(8) {
        let mut word = [0u8; 8];
        word[..chunk.len()].copy_from_slice(chunk);
        hash ^= u64::from_le_bytes(word);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}
