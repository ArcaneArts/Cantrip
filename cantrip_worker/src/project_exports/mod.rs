//! Existing Core-owned export relay. The worker holds the decryption keys and
//! owns staging and publication into the external Codex installation.
mod codex;
mod journal;
mod transcript;

use crate::{
    codex::external_home::Home, encryption::Service, filesystem::Scope, http::checked,
    routing::Registry,
};
use anyhow::{Context, Result, ensure};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
};
use cantrip_config::Environment;
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

const INSPECT: &str = "project.export.target.inspect";
const BEGIN: &str = "project.export.chat.begin";
const CHUNK: &str = "project.export.chat.chunk";
const COMPLETE: &str = "project.export.chat.complete";
const MAXIMUM: u64 = 256 * 1024 * 1024;
type Key = (JsString, JsString);
type Slot = Arc<Queue<Option<Upload>>>;

pub(crate) fn supports(kind: &str) -> bool {
    matches!(kind, INSPECT | BEGIN | CHUNK | COMPLETE)
}

pub(crate) struct Manager {
    root: PathBuf,
    adapter: codex::Adapter,
    slots: Mutex<HashMap<Key, Slot>>,
}

struct Upload {
    command: Value,
    home: Home,
    identity: Value,
    directory: PathBuf,
    path: PathBuf,
    file: File,
    received: u64,
    next_chunk: u64,
    size: u64,
}

impl Manager {
    pub(crate) fn new(binary: &Path, data: &Path, cwd: &Path, environment: &Environment) -> Self {
        Self {
            root: data.join("project-exports"),
            adapter: codex::Adapter::new(binary, data, cwd, environment),
            slots: Mutex::default(),
        }
    }

    pub(crate) async fn execute(
        &self,
        command: &Value,
        registry: &Registry,
        service: &Arc<Service>,
        scope: &Scope,
    ) -> Result<Value> {
        scope.check()?;
        let kind = command["type"]
            .as_str()
            .context("Missing project export command.")?;
        if kind == INSPECT {
            return self
                .adapter
                .inspect(&registry.resolve(command).await?, scope)
                .await;
        }
        let key = (text(command, "operationId")?, text(command, "chatId")?);
        let slot = {
            let mut slots = self.slots.lock().unwrap();
            slots.retain(|_, slot| {
                Arc::strong_count(slot) > 1 || slot.try_lock().is_ok_and(|state| state.is_some())
            });
            if kind == BEGIN {
                slots.entry(key).or_default().clone()
            } else {
                slots
                    .get(&key)
                    .cloned()
                    .context("Project export upload was not started.")?
            }
        };
        let mut guard = tokio::select! {
            guard = slot.lock() => guard,
            _ = scope.stopped() => return Err(anyhow::anyhow!("The worker stopped the project export.")),
        };
        scope.check()?;
        if kind == BEGIN {
            let command = registry.resolve(command).await?;
            return self.begin(command, &mut guard, scope).await;
        }
        let upload = guard
            .as_mut()
            .context("Project export upload was not started.")?;
        match kind {
            CHUNK => upload.append(command).await,
            COMPLETE => {
                let result = self.complete(upload, service.clone(), scope).await?;
                if let Some(upload) = guard.take() {
                    upload.discard().await;
                }
                Ok(result)
            }
            _ => anyhow::bail!("Unknown project export command."),
        }
    }

    async fn begin(
        &self,
        command: Value,
        slot: &mut Option<Upload>,
        scope: &Scope,
    ) -> Result<Value> {
        let destination = self.adapter.destination(&command["cwd"]).await?;
        let directory = journal::directory(&self.root, &command)?;
        let identity = journal::identity(&command, &destination.fingerprint)?;
        if let Some(stored) = journal::read(&directory, &identity)?
            && stored["status"] == "exported"
        {
            return checked(
                "projectExportChatBeginResultSchema",
                &json!({
                    "status":"exported","chatId":command["chatId"],"threadId":stored["threadId"],
                    "destinationLabel":stored["destinationLabel"],"messageCount":stored["messageCount"],"reused":true,
                }),
            );
        }
        let size = command["sizeBytes"]
            .as_u64()
            .context("Missing export size.")?;
        ensure!(
            size <= MAXIMUM,
            "Project export upload exceeds its declared limit."
        );
        scope.check()?;
        if let Some(upload) = slot.take() {
            upload.discard().await;
        }
        cantrip_host::files::private_directory(&directory)?;
        let path = directory.join("transcript.uploading");
        match fs::remove_file(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let mut options = fs::OpenOptions::new();
        options.create_new(true).read(true).write(true);
        #[cfg(unix)]
        options.mode(0o600);
        let file = options.open(&path).await?;
        *slot = Some(Upload {
            command,
            home: destination,
            identity,
            path,
            directory,
            file,
            received: 0,
            next_chunk: 0,
            size,
        });
        checked(
            "projectExportChatBeginResultSchema",
            &json!({"status":"upload"}),
        )
    }

    async fn complete(
        &self,
        upload: &mut Upload,
        service: Arc<Service>,
        scope: &Scope,
    ) -> Result<Value> {
        ensure!(
            upload.received == upload.size,
            "Project export upload is incomplete ({}/{} bytes).",
            upload.received,
            upload.size
        );
        let mut bytes = Vec::with_capacity(upload.received as usize);
        upload.file.seek(SeekFrom::Start(0)).await?;
        (&mut upload.file)
            .take(upload.size + 1)
            .read_to_end(&mut bytes)
            .await?;
        let command = upload.command.clone();
        let transcript = tokio::task::spawn_blocking(move || {
            ensure!(
                command["transcriptSha256"] == journal::digest(&bytes).as_str(),
                "Project export transcript digest verification failed."
            );
            transcript::open(&bytes, &command, &service)
        })
        .await??;
        let message_count = transcript.message_count;
        let stored = journal::read(&upload.directory, &upload.identity)?;
        let abandoned = stored
            .as_ref()
            .and_then(|state| state["threadId"].as_js_string());
        let save = |status, thread: &JsString| {
            journal::save(
                &upload.directory,
                &upload.identity,
                status,
                thread,
                upload.home.label,
                message_count,
            )
        };
        let thread = self
            .adapter
            .export(
                &upload.command["cwd"],
                &upload.home,
                abandoned,
                transcript,
                |thread| save("exporting", thread),
                scope,
            )
            .await?;
        let result = checked(
            "projectExportChatResultSchema",
            &json!({
                "chatId":upload.command["chatId"],"threadId":thread,
                "destinationLabel":upload.home.label,"messageCount":message_count,"reused":false,
            }),
        )?;
        save("exported", &thread)?;
        Ok(result)
    }

    pub(crate) async fn close(&self) {
        let slots = std::mem::take(&mut *self.slots.lock().unwrap());
        for slot in slots.into_values() {
            if let Some(upload) = slot.lock().await.take() {
                upload.discard().await;
            }
        }
    }
}

impl Upload {
    async fn append(&mut self, command: &Value) -> Result<Value> {
        let index = command["chunkIndex"]
            .as_u64()
            .context("Missing project export chunk index.")?;
        let encoded = command["data"]
            .as_str()
            .context("Missing project export chunk data.")?;
        let bytes = STANDARD
            .decode(encoded)
            .or_else(|_| STANDARD_NO_PAD.decode(encoded))
            .context("Invalid project export chunk data.")?;
        ensure!(
            index == self.next_chunk && bytes.len() <= 256 * 1024,
            "Expected project export chunk {}, received {}.",
            self.next_chunk,
            index
        );
        let received = self.received + bytes.len() as u64;
        ensure!(
            received <= self.size,
            "Project export upload exceeds its declared size."
        );
        self.file.seek(SeekFrom::Start(self.received)).await?;
        self.file.write_all(&bytes).await?;
        self.file.flush().await?;
        self.received = received;
        self.next_chunk += 1;
        Ok(json!({"accepted":true}))
    }

    async fn discard(self) {
        drop(self.file);
        let _ = fs::remove_file(self.path).await;
    }
}

fn text(command: &Value, field: &str) -> Result<JsString> {
    command[field]
        .as_js_string()
        .cloned()
        .context("Missing project export identity.")
}
