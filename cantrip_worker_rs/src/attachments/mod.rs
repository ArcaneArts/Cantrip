//! Ordinary local attachment uploads. History uses exactly the same paths and
//! chunk/verification rules as later command and stream adapters.
pub(crate) mod commands;
pub mod content;
pub mod paths;
use crate::{filesystem::paths as host, logging::Logs};
use anyhow::{Result, bail};
use cantrip_crypto::{Zeroizing, content::attachment_digest};
use cantrip_history::projection::Work;
use cantrip_transport::lifecycle::owned;
use cantrip_wire::{JsString, Value, value::json};
use paths::{MAX_BYTES, MAX_CHUNK_BYTES, safe_filename, segment};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio::{fs, io::AsyncWriteExt};

struct Pending {
    ended: bool,
    expected_hash: String,
    expected: usize,
    final_path: PathBuf,
    next: usize,
    operation: JsString,
    part: PathBuf,
    received: usize,
}
struct Inner {
    root: PathBuf,
    uploads: Mutex<HashMap<String, Arc<Mutex<Pending>>>>,
    logs: Option<Arc<Logs>>,
}
#[derive(Clone)]
pub struct Store(Arc<Inner>);
pub struct Read {
    pub bytes: Zeroizing<Vec<u8>>,
    pub eof: bool,
    pub size_bytes: usize,
}
impl Store {
    pub fn new(data: &Path, logs: Option<Arc<Logs>>) -> Result<Self> {
        Ok(Self(Arc::new(Inner {
            root: host::resolve(&data.join("attachments"))?,
            uploads: Mutex::new(HashMap::new()),
            logs,
        })))
    }
    fn key(chat: &JsString, id: &JsString) -> Result<String> {
        Ok(format!(
            "{}:{}",
            segment(chat, "Chat id")?,
            segment(id, "Attachment id")?
        ))
    }
    fn directory(&self, chat: &JsString, id: &JsString) -> Result<PathBuf> {
        let directory = self
            .0
            .root
            .join(segment(chat, "Chat id")?)
            .join(segment(id, "Attachment id")?);
        if !directory.starts_with(&self.0.root) {
            bail!("Attachment path escapes the worker data directory.");
        }
        Ok(directory)
    }
    pub fn resolve(&self, chat: &JsString, id: &JsString, filename: &JsString) -> Result<PathBuf> {
        Ok(self
            .directory(chat, id)?
            .join(host::native(&safe_filename(filename))))
    }
    pub(crate) async fn store_bytes(
        &self,
        chat: &JsString,
        id: &JsString,
        filename: JsString,
        bytes: &[u8],
        digest: String,
    ) -> Result<()> {
        let operation: JsString = uuid::Uuid::new_v4().to_string().into();
        self.begin(
            chat.clone(),
            id.clone(),
            filename,
            bytes.len() as f64,
            operation.clone(),
            digest,
        )
        .await?;
        let uploaded = async {
            let count = bytes.len().div_ceil(MAX_CHUNK_BYTES).max(1);
            for index in 0..count {
                let start = index * MAX_CHUNK_BYTES;
                let end = (start + MAX_CHUNK_BYTES).min(bytes.len());
                self.append(
                    chat.clone(),
                    id.clone(),
                    index as f64,
                    Zeroizing::new(bytes[start..end].to_vec()),
                    operation.clone(),
                    index == count - 1,
                )
                .await?;
            }
            self.complete(chat.clone(), id.clone(), operation.clone())
                .await?;
            Ok(())
        }
        .await;
        if let Err(error) = uploaded {
            self.abort(chat.clone(), id.clone(), operation).await?;
            return Err(error);
        }
        Ok(())
    }
    fn pending(&self, key: &str, operation: &JsString) -> Result<Arc<Mutex<Pending>>> {
        let upload = self
            .0
            .uploads
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Attachment upload was not started."))?;
        if upload.lock().unwrap().operation != *operation {
            bail!("Attachment upload operation does not match.");
        }
        Ok(upload)
    }
    fn log(&self, level: &str, message: &str, context: Value) {
        if let Some(logs) = &self.0.logs {
            logs.event(level, message, context);
        }
    }
    pub fn begin(
        &self,
        chat: JsString,
        id: JsString,
        filename: JsString,
        size: f64,
        operation: JsString,
        hash: String,
    ) -> Work<()> {
        let this = self.clone();
        owned(async move {
            let started = Instant::now();
            if !size.is_finite() || size.fract() != 0. || size < 0. || size > MAX_BYTES as f64 {
                bail!("Attachment size must be between 0 and 26214400 bytes.");
            }
            let key = Self::key(&chat, &id)?;
            if this.0.uploads.lock().unwrap().contains_key(&key) {
                bail!("This attachment upload is already active.");
            }
            let final_path = this.resolve(&chat, &id, &filename)?;
            let directory = final_path.parent().unwrap();
            let part = directory.join(".uploading");
            fs::create_dir_all(directory)
                .await
                .map_err(|e| crate::filesystem::explorer::io_error("mkdir", directory, e))?;
            remove_file(&part).await?;
            fs::write(&part, [])
                .await
                .map_err(|e| crate::filesystem::explorer::io_error("open", &part, e))?;
            this.0.uploads.lock().unwrap().insert(
                key,
                Arc::new(Mutex::new(Pending {
                    ended: false,
                    expected_hash: hash,
                    expected: size as usize,
                    final_path,
                    next: 0,
                    operation,
                    part,
                    received: 0,
                })),
            );
            this.log("debug", "Attachment upload started", json!({"event":"attachment.upload.started","subsystem":"attachments","operation":"upload","status":"started","chatId":chat,"attachmentId":id,"durationMs":started.elapsed().as_millis(),"counts":json!({"bytesExpected":size})}));
            Ok(())
        })
    }
    pub fn append(
        &self,
        chat: JsString,
        id: JsString,
        index: f64,
        bytes: Zeroizing<Vec<u8>>,
        operation: JsString,
        eof: bool,
    ) -> Work<()> {
        let this = self.clone();
        owned(async move {
            if !index.is_finite()
                || index.fract() != 0.
                || index < 0.
                || bytes.len() > MAX_CHUNK_BYTES
            {
                bail!("Attachment chunk is invalid.");
            }
            let upload = this.pending(&Self::key(&chat, &id)?, &operation)?;
            let part = {
                let value = upload.lock().unwrap();
                if value.ended {
                    bail!("Attachment upload stream has already ended.");
                }
                if index != value.next as f64 {
                    bail!(
                        "Expected attachment chunk {}, received {}.",
                        value.next,
                        cantrip_wire::coercion::string(&Value::Number(index))
                            .unwrap()
                            .lossy()
                    );
                }
                let received = value.received + bytes.len();
                if received > value.expected {
                    bail!("Attachment upload exceeds its declared size.");
                }
                if eof != (received == value.expected) {
                    bail!("Attachment upload end marker is invalid.");
                }
                value.part.clone()
            };
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&part)
                .await
                .map_err(|e| crate::filesystem::explorer::io_error("open", &part, e))?;
            file.write_all(&bytes)
                .await
                .map_err(|e| crate::filesystem::explorer::io_error("write", &part, e))?;
            drop(file);
            let mut value = upload.lock().unwrap();
            value.next += 1;
            value.received += bytes.len();
            value.ended = eof;
            Ok(())
        })
    }
    pub fn complete(&self, chat: JsString, id: JsString, operation: JsString) -> Work<Value> {
        let this = self.clone();
        owned(async move {
            let key = Self::key(&chat, &id)?;
            let upload = this.pending(&key, &operation)?;
            let (part, final_path, expected, hash, chunks) = {
                let v = upload.lock().unwrap();
                if v.received != v.expected {
                    bail!(
                        "Attachment upload is incomplete ({}/{} bytes).",
                        v.received,
                        v.expected
                    );
                }
                if !v.ended {
                    bail!("Attachment upload stream did not end.");
                }
                (
                    v.part.clone(),
                    v.final_path.clone(),
                    v.expected,
                    v.expected_hash.clone(),
                    v.next,
                )
            };
            let bytes = Zeroizing::new(
                fs::read(&part)
                    .await
                    .map_err(|e| crate::filesystem::explorer::io_error("open", &part, e))?,
            );
            let actual = attachment_digest(&bytes);
            drop(bytes);
            if actual != hash {
                remove_file(&part).await?;
                this.0.uploads.lock().unwrap().remove(&key);
                bail!("Attachment content verification failed.");
            }
            fs::rename(part, final_path).await?;
            this.0.uploads.lock().unwrap().remove(&key);
            this.log("info", "Attachment upload completed", json!({"event":"attachment.upload.completed","subsystem":"attachments","operation":"upload","status":"completed","chatId":chat,"attachmentId":id,"counts":json!({"bytes":expected,"chunks":chunks})}));
            Ok(json!({"sizeBytes":expected,"verified":true}))
        })
    }
    pub fn read(
        &self,
        chat: JsString,
        id: JsString,
        filename: JsString,
        offset: f64,
        limit: f64,
    ) -> Work<Read> {
        let this = self.clone();
        owned(async move {
            if !offset.is_finite()
                || offset.fract() != 0.
                || offset < 0.
                || !limit.is_finite()
                || limit.fract() != 0.
                || limit < 1.
                || limit > MAX_CHUNK_BYTES as f64
            {
                bail!("Attachment read range is invalid.");
            }
            let file = this.resolve(&chat, &id, &filename)?;
            if !fs::metadata(&file)
                .await
                .map_err(|e| crate::filesystem::explorer::io_error("stat", &file, e))?
                .is_file()
            {
                bail!("Attachment is not a file.");
            }
            let bytes = Zeroizing::new(
                fs::read(&file)
                    .await
                    .map_err(|e| crate::filesystem::explorer::io_error("open", &file, e))?,
            );
            let end = (offset + limit).min(bytes.len() as f64) as usize;
            let start = offset.min(bytes.len() as f64) as usize;
            Ok(Read {
                bytes: Zeroizing::new(bytes[start..end].to_vec()),
                eof: end >= bytes.len(),
                size_bytes: bytes.len(),
            })
        })
    }
    pub fn remove(&self, chat: JsString, id: JsString) -> Work<()> {
        let this = self.clone();
        owned(async move {
            let directory = this.directory(&chat, &id)?;
            this.0
                .uploads
                .lock()
                .unwrap()
                .remove(&Self::key(&chat, &id)?);
            match fs::remove_dir_all(directory).await {
                Ok(()) => (),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e.into()),
            }
            this.log("debug", "Attachment removed", json!({"event":"attachment.removed","subsystem":"attachments","operation":"remove","status":"completed","chatId":chat,"attachmentId":id}));
            Ok(())
        })
    }
    pub fn abort(&self, chat: JsString, id: JsString, operation: JsString) -> Work<bool> {
        let this = self.clone();
        owned(async move {
            let key = Self::key(&chat, &id)?;
            let upload = this.0.uploads.lock().unwrap().get(&key).cloned();
            let Some(upload) = upload else {
                return Ok(false);
            };
            let part = {
                let v = upload.lock().unwrap();
                if v.operation != operation {
                    return Ok(false);
                }
                v.part.clone()
            };
            remove_file(&part).await?;
            this.0.uploads.lock().unwrap().remove(&key);
            Ok(true)
        })
    }
}
async fn remove_file(path: &Path) -> Result<()> {
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
