//! Flush actual ordinary attachment bytes before publishing immutable opaque
//! descriptors. Committed ciphertext survives worker relocation and retries.
use crate::{
    attachments::{
        Store as Files,
        content::{self, Keys},
        paths::{MAX_BYTES, MAX_CHUNK_BYTES, safe_filename},
    },
    filesystem::paths,
    native_items::{checked, obj, s, text},
};
use anyhow::{Result, bail};
use cantrip_crypto::{Zeroizing, content::attachment_digest as hash};
use cantrip_history::{files, projection::Work, reducer::equal};
use cantrip_wire::{Value, value::json};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::fs;
use uuid::Uuid;

pub struct Input {
    pub identity: Value,
    pub part_index: f64,
    pub file_name: cantrip_wire::JsString,
    pub mime_type: cantrip_wire::JsString,
    pub kind: cantrip_wire::JsString,
    pub bytes: Zeroizing<Vec<u8>>,
    pub published_attachment: Option<Value>,
}
pub struct Materialized {
    pub attachment: Value,
    pub content: Value,
}
struct Inner {
    directory: PathBuf,
    binding: Value,
    keys: Arc<dyn Keys>,
    files: Files,
}
#[derive(Clone)]
pub struct Store(Arc<Inner>);
impl Store {
    pub fn new(
        directory: PathBuf,
        binding: Value,
        keys: Arc<dyn Keys>,
        files: Files,
    ) -> Result<Self> {
        Ok(Self(Arc::new(Inner {
            directory: paths::resolve(&directory)?,
            binding,
            keys,
            files,
        })))
    }
    pub fn materialize(&self, input: Input) -> Work<Materialized> {
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let identity = checked("nativeHistoryItemIdentitySchema", &input.identity)?;
            let binding = &this.0.binding;
            if identity["threadId"] != binding["threadId"]
                || !input.part_index.is_finite()
                || input.part_index.fract() != 0.
                || input.part_index < 0.
                || input.part_index > 9007199254740991.
            {
                bail!("Native attachment identity does not match its source binding.");
            }
            if input.bytes.len() > MAX_BYTES {
                bail!("Native attachment exceeds the attachment size limit.");
            }
            let digest = hash(&input.bytes);
            let metadata = checked(
                "attachmentMetadataProtectedContentSchema",
                &json!({"version":1,"fileName":safe_filename(&input.file_name),"mimeType":input.mime_type,"kind":input.kind,"source":"file","previewText":Value::Null,"sha256":digest,"error":Value::Null}),
            )?;
            let (owner, server) = this.0.keys.attachment_identity()?;
            let seed = Value::Array(vec![
                s("native-attachment-v1"),
                s(server.clone()),
                s(owner.clone()),
                binding["chatId"].clone(),
                identity,
                Value::Number(input.part_index),
                metadata.clone(),
            ])
            .stringify();
            let hex = hash(seed.as_bytes());
            let mut bytes = [0; 16];
            for (i, byte) in bytes.iter_mut().enumerate() {
                *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)?;
            }
            bytes[6] = (bytes[6] & 15) | 0x50;
            bytes[8] = (bytes[8] & 63) | 0x80;
            let id = json!(Uuid::from_bytes(bytes).to_string());
            let expected = Expected {
                id,
                chat: binding["chatId"].clone(),
                size: input.bytes.len(),
                digest,
                metadata,
            };
            let supplied = input
                .published_attachment
                .as_ref()
                .filter(|v| cantrip_wire::coercion::truthy(Some(v)))
                .map(|v| this.validate(v, &expected))
                .transpose()?;
            let directory = this
                .0
                .directory
                .join(hash(
                    Value::Array(vec![
                        s(server),
                        s(owner),
                        binding["workerId"].clone(),
                        binding["chatId"].clone(),
                    ])
                    .stringify()
                    .as_bytes(),
                ))
                .join(text(&expected.id)?.lossy().as_ref());
            let queue = files::queue(&directory);
            queue.run_async(async move {
                ensure(directory.clone()).await?;
                let manifest = directory.join("attachment.json");
                let published_manifest = directory.join("published-attachment.json");
                let published = read_optional(published_manifest.clone()).await?.map(|v| this.validate(&v, &expected)).transpose()?;
                let local = read_optional(manifest.clone()).await?.map(|v| this.validate(&v, &expected)).transpose()?;
                if supplied.as_ref().zip(published.as_ref()).is_some_and(|(a,b)| !equal(a,b)) { bail!("Published native attachment metadata changed."); }
                let mut saved = supplied.clone().or_else(|| published.clone()).or(local);
                let chat = text(&expected.chat)?.clone(); let id = text(&expected.id)?.clone(); let filename = text(&expected.metadata["fileName"])?.clone();
                let file = this.0.files.resolve(&chat, &id, &filename)?;
                let verified = match fs::read(&file).await {
                    Ok(bytes) => { let bytes = Zeroizing::new(bytes); bytes.len() == input.bytes.len() && hash(&bytes) == expected.digest },
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
                    Err(e) => return Err(crate::filesystem::explorer::io_error("open", &file, e)),
                };
                if !verified {
                    ensure(file.parent().unwrap().to_path_buf()).await?;
                    let operation: cantrip_wire::JsString = Uuid::new_v4().to_string().into();
                    this.0.files.begin(chat.clone(), id.clone(), filename, input.bytes.len() as f64, operation.clone(), expected.digest.clone()).await?;
                    let upload: Result<()> = async {
                        let count = input.bytes.len().div_ceil(MAX_CHUNK_BYTES).max(1);
                        for index in 0..count {
                            let start = index * MAX_CHUNK_BYTES;
                            let end = ((index + 1) * MAX_CHUNK_BYTES).min(input.bytes.len());
                            this.0.files.append(chat.clone(), id.clone(), index as f64, Zeroizing::new(input.bytes[start..end].to_vec()), operation.clone(), index == count - 1).await?;
                        }
                        this.0.files.complete(chat.clone(), id.clone(), operation.clone()).await?;
                        Ok(())
                    }.await;
                    if let Err(error) = upload { this.0.files.abort(chat, id, operation).await?; return Err(error); }
                }
                let handle = fs::File::open(&file).await?;
                handle.sync_all().await?;
                drop(handle);
                flush(file.parent().unwrap().to_path_buf()).await?;
                if saved.is_none() {
                    let protected = content::protect(this.0.keys.as_ref(), &expected.chat, &expected.id, &expected.metadata)?;
                    let prepared = checked("chatAttachmentOpaqueSummarySchema", &json!({"id":expected.id,"chatId":expected.chat,"sizeBytes":input.bytes.len(),"status":"ready","createdAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"protectedMetadata":protected}))?;
                    write(manifest.clone(), prepared).await?;
                    saved = Some(checked("chatAttachmentOpaqueSummarySchema", &read_required(manifest).await?)?);
                }
                if let Some(supplied) = supplied.as_ref().filter(|_| published.is_none()) {
                    write(published_manifest.clone(), supplied.clone()).await?;
                    let committed = this.validate(&read_required(published_manifest).await?, &expected)?;
                    if !equal(&committed, supplied) { bail!("Published native attachment metadata changed."); }
                    saved = Some(committed);
                }
                let attachment = this.validate(&saved.unwrap(), &expected)?;
                let opened = content::open(this.0.keys.as_ref(), &attachment)?;
                let summary = checked("chatAttachmentSummarySchema", &opened)?;
                Ok(Materialized { attachment, content: Value::Array(vec![obj([("type",s("attachment")), ("attachment",summary)])]) })
            }).await
        })
    }
    fn validate(&self, raw: &Value, expected: &Expected) -> Result<Value> {
        let descriptor = checked("chatAttachmentOpaqueSummarySchema", raw)?;
        let opened = content::open(self.0.keys.as_ref(), &descriptor)?;
        if descriptor["id"] != expected.id
            || descriptor["chatId"] != expected.chat
            || descriptor["status"] != "ready"
            || descriptor["sizeBytes"].as_u64() != Some(expected.size as u64)
            || opened["sha256"] != expected.digest.as_str()
            || ["fileName", "mimeType", "kind"]
                .iter()
                .any(|k| opened[*k] != expected.metadata[*k])
            || opened["source"] != "file"
        {
            bail!("Native attachment metadata conflicts with its source.");
        }
        Ok(descriptor)
    }
}
struct Expected {
    id: Value,
    chat: Value,
    size: usize,
    digest: String,
    metadata: Value,
}
pub(super) async fn ensure(path: PathBuf) -> Result<()> {
    tokio::task::spawn_blocking(move || files::ensure_directory(&path)).await?
}
async fn flush(path: PathBuf) -> Result<()> {
    tokio::task::spawn_blocking(move || files::flush_directory(&path)).await?
}
pub(super) async fn read_required(path: PathBuf) -> Result<Value> {
    tokio::task::spawn_blocking(move || files::read_json(&path)).await?
}
pub(super) async fn read_optional(path: PathBuf) -> Result<Option<Value>> {
    match read_required(path).await {
        Ok(value) => Ok(Some(value)),
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}
pub(super) async fn write(path: PathBuf, value: Value) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        files::write_immutable(&path, &value.stringify()).map(|_| ())
    })
    .await?
}

pub(super) fn not_found(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound)
}
pub(super) fn io(operation: &str, path: &Path, error: std::io::Error) -> anyhow::Error {
    let display =
        crate::filesystem::explorer::io_error(operation, path, std::io::Error::from(error.kind()))
            .to_string();
    anyhow::Error::new(error).context(display)
}
