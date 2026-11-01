//! Explicit user-selected export destinations. No project paths or worker file
//! operations enter this API; bytes stream into a sibling temporary file.
use std::{
    collections::HashMap,
    io::Write,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use sha2::{Digest, Sha256};
use tauri::{ipc::InvokeBody, Manager};
use tauri_plugin_dialog::DialogExt;
use tempfile::NamedTempFile;

const CHUNK: usize = 256 * 1024;
const UNAVAILABLE: &str = "The local export is unavailable or belongs to another window.";

struct Export {
    window: String,
    destination: PathBuf,
    temporary: NamedTempFile,
    hash: Sha256,
    size: u64,
}

#[derive(Default)]
struct Exports {
    files: HashMap<String, Export>,
    epochs: HashMap<String, u64>,
}
#[derive(Default)]
pub struct NbtExports(Mutex<Exports>);

impl NbtExports {
    fn epoch(&self, window: &str) -> Result<u64, String> {
        let mut state = self.0.lock().map_err(|_| UNAVAILABLE)?;
        Ok(*state.epochs.entry(window.into()).or_default())
    }
    fn begin(&self, window: &str, destination: PathBuf, epoch: u64) -> Result<String, String> {
        let parent = destination
            .parent()
            .ok_or("The export destination has no parent directory.")?;
        let temporary = NamedTempFile::new_in(parent)
            .map_err(|_| "Could not create the local export temporary file.")?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut exports = self.0.lock().map_err(|_| UNAVAILABLE)?;
        if *exports.epochs.entry(window.into()).or_default() != epoch {
            return Err(UNAVAILABLE.into());
        }
        exports.files.insert(
            id.clone(),
            Export {
                window: window.into(),
                destination,
                temporary,
                hash: Sha256::new(),
                size: 0,
            },
        );
        Ok(id)
    }

    fn write(&self, window: &str, id: &str, offset: u64, bytes: &[u8]) -> Result<u64, String> {
        let mut state = self.0.lock().map_err(|_| UNAVAILABLE)?;
        let exports = &mut state.files;
        let export = exports
            .get_mut(id)
            .filter(|export| export.window == window)
            .ok_or(UNAVAILABLE)?;
        if bytes.is_empty() || bytes.len() > CHUNK || offset != export.size {
            return Err("The export chunk is empty, oversized, or out of order.".into());
        }
        let size = export
            .size
            .checked_add(bytes.len() as u64)
            .ok_or("The export size overflowed.")?;
        if export.temporary.write_all(bytes).is_err() {
            // A partial write is never retried against a possibly advanced file.
            exports.remove(id);
            return Err(
                "Could not write the local export; the original destination is intact.".into(),
            );
        }
        export.hash.update(bytes);
        export.size = size;
        Ok(size)
    }

    fn finish(&self, window: &str, id: &str, size: u64, sha256: &str) -> Result<(), String> {
        let export = {
            let mut state = self.0.lock().map_err(|_| UNAVAILABLE)?;
            let exports = &mut state.files;
            if !exports
                .get(id)
                .is_some_and(|export| export.window == window)
            {
                return Err(UNAVAILABLE.into());
            }
            exports.remove(id).ok_or(UNAVAILABLE)?
        };
        if export.size != size || format!("{:x}", export.hash.finalize()) != sha256 {
            return Err("The local export checksum or size did not match.".into());
        }
        export
            .temporary
            .as_file()
            .sync_all()
            .map_err(|_| "Could not flush the local export; the original destination is intact.")?;
        let parent = export.destination.parent().map(PathBuf::from);
        export
            .temporary
            .persist(export.destination)
            .map_err(|_| "Could not replace the export destination.")?;
        #[cfg(unix)]
        if let Some(parent) = parent {
            std::fs::File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| "The export was replaced, but its directory could not be flushed. Verify the exported copy.")?;
        }
        #[cfg(not(unix))]
        let _ = parent;
        Ok(())
    }

    fn cancel(&self, window: &str, id: &str) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|_| UNAVAILABLE)?;
        let exports = &mut state.files;
        if exports
            .get(id)
            .is_some_and(|export| export.window != window)
        {
            return Err(UNAVAILABLE.into());
        }
        exports.remove(id);
        Ok(())
    }

    pub fn retire_window(&self, window: &str) {
        if let Ok(mut exports) = self.0.lock() {
            if let Some(epoch) = exports.epochs.get_mut(window) {
                *epoch = epoch.wrapping_add(1);
            }
            exports.files.retain(|_, export| export.window != window);
        }
    }
}

#[tauri::command]
pub async fn begin_nbt_export(
    window: tauri::WebviewWindow,
    suggested_name: String,
) -> Result<Option<String>, String> {
    let state = window.state::<Arc<NbtExports>>().inner().clone();
    let epoch = state.epoch(window.label())?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    // A name is only a picker suggestion. Only the actual native choice grants
    // a destination; the renderer cannot submit arbitrary filesystem paths.
    let name = suggested_name
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or("document.nbt");
    window
        .dialog()
        .file()
        .set_title("Export NBT copy")
        .set_file_name(name)
        .save_file(move |path| {
            let _ = sender.send(path);
        });
    let Some(path) = receiver.await.map_err(|_| "The export picker closed.")? else {
        return Ok(None);
    };
    let destination = path
        .into_path()
        .map_err(|_| "The selected export destination is not a local file.")?;
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || state.begin(&label, destination, epoch))
        .await
        .map_err(|_| "Could not start the local export.")?
        .map(Some)
}

#[tauri::command]
pub async fn write_nbt_export(
    window: tauri::WebviewWindow,
    request: tauri::ipc::Request<'_>,
) -> Result<u64, String> {
    let headers = request.headers();
    let id = headers
        .get("x-cantrip-export")
        .and_then(|value| value.to_str().ok())
        .ok_or("The export identity is missing.")?
        .to_owned();
    let offset = headers
        .get("x-cantrip-offset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or("The export offset is missing.")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("The export chunk must be binary.".into());
    };
    if bytes.is_empty() || bytes.len() > CHUNK {
        return Err("The export chunk is empty or oversized.".into());
    }
    let bytes = zeroize::Zeroizing::new(bytes.clone());
    let state = window.state::<Arc<NbtExports>>().inner().clone();
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || state.write(&label, &id, offset, &bytes))
        .await
        .map_err(|_| "The local export write stopped.")?
}

#[tauri::command]
pub async fn finish_nbt_export(
    window: tauri::WebviewWindow,
    id: String,
    size: u64,
    sha256: String,
) -> Result<(), String> {
    let state = window.state::<Arc<NbtExports>>().inner().clone();
    let label = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || state.finish(&label, &id, size, &sha256))
        .await
        .map_err(|_| "The local export commit stopped. Verify the exported copy.")?
}

#[tauri::command]
pub fn cancel_nbt_export(
    window: tauri::WebviewWindow,
    id: String,
    state: tauri::State<'_, Arc<NbtExports>>,
) -> Result<(), String> {
    state.cancel(window.label(), &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streams_an_atomic_replacement_with_exact_order_and_checksum() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("copy.nbt");
        std::fs::write(&destination, b"original").unwrap();
        let exports = NbtExports::default();
        let id = exports.begin("view", destination.clone(), 0).unwrap();
        let chunk = vec![42; CHUNK];
        assert!(exports.write("other", &id, 0, &chunk).is_err());
        assert!(exports.write("view", &id, 1, &chunk).is_err());
        assert_eq!(exports.write("view", &id, 0, &chunk).unwrap(), CHUNK as u64);
        assert!(exports.write("view", &id, 0, &chunk).is_err());
        exports.write("view", &id, CHUNK as u64, b"tail").unwrap();
        assert_eq!(std::fs::read(&destination).unwrap(), b"original");
        assert!(exports.finish("other", &id, 0, "").is_err());
        let mut hash = Sha256::new();
        hash.update(&chunk);
        hash.update(b"tail");
        exports
            .finish(
                "view",
                &id,
                (CHUNK + 4) as u64,
                &format!("{:x}", hash.finalize()),
            )
            .unwrap();
        let mut expected = chunk;
        expected.extend(b"tail");
        assert_eq!(std::fs::read(&destination).unwrap(), expected);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn cancel_bad_receipt_and_window_close_preserve_the_destination() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("copy.nbt");
        std::fs::write(&destination, b"original").unwrap();
        let exports = NbtExports::default();
        let id = exports.begin("view", destination.clone(), 0).unwrap();
        exports.write("view", &id, 0, b"next").unwrap();
        assert!(exports.finish("view", &id, 4, "wrong").is_err());
        let id = exports.begin("view", destination.clone(), 0).unwrap();
        assert!(exports.write("view", &id, 0, &vec![0; CHUNK + 1]).is_err());
        assert!(exports.cancel("other", &id).is_err());
        exports.cancel("view", &id).unwrap();
        exports.cancel("view", &id).unwrap();
        exports.begin("view", destination.clone(), 0).unwrap();
        exports.retire_window("view");
        assert!(exports.begin("view", destination.clone(), 0).is_err());
        assert_eq!(std::fs::read(&destination).unwrap(), b"original");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn reload_fences_a_pending_picker_but_a_new_renderer_can_export() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("copy.nbt");
        let exports = NbtExports::default();
        let old = exports.epoch("view").unwrap();
        exports.retire_window("view");
        assert!(exports.begin("view", destination.clone(), old).is_err());
        let current = exports.epoch("view").unwrap();
        assert_ne!(current, old);
        let id = exports.begin("view", destination, current).unwrap();
        exports.cancel("view", &id).unwrap();
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn an_actual_destination_failure_removes_the_temporary_export() {
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("occupied");
        std::fs::create_dir(&destination).unwrap();
        let exports = NbtExports::default();
        let id = exports.begin("view", destination.clone(), 0).unwrap();
        exports.write("view", &id, 0, b"next").unwrap();
        assert!(exports
            .finish("view", &id, 4, &format!("{:x}", Sha256::digest(b"next")))
            .is_err());
        assert!(destination.is_dir());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
