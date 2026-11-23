//! Materialize, verify, and atomically publish a prepared binary save.
use super::{
    CHUNK, Conflict, host, paths,
    stamp::Stamp,
    storage::{Storage, open_file, remove_file, sync_directory},
};
use anyhow::{Result, ensure};
use cantrip_crypto::Zeroizing;
use cantrip_wire::{Value, value::json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

pub(super) struct Destination {
    pub path: PathBuf,
    pub mode: u32,
}

fn locate(root: &Value, relative: &Value) -> Result<(PathBuf, bool)> {
    let root = host::canonical_sync(&host::native(root.as_js_string().unwrap()))?;
    let segments = paths::segments(relative.as_js_string().unwrap())?;
    ensure!(!segments.is_empty(), "Choose a file path.");
    let name = host::native(segments.last().unwrap());
    let logical = segments.iter().fold(root.clone(), |parent, segment| {
        parent.join(host::native(segment))
    });
    // Both the read and write paths permit intentional links to external
    // targets. A missing destination is resolved through its actual parent.
    match host::canonical_sync(&logical) {
        Ok(path) => Ok((path, true)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if metadata(&logical)?.is_some() {
                return Err(error.into()); // A dangling link is not a new file.
            }
            let parent = host::canonical_sync(logical.parent().unwrap())?;
            Ok((parent.join(name), false))
        }
        Err(error) => Err(error.into()),
    }
}

pub(super) fn inspect(
    root: &Value,
    relative: &Value,
    expected: &Value,
    size: Option<u64>,
) -> Result<Destination> {
    let (path, exists) = locate(root, relative)?;
    let expected = expected.as_str();
    let Some(expected) = expected else {
        if exists {
            return Err(Conflict.into());
        }
        return Ok(Destination { path, mode: 0o600 });
    };
    if !exists {
        return Err(Conflict.into());
    }
    let mut file = open_file(&path, false, false, false)?;
    let metadata = file.metadata()?;
    ensure!(metadata.is_file(), "Binary saving requires a regular file.");
    let before = Stamp::read(&file, &metadata)?;
    if size.is_some_and(|size| before.size != size) {
        return Err(Conflict.into());
    }
    let version = before.binary_version();
    let actual = if expected.starts_with("binary-v1:") {
        version.clone()
    } else {
        format!("binary-sha256:{}", hash_file(&mut file)?)
    };
    if actual != expected || Stamp::read(&file, &file.metadata()?)?.binary_version() != version {
        return Err(Conflict.into());
    }
    Ok(Destination {
        path,
        mode: mode(&metadata),
    })
}

pub(super) fn materialize(storage: &Storage<'_>, record: &mut Value) -> Result<()> {
    let path = host::native(record["publication"].as_js_string().unwrap());
    remove_file(&path)?;
    let mut output = open_file(&path, true, true, false)?;
    let result = write_publication(storage, record, &mut output);
    drop(output);
    match result {
        Ok(version) => record["publicationVersion"] = json!(version),
        Err(error) => {
            let _ = remove_file(&path);
            return Err(error);
        }
    }
    sync_directory(path.parent().unwrap())?;
    Ok(())
}

fn write_publication(storage: &Storage<'_>, record: &Value, output: &mut File) -> Result<String> {
    let key = record["key"].as_str().unwrap();
    let frames = record["frames"].as_u64().unwrap();
    let expected_size = record["size"].as_u64().unwrap();
    let expected_hash = record["sha256"].as_str().unwrap();
    let mut stage = storage.open_stage(key)?;
    let mut hash = Sha256::new();
    let mut size = 0;
    for index in 0..frames {
        let (bytes, final_page) = storage.frame(key, &mut stage, index)?;
        ensure!(
            final_page == (index == frames - 1),
            "Binary staging final-page marker is invalid."
        );
        output.write_all(&bytes)?;
        hash.update(&bytes);
        size += bytes.len() as u64;
    }
    ensure!(
        size == expected_size && hex_digest(&hash.finalize()) == expected_hash,
        "Binary upload size or checksum does not match."
    );
    set_mode(output, record["mode"].as_u64().unwrap() as u32)?;
    output.sync_all()?;
    ensure!(
        output.metadata()?.len() == expected_size && hash_file(output)? == expected_hash,
        "Binary publication failed its stored size/checksum verification."
    );
    Ok(Stamp::read(output, &output.metadata()?)?.binary_version())
}

pub(super) fn reconcile(storage: &Storage<'_>, record: &mut Value, finish: bool) -> Result<()> {
    if record["state"] != "prepared" {
        return Ok(());
    }
    let target = host::native(record["target"].as_js_string().unwrap());
    let pending = host::native(record["publication"].as_js_string().unwrap());
    let _target = storage.target_lock(&record["target"])?;
    let has_pending = metadata(&pending)?.is_some();

    // An interrupted create can leave both hard links, or an interrupted
    // replacement can have consumed the temporary. Verify actual target bytes.
    if !has_pending || (record["expected"].is_null() && same_file(&target, &pending)?) {
        let expected = json!(format!(
            "binary-sha256:{}",
            record["sha256"].as_str().unwrap()
        ));
        match inspect(
            &record["root"],
            &record["path"],
            &expected,
            record["size"].as_u64(),
        ) {
            Ok(current) if current.path == target => {}
            Ok(_) => return conflict(storage, record, VERIFY_CONFLICT),
            Err(error) if error.is::<Conflict>() => {
                return conflict(storage, record, VERIFY_CONFLICT);
            }
            Err(error) => return Err(error),
        }
        if has_pending {
            remove_file(&pending)?;
        }
        // If the original publisher ran out of time after the rename, finish
        // the directory sync here before reporting a committed result.
        sync_directory(target.parent().unwrap())?;
        return settle(storage, record, true);
    }
    if !finish {
        return Ok(());
    }
    let publication = (|| {
        let current = inspect(&record["root"], &record["path"], &record["expected"], None)?;
        if current.path != target {
            return Err(Conflict.into());
        }
        let file = open_file(&pending, false, false, false)?;
        let version = Stamp::read(&file, &file.metadata()?)?.binary_version();
        ensure!(
            record["publicationVersion"] == version,
            "The staged publication changed before saving. Restart this save."
        );
        drop(file);
        if record["expected"].is_null() {
            fs::hard_link(&pending, &target)?;
            remove_file(&pending)?;
        } else {
            fs::rename(&pending, &target)?;
        }
        sync_directory(target.parent().unwrap())?;
        Ok(())
    })();
    match publication {
        Ok(()) => settle(storage, record, false),
        Err(error)
            if error.is::<Conflict>()
                || error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|cause| cause.kind() == io::ErrorKind::AlreadyExists) =>
        {
            conflict(storage, record, &Conflict.to_string())
        }
        Err(error) => Err(error),
    }
}

const VERIFY_CONFLICT: &str =
    "The prepared save cannot be verified against the current file. The draft has been retained.";

fn conflict(storage: &Storage<'_>, record: &mut Value, reason: &str) -> Result<()> {
    record["state"] = json!("conflict");
    record["error"] = json!(reason);
    storage.save(record["key"].as_str().unwrap(), record)
}

fn settle(storage: &Storage<'_>, record: &mut Value, observed: bool) -> Result<()> {
    record["state"] = json!("committed");
    record["error"] = Value::Null;
    let key = record["key"].as_str().unwrap();
    let saved = storage.save(key, record);
    if observed && saved.is_err() {
        // The previous durable prepared record and the verified target still
        // allow a later status to repeat the observation.
        return Ok(());
    }
    saved?;
    let _ = storage.discard(key);
    Ok(())
}

fn metadata(path: &Path) -> io::Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn same_file(left: &Path, right: &Path) -> Result<bool> {
    let Some(first) = metadata(left)?.filter(Metadata::is_file) else {
        return Ok(false);
    };
    let Some(second) = metadata(right)?.filter(Metadata::is_file) else {
        return Ok(false);
    };
    let left = open_file(left, false, false, false)?;
    let right = open_file(right, false, false, false)?;
    Ok(Stamp::read(&left, &first)?.same_file(Stamp::read(&right, &second)?))
}

fn hash_file(file: &mut File) -> Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut buffer = Zeroizing::new(vec![0; CHUNK as usize]);
    let mut digest = Sha256::new();
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(hex_digest(&digest.finalize()));
        }
        digest.update(&buffer[..read]);
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn mode(metadata: &Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o777
    }
    #[cfg(windows)]
    {
        if metadata.permissions().readonly() {
            0o444
        } else {
            0o666
        }
    }
}

fn set_mode(file: &File, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(mode))
    }
    #[cfg(windows)]
    {
        let mut permissions = file.metadata()?.permissions();
        permissions.set_readonly(mode & 0o200 == 0);
        file.set_permissions(permissions)
    }
}
