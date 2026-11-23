//! Durable upload and replay of canonical history on a destination worker.
mod journal;
pub(crate) mod transcript;

use crate::{
    codex::preparation::command::Ensurer, encryption::Service, filesystem::Scope, http::checked,
    routing::Registry,
};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_crypto::content::attachment_digest;
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::HashMap,
    io::{ErrorKind, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::{
    fs::{self, File},
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::Mutex as Queue,
};
use zeroize::Zeroizing;

const BEGIN: &str = "chat.relocation.hydration.begin";
const CHUNK: &str = "chat.relocation.hydration.chunk";
const COMPLETE: &str = "chat.relocation.hydration.complete";
const RELEASE: &str = "chat.relocation.thread.release";
const MAX_SIZE: u64 = 256 * 1024 * 1024;
const MAX_CHUNK: usize = 256 * 1024;

pub(crate) fn supports(kind: &str) -> bool {
    matches!(kind, BEGIN | CHUNK | COMPLETE | RELEASE)
}

type Slot = Arc<Queue<Option<Upload>>>;

pub(crate) struct Manager {
    root: PathBuf,
    slots: Mutex<HashMap<String, Slot>>,
}

struct Upload {
    command: Value,
    binding: (JsString, Value),
    directory: PathBuf,
    file: File,
    size: u64,
    received: u64,
    next_chunk: u64,
}

impl Manager {
    pub(crate) fn new(data: &Path) -> Self {
        Self {
            root: data.join("chat-relocations"),
            slots: Mutex::default(),
        }
    }

    pub(crate) async fn execute(
        &self,
        command: &Value,
        registry: &Registry,
        service: &Arc<Service>,
        preparation: &Ensurer,
        scope: &Scope,
    ) -> Result<Value> {
        scope.check()?;
        let kind = command["type"]
            .as_str()
            .context("Missing relocation command.")?;
        if kind == RELEASE {
            return preparation.release_relocation(command).await;
        }

        let snapshot = command["snapshotId"]
            .as_str()
            .context("Missing relocation snapshot id.")?;
        ensure!(
            snapshot.len() == 36 && uuid::Uuid::parse_str(snapshot).is_ok(),
            "Relocation snapshot id is invalid."
        );
        let slot = {
            let mut slots = self.slots.lock().unwrap();
            slots.retain(|_, slot| {
                Arc::strong_count(slot) > 1 || slot.try_lock().is_ok_and(|state| state.is_some())
            });
            if kind == BEGIN {
                slots.entry(snapshot.to_owned()).or_default().clone()
            } else {
                slots
                    .get(snapshot)
                    .cloned()
                    .context("Relocation hydration was not started.")?
            }
        };
        let mut pending = tokio::select! {
            pending = slot.lock() => pending,
            _ = scope.stopped() => bail!("Relocation hydration stopped."),
        };
        scope.check()?;
        let binding = service.bound_identity()?;
        if kind == BEGIN {
            let command = registry.resolve(command).await?;
            let directory = self.root.join(snapshot);
            if let Some(stored) = journal::read(&directory, &command, &binding)?
                && stored["status"] == "hydrated"
                && preparation
                    .has_hydrated_thread(
                        &command,
                        &binding,
                        stored["threadId"].as_js_string().unwrap(),
                    )
                    .await?
            {
                return checked(
                    "chatRelocationHydrationBeginResultSchema",
                    &json!({"status":"hydrated","threadId":stored["threadId"]}),
                );
            }
            if let Some(previous) = pending.take() {
                previous.discard().await?;
            }
            *pending = Some(Upload::new(command, binding, directory).await?);
            return checked(
                "chatRelocationHydrationBeginResultSchema",
                &json!({"status":"upload"}),
            );
        }

        let upload = pending
            .as_mut()
            .context("Relocation hydration was not started.")?;
        ensure!(
            upload.binding == binding,
            "The worker binding changed during relocation hydration."
        );
        if kind == CHUNK {
            upload.append(command).await?;
            return Ok(json!({"accepted":true}));
        }

        let payload = upload.read(service.clone()).await?;
        let stored = journal::read(&upload.directory, &upload.command, &binding)?;
        let abandoned = stored
            .as_ref()
            .and_then(|state| state["threadId"].as_js_string());
        let thread = preparation
            .hydrate_relocation(
                &upload.command,
                &payload,
                &binding,
                abandoned,
                |thread| {
                    journal::save(
                        &upload.directory,
                        &upload.command,
                        &binding,
                        "hydrating",
                        thread,
                    )
                },
                scope,
            )
            .await?;
        scope.check()?;
        ensure!(
            service.bound_identity()? == binding,
            "The worker binding changed during relocation hydration."
        );
        let result = checked(
            "chatRelocationHydrationResultSchema",
            &json!({"snapshotId":snapshot,"transcriptSha256":upload.command["transcriptSha256"],
                    "threadId":thread,"reused":false}),
        )?;
        journal::save(
            &upload.directory,
            &upload.command,
            &binding,
            "hydrated",
            &thread,
        )?;
        if let Some(upload) = pending.take() {
            upload.discard().await?;
        }
        Ok(result)
    }

    pub(crate) async fn close(&self) {
        let slots = std::mem::take(&mut *self.slots.lock().unwrap());
        for slot in slots.into_values() {
            if let Some(upload) = slot.lock().await.take() {
                let _ = upload.discard().await;
            }
        }
    }
}

impl Upload {
    async fn new(command: Value, binding: (JsString, Value), directory: PathBuf) -> Result<Self> {
        let size = command["sizeBytes"]
            .as_u64()
            .context("Missing relocation upload size.")?;
        ensure!(
            size <= MAX_SIZE,
            "Relocation hydration exceeds its declared size."
        );
        cantrip_host::files::private_directory(&directory)?;
        let path = directory.join("context.uploading");
        remove(&path).await?;
        let mut options = fs::OpenOptions::new();
        options.create_new(true).read(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let file = options.open(&path).await?;
        Ok(Self {
            command,
            binding,
            directory,
            file,
            size,
            received: 0,
            next_chunk: 0,
        })
    }

    async fn append(&mut self, command: &Value) -> Result<()> {
        let index = command["chunkIndex"]
            .as_u64()
            .context("Missing relocation chunk index.")?;
        let data = command["data"]
            .as_str()
            .context("Missing relocation chunk data.")?;
        let bytes = Zeroizing::new(STANDARD.decode(data)?);
        ensure!(
            self.next_chunk == index && bytes.len() <= MAX_CHUNK,
            "Expected relocation chunk {}, received {index}.",
            self.next_chunk
        );
        let received = self.received + bytes.len() as u64;
        ensure!(
            received <= self.size,
            "Relocation hydration exceeds its declared size."
        );
        self.file.seek(SeekFrom::Start(self.received)).await?;
        self.file.write_all(&bytes).await?;
        self.file.flush().await?;
        self.file.set_len(received).await?;
        self.received = received;
        self.next_chunk += 1;
        Ok(())
    }

    async fn read(&mut self, service: Arc<Service>) -> Result<transcript::Opened> {
        ensure!(
            self.received == self.size,
            "Relocation hydration is incomplete ({}/{} bytes).",
            self.received,
            self.size
        );
        let mut bytes = Zeroizing::new(Vec::with_capacity(self.size as usize));
        self.file.seek(SeekFrom::Start(0)).await?;
        (&mut self.file)
            .take(self.size + 1)
            .read_to_end(&mut bytes)
            .await?;
        ensure!(
            bytes.len() as u64 == self.size,
            "Relocation transcript size changed."
        );
        let digest = self.command["transcriptSha256"].clone();
        let binding = self.binding.clone();
        tokio::task::spawn_blocking(move || {
            ensure!(
                digest == attachment_digest(&bytes).as_str(),
                "Relocation transcript digest verification failed."
            );
            transcript::open(&bytes, &service, &binding)
        })
        .await?
    }

    async fn discard(self) -> Result<()> {
        drop(self.file);
        remove(&self.directory.join("context.uploading")).await
    }
}

async fn remove(path: &Path) -> Result<()> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
