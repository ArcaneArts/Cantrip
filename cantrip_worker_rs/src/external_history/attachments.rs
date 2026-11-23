use crate::{
    attachments::{
        content::{self, ServiceKeys},
        paths::{MAX_BYTES, MAX_CHUNK_BYTES},
    },
    encryption::Service,
    filesystem::{Scope, paths},
    http::checked,
    native_items::{concat, slice},
};
use anyhow::{Context, Result, ensure};
use cantrip_crypto::{
    Zeroizing,
    content::{attachment_digest, encrypt_attachment_chunk},
};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{ErrorKind, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime},
};

const TOTAL_BYTES: u64 = 100 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub(super) struct Store(PathBuf);

struct Candidate {
    id: String,
    item: JsString,
    kind: &'static str,
    path: Option<PathBuf>,
    url: Option<JsString>,
}

impl Store {
    pub(super) fn new(data: &Path) -> Self {
        Self(data.join("external-chat-imports"))
    }

    pub(super) fn stage_thread(
        &self,
        input: &Value,
        thread: &Value,
        roots: &[PathBuf],
        service: Arc<Service>,
        scope: &Scope,
    ) -> Result<Vec<Value>> {
        self.cleanup_expired();
        self.release(input)?;
        let cwd = paths::native(
            thread["cwd"]
                .as_js_string()
                .context("External attachment cwd.")?,
        );
        let mut remaining = TOTAL_BYTES;
        let mut descriptors = Vec::new();
        let directory = self.thread_directory(input)?;
        for candidate in candidates(input, thread, &cwd)? {
            scope.check()?;
            let staged = candidate.stage(&directory, roots, remaining);
            let id = imported_id(&input["chatId"], &staged["id"])?;
            let metadata = content::protect(
                &ServiceKeys(service.clone()),
                &input["chatId"],
                &json!(id),
                &json!({
                    "version":1,"fileName":staged["fileName"],"mimeType":staged["mimeType"],
                    "kind":staged["kind"],"source":"file","previewText":Value::Null,
                    "sha256":staged["sha256"].as_str().map(str::to_owned).unwrap_or_else(|| "0".repeat(64)),
                    "error":staged["warning"],
                }),
            )?;
            let descriptor = checked(
                "externalChatAttachmentSchema",
                &json!({
                    "id":id,"sourceAttachmentId":staged["id"],"itemId":staged["itemId"],
                    "sizeBytes":staged["sizeBytes"],"status":staged["status"],"protectedMetadata":metadata,
                }),
            )?;
            if descriptor["status"] == "available" {
                remaining -= descriptor["sizeBytes"].as_u64().unwrap();
            }
            descriptors.push(descriptor);
        }
        Ok(descriptors)
    }

    pub(super) fn read(&self, command: &Value, service: &Service) -> Result<Value> {
        let bound = service.bound_identity()?;
        ensure!(
            command["ownerId"].as_js_string() == Some(&bound.0),
            "Attachment owner does not match this worker."
        );
        let result = self.read_staged(command);
        let Ok((bytes, eof, size)) = result else {
            return checked(
                "externalChatAttachmentReadResultSchema",
                &json!({"status":"unavailable","reasonCode":"missing"}),
            );
        };
        let grant = service.bound_component("attachment-content", None)?;
        ensure!(
            (grant.owner_id.clone(), grant.server_id.clone()) == bound,
            "The worker binding changed while reading an external attachment."
        );
        let context = json!({"ownerId":grant.owner_id,"chatId":command["chatId"],
            "attachmentId":command["targetAttachmentId"],"operationId":command["operationId"],
            "direction":"relay","sequence":command["sequence"],"eof":eof,"keyRevision":grant.component.key_revision});
        let chunk = encrypt_attachment_chunk(&grant.component.key, &context, &bytes)?;
        ensure!(
            service.bound_identity()? == bound,
            "The worker binding changed while reading an external attachment."
        );
        checked(
            "externalChatAttachmentReadResultSchema",
            &json!({"status":"available","chunk":chunk,"sizeBytes":size}),
        )
    }

    fn read_staged(&self, command: &Value) -> Result<(Zeroizing<Vec<u8>>, bool, u64)> {
        let directory = self
            .thread_directory(command)?
            .join(safe_hash(&command["attachmentId"])?);
        let mut metadata = String::new();
        open(&directory.join("metadata.json"))?
            .take(64 * 1024)
            .read_to_string(&mut metadata)?;
        let stored = parse_json_text(&metadata).map_err(crate::error::WireError)?;
        let descriptor = &stored["descriptor"];
        ensure!(
            descriptor["status"] == "available"
                && descriptor["sha256"].is_string()
                && descriptor["id"] == command["attachmentId"],
            "The staged attachment is unavailable."
        );
        let size = descriptor["sizeBytes"]
            .as_u64()
            .filter(|&value| value <= MAX_BYTES as u64)
            .context("Invalid staged attachment size.")?;
        let mut file = open(&directory.join("content"))?;
        let stat = file.metadata()?;
        ensure!(
            stat.is_file() && stat.len() == size,
            "The staged attachment size changed."
        );
        let offset = command["offset"]
            .as_u64()
            .context("Invalid staged attachment offset.")?;
        let limit = command["limit"]
            .as_u64()
            .filter(|&value| value <= MAX_CHUNK_BYTES as u64)
            .context("Invalid staged attachment read limit.")?;
        let length = limit.min(size.saturating_sub(offset));
        let mut bytes = Zeroizing::new(vec![0; length as usize]);
        if length != 0 {
            file.seek(SeekFrom::Start(offset))?;
            file.read_exact(&mut bytes)?;
        }
        Ok((bytes, offset.saturating_add(length) >= size, size))
    }

    pub(super) fn release(&self, input: &Value) -> Result<()> {
        match fs::remove_dir_all(self.thread_directory(input)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn thread_directory(&self, input: &Value) -> Result<PathBuf> {
        let source = safe_hash(&input["sourceId"])?;
        let thread = input["sourceThreadId"]
            .as_js_string()
            .context("Missing external source thread identity.")?;
        Ok(self
            .0
            .join(source)
            .join(attachment_digest(thread.lossy().as_bytes())))
    }

    fn cleanup_expired(&self) {
        for source in directories(&self.0) {
            for thread in directories(&source) {
                let old = fs::metadata(&thread)
                    .and_then(|entry| entry.modified())
                    .ok()
                    .and_then(|time| SystemTime::now().duration_since(time).ok())
                    .is_some_and(|age| age > TTL);
                if old {
                    let _ = fs::remove_dir_all(thread);
                }
            }
        }
    }
}

fn directories(root: &Path) -> Vec<PathBuf> {
    fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_dir())
                && entry.file_name().to_str().is_some_and(valid_hash)
        })
        .map(|entry| entry.path())
        .collect()
}

impl Candidate {
    fn unavailable(&self, name: JsString, status: &str, warning: &str) -> Value {
        self.descriptor(
            name,
            status,
            if self.kind == "image" {
                "application/x-image"
            } else {
                "application/x-audio"
            },
            0,
            None,
            Some(warning),
        )
    }

    fn descriptor(
        &self,
        name: JsString,
        status: &str,
        mime: &str,
        size: usize,
        digest: Option<String>,
        warning: Option<&str>,
    ) -> Value {
        json!({"id":self.id,"itemId":self.item,"fileName":name,"mimeType":mime,"sizeBytes":size,
            "kind":self.kind,"status":status,"sha256":digest,"warning":warning})
    }

    fn name(&self, path: Option<&Path>) -> JsString {
        let raw = path
            .and_then(Path::file_name)
            .map(Path::new)
            .map(paths::text);
        let name = raw.map(|name| {
            JsString::new(name.units().iter().copied().filter(|&c| c > 31).collect()).trim()
        });
        name.filter(|name| !name.is_empty()).map_or_else(
            || format!("imported-{}", self.kind).into(),
            |name| slice(&name, 0, 200),
        )
    }

    fn stage(&self, directory: &Path, roots: &[PathBuf], remaining: u64) -> Value {
        if let Some(url) = self.url.as_ref().filter(|url| !url.is_empty()) {
            let url = url::Url::parse(&url.lossy()).ok();
            return self.unavailable(
                self.name(url.as_ref().map(|url| Path::new(url.path()))),
                "unsupported",
                "Remote media references are not downloaded during import.",
            );
        }
        let Some(path) = &self.path else {
            return self.unavailable(
                self.name(None),
                "missing",
                "The original attachment path is unavailable.",
            );
        };
        let name = self.name(Some(path));
        let unavailable = |status, message| self.unavailable(name.clone(), status, message);
        let Ok(path) = paths::canonical_sync(path) else {
            return unavailable("missing", "The original attachment file no longer exists.");
        };
        if !roots.iter().any(|root| paths::within(root, &path)) {
            return unavailable(
                "unsafe",
                "The attachment is outside the project and temporary-file boundaries allowed for import.",
            );
        }
        let Ok(metadata) = fs::metadata(&path) else {
            return unavailable("missing", "The original attachment file no longer exists.");
        };
        if !metadata.is_file() {
            return unavailable("unsafe", "The attachment is not a regular file.");
        }
        if !owned(&metadata) {
            return unavailable("unsafe", "The attachment is not owned by the worker user.");
        }
        if metadata.len() > MAX_BYTES as u64 {
            return unavailable(
                "unsafe",
                "The attachment exceeds Cantrip's 25 MB file limit.",
            );
        }
        if metadata.len() > remaining {
            return unavailable(
                "unsafe",
                "The chat's attachments exceed Cantrip's 100 MB import limit.",
            );
        }
        let loaded = (|| -> Result<_> {
            let mut file = open(&path)?;
            let current = file.metadata()?;
            if !current.is_file() || current.len() != metadata.len() || !owned(&current) {
                return Ok(None);
            }
            let mut bytes = Zeroizing::new(Vec::with_capacity(metadata.len() as usize));
            (&mut file)
                .take(metadata.len() + 1)
                .read_to_end(&mut bytes)?;
            Ok((bytes.len() as u64 == metadata.len()).then_some(bytes))
        })();
        let bytes = match loaded {
            Ok(Some(bytes)) => bytes,
            Ok(None) => {
                return unavailable(
                    "unsafe",
                    "The attachment changed while it was being validated.",
                );
            }
            Err(_) => {
                return unavailable(
                    "missing",
                    "The attachment could not be read from its original location.",
                );
            }
        };
        let Some((kind, mime)) =
            media(&bytes[..bytes.len().min(16)]).filter(|(kind, _)| *kind == self.kind)
        else {
            return unavailable(
                "unsupported",
                if self.kind == "image" {
                    "The attachment content is not a supported image format."
                } else {
                    "The attachment content is not a supported audio format."
                },
            );
        };
        debug_assert_eq!(kind, self.kind);
        let descriptor = self.descriptor(
            name.clone(),
            "available",
            mime,
            bytes.len(),
            Some(attachment_digest(&bytes)),
            None,
        );
        let directory = directory.join(&self.id);
        let saved = (|| -> Result<()> {
            cantrip_host::files::private_directory(&directory)?;
            save(&directory, "content", &bytes)?;
            let staged = json!({"descriptor":descriptor,
                "stagedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)});
            save(
                &directory,
                "metadata.json",
                format!("{}\n", staged.stringify()).as_bytes(),
            )
        })();
        if saved.is_err() {
            let _ = fs::remove_dir_all(directory);
            return unavailable(
                "missing",
                "The attachment could not be read from its original location.",
            );
        }
        descriptor
    }
}

fn candidates(input: &Value, thread: &Value, cwd: &Path) -> Result<Vec<Candidate>> {
    let mut found = Vec::new();
    for turn in thread["turns"].as_array().into_iter().flatten() {
        for item in turn["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|item| item["type"] == "userMessage")
        {
            let Some(id) = item["id"].as_js_string() else {
                continue;
            };
            for (index, part) in item["content"].as_array().into_iter().flatten().enumerate() {
                if found.len() >= 20 {
                    return Ok(found);
                }
                let (kind, local) = match part["type"].as_str() {
                    Some("localImage") => ("image", true),
                    Some("image") => ("image", false),
                    Some("localAudio") => ("audio", true),
                    Some("audio") => ("audio", false),
                    _ => continue,
                };
                let source = safe_hash(&input["sourceId"])?;
                let thread = input["sourceThreadId"]
                    .as_js_string()
                    .context("Missing external source thread identity.")?;
                let key = concat(&[
                    source.into(),
                    "\0".into(),
                    thread.clone(),
                    "\0".into(),
                    id.clone(),
                    format!("\0{index}").into(),
                ]);
                let path = if local {
                    part["path"]
                        .as_js_string()
                        .filter(|value| !value.is_empty())
                        .map(|value| cantrip_config::resolve(cwd, &paths::native(value)))
                } else {
                    None
                };
                found.push(Candidate {
                    id: attachment_digest(key.lossy().as_bytes()),
                    item: slice(id, 0, 500),
                    kind,
                    path,
                    url: (!local)
                        .then(|| part["url"].as_js_string().cloned())
                        .flatten(),
                });
            }
        }
    }
    Ok(found)
}

fn imported_id(chat: &Value, source: &Value) -> Result<String> {
    let chat = chat.as_str().context("Missing imported chat identity.")?;
    let source = safe_hash(source)?;
    let digest = Sha256::digest(format!("{chat}\0{source}").as_bytes());
    let mut bytes: [u8; 16] = digest[..16].try_into().unwrap();
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(uuid::Uuid::from_bytes(bytes).to_string())
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn safe_hash(value: &Value) -> Result<&str> {
    value
        .as_str()
        .filter(|value| valid_hash(value))
        .context("Invalid external history hash.")
}

fn open(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    options.open(path)
}

fn owned(metadata: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: getuid reads the calling process's real-user identifier.
        metadata.uid() == unsafe { libc::getuid() }
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        true
    }
}

fn save(directory: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    let mut pending = tempfile::NamedTempFile::new_in(directory)?;
    pending.write_all(bytes)?;
    pending.as_file().sync_all()?;
    pending
        .persist(directory.join(name))
        .map_err(|error| error.error)?;
    Ok(())
}

fn media(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    let ascii: Vec<_> = bytes.iter().map(|byte| byte & 0x7f).collect();
    Some(if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        ("image", "image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        ("image", "image/jpeg")
    } else if ascii.starts_with(b"GIF87a") || ascii.starts_with(b"GIF89a") {
        ("image", "image/gif")
    } else if ascii.starts_with(b"RIFF") && ascii.get(8..12) == Some(b"WEBP") {
        ("image", "image/webp")
    } else if ascii.starts_with(b"RIFF") && ascii.get(8..12) == Some(b"WAVE") {
        ("audio", "audio/wav")
    } else if ascii.starts_with(b"OggS") {
        ("audio", "audio/ogg")
    } else if ascii.starts_with(b"ID3")
        || (bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] & 0xe0 == 0xe0)
    {
        ("audio", "audio/mpeg")
    } else if bytes.len() >= 12 && ascii.get(4..8) == Some(b"ftyp") {
        ("audio", "audio/mp4")
    } else {
        return None;
    })
}
