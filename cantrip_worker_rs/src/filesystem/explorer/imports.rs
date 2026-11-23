//! Short-lived staging for protected Explorer drops. The receiving worker
//! owns the open file and only publishes a fully received transfer.
use super::{entry, io_error, joined, paths, stamp::Stamp};
use crate::filesystem::{Scope, paths as host};
use anyhow::{Result, bail, ensure};
use base64::{
    Engine,
    alphabet::STANDARD,
    engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig},
};
use cantrip_wire::{JsString, Value, value::json};
use cap_std::{ambient_authority, fs::Dir};
use std::{
    collections::HashMap,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    fs::File,
    io::{AsyncSeekExt, AsyncWriteExt},
    task::AbortHandle,
    time::Instant,
};
use uuid::Uuid;

const CHUNK_BYTES: usize = 256 * 1024;
const MAX_ACTIVE: usize = 16;
pub(crate) const IDLE: Duration = Duration::from_secs(5 * 60);
const CHUNK_ENCODING: GeneralPurpose = GeneralPurpose::new(
    &STANDARD,
    GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true),
);

type Transfers = Mutex<HashMap<String, Option<IdleStage>>>;

#[derive(Default)]
pub(crate) struct Imports {
    transfers: Arc<Transfers>,
}

// An empty slot is a write in progress. Move the open file out before I/O so
// independent drops can progress without sharing a filesystem lock.
struct IdleStage {
    stage: Option<Stage>,
    deadline: Instant,
    timer: AbortHandle,
}

impl Drop for IdleStage {
    fn drop(&mut self) {
        self.timer.abort();
    }
}

struct Reservation<'a> {
    imports: &'a Imports,
    key: Option<String>,
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        if let Some(key) = &self.key {
            self.imports.transfers.lock().unwrap().remove(key);
        }
    }
}

impl Reservation<'_> {
    fn park(mut self, stage: Stage) {
        let key = self.key.take().unwrap();
        let deadline = Instant::now() + IDLE;
        let transfers = Arc::downgrade(&self.imports.transfers);
        let expired = key.clone();
        let timer = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            if let Some(transfers) = transfers.upgrade() {
                let mut transfers = transfers.lock().unwrap();
                if transfers
                    .get(&expired)
                    .and_then(Option::as_ref)
                    .is_some_and(|idle| idle.deadline == deadline)
                {
                    transfers.remove(&expired);
                }
            }
        })
        .abort_handle();
        self.imports.transfers.lock().unwrap().insert(
            key,
            Some(IdleStage {
                stage: Some(stage),
                deadline,
                timer,
            }),
        );
    }
}

impl Imports {
    #[cfg(all(feature = "guest-files", target_os = "linux"))]
    pub(crate) fn is_active(&self) -> bool {
        !self.transfers.lock().unwrap().is_empty()
    }

    pub(crate) async fn execute(
        &self,
        root: &Path,
        context: &Value,
        request: &Value,
        scope: &Scope,
    ) -> Result<Value> {
        scope.check()?;
        let key = json!([
            &context["serverId"],
            &context["surfaceId"],
            &context["operationId"]
        ])
        .stringify();
        if request["type"] == "explorer.file.import.cancel" {
            let mut transfers = self.transfers.lock().unwrap();
            ensure!(
                !transfers.get(&key).is_some_and(Option::is_none),
                "This file import is already writing a chunk."
            );
            transfers.remove(&key);
            return Ok(receipt(0, Value::Null));
        }
        let (reserved, prior) = self.reserve(key)?;
        let mut stage = match prior {
            Some(stage) => stage,
            None => {
                ensure!(
                    context["sequence"] == 0 && request["offset"] == 0,
                    "The file import is unavailable. Drop the file again."
                );
                Stage::open(root, request).await?
            }
        };
        stage.write(root, request).await?;
        let offset = stage.offset;
        if request["eof"] == true {
            return Ok(receipt(offset, stage.publish(scope).await?));
        }
        reserved.park(stage);
        Ok(receipt(offset, Value::Null))
    }

    fn reserve(&self, key: String) -> Result<(Reservation<'_>, Option<Stage>)> {
        let mut transfers = self.transfers.lock().unwrap();
        match transfers.get(&key) {
            Some(None) => bail!("This file import is already writing a chunk."),
            None if transfers.len() >= MAX_ACTIVE => bail!("Too many file imports are active."),
            _ => {}
        }
        let prior = transfers
            .insert(key.clone(), None)
            .flatten()
            .filter(|idle| Instant::now() < idle.deadline)
            .and_then(|mut idle| idle.stage.take());
        Ok((
            Reservation {
                imports: self,
                key: Some(key),
            },
            prior,
        ))
    }
}

fn receipt(offset: u64, entry: Value) -> Value {
    json!({"type":"explorer.file.imported","value":json!({"offset":offset,"entry":entry})})
}

struct Stage {
    root: PathBuf,
    path: JsString,
    name: JsString,
    size: u64,
    offset: u64,
    directory: PathBuf,
    stamp: Stamp,
    file: File,
}

impl Stage {
    async fn open(root: &Path, request: &Value) -> Result<Self> {
        let path = request["path"].as_js_string().unwrap().clone();
        let (directory, _, stamp) = destination(root, &path).await?;
        Ok(Self {
            root: root.into(),
            path,
            name: request["name"].as_js_string().unwrap().clone(),
            size: request["size"].as_u64().unwrap(),
            offset: 0,
            directory,
            stamp,
            file: File::from_std(tempfile::tempfile()?),
        })
    }

    async fn write(&mut self, root: &Path, request: &Value) -> Result<()> {
        ensure!(
            self.root == root
                && request["path"].as_js_string() == Some(&self.path)
                && request["name"].as_js_string() == Some(&self.name)
                && request["size"].as_u64() == Some(self.size)
                && request["offset"].as_u64() == Some(self.offset),
            "The file import destination or offset changed."
        );
        let bytes = CHUNK_ENCODING.decode(request["data"].as_str().unwrap())?;
        let offset = self.offset + bytes.len() as u64;
        ensure!(
            bytes.len() <= CHUNK_BYTES
                && if request["eof"] == true {
                    offset == self.size
                } else {
                    !bytes.is_empty() && offset < self.size
                },
            "The file import chunk has an invalid size."
        );
        self.file.write_all(&bytes).await?;
        self.file.flush().await?;
        self.offset = offset;
        Ok(())
    }

    async fn publish(mut self, scope: &Scope) -> Result<Value> {
        scope.check()?;
        let (directory, handle, stamp) = destination(&self.root, &self.path).await?;
        ensure!(
            directory == self.directory && self.stamp.same_file(stamp),
            "The destination folder moved during the file import."
        );
        let name = host::native(&self.name);
        let (pending, mut output) = Pending::open(handle)?;
        self.file.rewind().await?;
        let copied = tokio::io::copy(&mut self.file, &mut output).await?;
        ensure!(copied == self.size, "The file import stopped writing.");
        output.flush().await?;
        output.sync_all().await?;
        let result = entry(
            &self.name,
            &joined(&self.path, &self.name),
            &output.metadata().await?,
            false,
        )?;
        drop(output);

        let (current, _, stamp) = destination(&self.root, &self.path).await?;
        ensure!(
            current == directory && self.stamp.same_file(stamp),
            "The destination folder moved during the file import."
        );
        scope.check()?;
        match pending
            .handle
            .hard_link(&pending.name, &pending.handle, &name)
        {
            Ok(()) => Ok(result),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                bail!("An entry named {} already exists.", self.name.lossy())
            }
            Err(error) => Err(io_error("copyfile", &directory.join(name), error)),
        }
    }
}

async fn destination(root: &Path, relative: &JsString) -> Result<(PathBuf, Dir, Stamp)> {
    let root = paths::canonical(root).await?;
    let destination = paths::mutable_directory(&root, relative).await?;
    let name = host::native(&host::relative(&root, &destination));
    let handle = Dir::open_ambient_dir(&root, ambient_authority())?.open_dir(name)?;
    let file = handle.try_clone()?.into_std_file();
    let stamp = Stamp::read(&file, &file.metadata()?)?;
    Ok((destination, handle, stamp))
}

struct Pending {
    handle: Dir,
    name: String,
}

impl Pending {
    fn open(handle: Dir) -> Result<(Self, File)> {
        let name = format!(".cantrip-import-{}", Uuid::new_v4());
        let mut options = cap_std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = handle.open_with(&name, &options)?.into_std();
        Ok((Self { handle, name }, File::from_std(file)))
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        let _ = self.handle.remove_file(&self.name);
    }
}
