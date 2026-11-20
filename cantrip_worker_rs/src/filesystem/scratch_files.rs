//! Protected standalone Chat file operations in the registered worker scratch root.
mod download;

use super::{Scope, explorer, paths};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_wire::{JsString, Value, value::json};
use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, Metadata, OpenOptions},
};
use chrono::{DateTime, Utc};
use regex::Regex;
use sha2::{Digest, Sha256};
use std::{
    ffi::{OsStr, OsString},
    fs::File,
    io::{ErrorKind, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
};
use uuid::Uuid;

const DEPTH_LIMIT: usize = 32;
const TEXT_LIMIT: u64 = 2 * 1024 * 1024;
const MEDIA_LIMIT: u64 = 32 * 1024 * 1024;
const DIRECTORY_LIMIT: usize = 1_000;

pub(crate) struct Files {
    downloads: download::Downloads,
    mutations: Mutex<()>,
}

impl Files {
    pub(crate) fn new(profile: &Path) -> Self {
        Self {
            downloads: download::Downloads::new(profile),
            mutations: Mutex::new(()),
        }
    }

    pub(crate) async fn execute(
        self: &Arc<Self>,
        root: PathBuf,
        intent: Value,
        request: Value,
        scope: Scope,
    ) -> Result<(Value, bool)> {
        let files = self.clone();
        tokio::task::spawn_blocking(move || {
            scope.check()?;
            files.run(&root, &intent, &request, &scope)
        })
        .await?
    }

    fn run(
        &self,
        root: &Path,
        intent: &Value,
        request: &Value,
        scope: &Scope,
    ) -> Result<(Value, bool)> {
        let kind = request["type"]
            .as_str()
            .context("Missing Chat file operation.")?;
        let intent = intent.as_str().unwrap_or_default();
        let expected = match kind {
            "chat-files.directory.list" => "list",
            "chat-files.file.read" | "chat-files.path.resolve" | "chat-files.media.read" => "read",
            "chat-files.file.write" => "write",
            "chat-files.entry.delete" => "remove",
            "chat-files.download.prepare" if request["kind"] == "file" => "download",
            "chat-files.download.prepare" => "archive",
            "chat-files.download.read" | "chat-files.download.cancel" if intent == "archive" => {
                "archive"
            }
            "chat-files.download.read" | "chat-files.download.cancel" => "download",
            _ => bail!("Unsupported Chat file operation."),
        };
        ensure!(
            intent == expected,
            "Standalone Chat file operation does not match its declared capability."
        );
        let parent = root.parent().context("Missing Chat scratch parent.")?;
        let profile = parent.parent().context("Missing Chat scratch profile.")?;
        let root_dir = Dir::open_ambient_dir(profile, ambient_authority())?
            .open_dir_nofollow(
                parent
                    .file_name()
                    .context("Missing Chat scratch container.")?,
            )?
            .open_dir_nofollow(
                root.file_name()
                    .context("Missing Chat scratch directory.")?,
            )
            .context("The Chat scratch root is not a safe directory.")?;
        let path = || {
            request["path"]
                .as_js_string()
                .context("A Chat file path is required.")
        };
        let (response_type, value, complete) = match kind {
            "chat-files.directory.list" => (kind, list(root_dir, path()?)?, true),
            "chat-files.file.read" => ("chat-files.file", text(root_dir, path()?)?, true),
            "chat-files.path.resolve" => {
                let reference = request["reference"]
                    .as_js_string()
                    .context("Missing Chat file reference.")?;
                let path = resolve_reference(root, root_dir, reference)?;
                return Ok((json!({"type":"chat-files.path.resolved","path":path}), true));
            }
            "chat-files.media.read" => {
                let value = media(root_dir, path()?, request)?;
                let complete = value["eof"] == true;
                ("chat-files.media", value, complete)
            }
            "chat-files.file.write" => {
                let _guard = self.mutations.lock().unwrap();
                let content = request["content"]
                    .as_js_string()
                    .context("Missing Chat file content.")?;
                let value = write(root_dir, path()?, content, &request["version"], scope)?;
                ("chat-files.file", value, true)
            }
            "chat-files.entry.delete" => {
                let _guard = self.mutations.lock().unwrap();
                scope.check()?;
                remove(root_dir, path()?, request["recursive"] == true)?;
                (
                    "chat-files.entry.mutated",
                    json!({"path":path()?,"newPath":Value::Null}),
                    true,
                )
            }
            "chat-files.download.prepare" => (
                "chat-files.download.prepared",
                self.downloads
                    .prepare(root, root_dir, path()?, &request["kind"], scope)?,
                false,
            ),
            "chat-files.download.read" => {
                let value = self.downloads.read(root, request)?;
                let complete = value["eof"] == true;
                ("chat-files.download.chunk", value, complete)
            }
            "chat-files.download.cancel" => {
                self.downloads.cancel(root, &request["downloadId"])?;
                return Ok((
                    json!({"type":"chat-files.download.cancelled","downloadId":request["downloadId"]}),
                    true,
                ));
            }
            _ => unreachable!("Validated Chat file operation"),
        };
        Ok((json!({"type":response_type,"value":value}), complete))
    }
}

fn segments(path: &JsString) -> Result<Vec<&[u16]>> {
    let units = path.units();
    ensure!(
        !units.contains(&0)
            && !units.contains(&92)
            && units.first() != Some(&47)
            && !(units.get(1) == Some(&58) && matches!(units[0], 65..=90 | 97..=122)),
        "Chat file paths must be relative to the scratch folder."
    );
    let parts: Vec<_> = units
        .split(|&unit| unit == 47)
        .filter(|part| !part.is_empty())
        .collect();
    ensure!(
        !parts.iter().any(|part| *part == [46] || *part == [46, 46]),
        "Chat file path traversal is not allowed."
    );
    ensure!(
        parts.len() <= DEPTH_LIMIT,
        "Chat file paths are too deeply nested."
    );
    Ok(parts)
}

struct Entry {
    parent: Dir,
    name: OsString,
    metadata: Metadata,
}

impl Entry {
    fn resolve(mut dir: Dir, path: &JsString, allow_root: bool) -> Result<Self> {
        let parts = segments(path)?;
        let mut names = parts
            .into_iter()
            .map(|part| {
                let name = paths::native(&JsString::new(part.to_vec()));
                ensure!(
                    matches!(
                        name.components().collect::<Vec<_>>().as_slice(),
                        [Component::Normal(_)]
                    ) && !(cfg!(windows) && part.contains(&58)),
                    "Chat file path escaped the scratch folder."
                );
                Ok(name.into_os_string())
            })
            .collect::<Result<Vec<_>>>()?;
        let name = match names.pop() {
            Some(name) => name,
            None if allow_root => OsString::from("."),
            None => bail!("A Chat file path is required."),
        };
        for ancestor in names {
            metadata(&dir, &ancestor)?;
            dir = dir.open_dir_nofollow(&ancestor)?;
        }
        let metadata = metadata(&dir, &name)?;
        Ok(Self {
            parent: dir,
            name,
            metadata,
        })
    }

    fn directory(&self) -> Result<Dir> {
        if self.name == "." {
            Ok(self.parent.try_clone()?)
        } else {
            Ok(self.parent.open_dir_nofollow(&self.name)?)
        }
    }
}

fn metadata(parent: &Dir, name: &OsStr) -> Result<Metadata> {
    let metadata = parent
        .symlink_metadata(name)
        .map_err(|e| explorer::io_error("lstat", Path::new(name), e))?;
    ensure!(
        !metadata.file_type().is_symlink(),
        "Chat file operations do not follow symbolic links."
    );
    Ok(metadata)
}

fn open_file(parent: &Dir, name: &OsStr, message: &str) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = parent.open_with(name, &options)?.into_std();
    ensure!(file.metadata()?.is_file(), "{message}");
    Ok(file)
}

fn names(dir: &Dir) -> Result<Vec<(OsString, cap_std::fs::FileType)>> {
    let mut names = dir
        .entries()?
        .map(|entry| {
            let entry = entry?;
            Ok((entry.file_name(), entry.file_type()?))
        })
        .collect::<std::io::Result<Vec<_>>>()?;
    // Preserve libuv's name ordering for ties in locale comparisons.
    names.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(names)
}

fn modified(time: std::time::SystemTime) -> Result<String> {
    let time = DateTime::<Utc>::from(time);
    explorer::date_iso(
        time.timestamp() as f64 * 1_000. + f64::from(time.timestamp_subsec_nanos()) / 1_000_000.,
    )
}

fn markdown(path: &JsString) -> bool {
    let path = paths::native(path);
    path.extension().and_then(OsStr::to_str).is_some_and(|ext| {
        ["md", "mdx", "markdown"]
            .iter()
            .any(|kind| ext.eq_ignore_ascii_case(kind))
    })
}

fn list(root: Dir, path: &JsString) -> Result<Value> {
    let entry = Entry::resolve(root, path, true)?;
    ensure!(
        entry.metadata.is_dir(),
        "Chat file path is not a directory."
    );
    let directory = entry.directory()?;
    let mut entries = names(&directory)?;
    let sort = explorer::Sorting::new()?;
    let rank = |kind: cap_std::fs::FileType| {
        if kind.is_dir() {
            0
        } else if kind.is_file() {
            1
        } else {
            2
        }
    };
    entries.sort_by(|(left, left_kind), (right, right_kind)| {
        rank(*left_kind).cmp(&rank(*right_kind)).then_with(|| {
            sort.base(
                &paths::text(Path::new(left)),
                &paths::text(Path::new(right)),
            )
        })
    });
    let truncated = entries.len() > DIRECTORY_LIMIT;
    let summaries = entries
        .into_iter()
        .take(DIRECTORY_LIMIT)
        .map(|(name, _)| {
            let metadata = directory.symlink_metadata(&name)?;
            let file = metadata.is_file();
            let kind = if metadata.is_dir() {
                "directory"
            } else if file {
                "file"
            } else {
                "other"
            };
            let name = paths::text(Path::new(&name));
            Ok(json!({
                "kind":kind, "markdown":file && markdown(&name),
                "modifiedAt":modified(metadata.modified()?.into_std())?,
                "name":name, "path":explorer::joined(path, &name),
                "size":if file {json!(metadata.len())} else {Value::Null},
                "symbolicLink":metadata.file_type().is_symlink(), "viewable":file,
            }))
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(json!({"path":path,"entries":summaries,"truncated":truncated}))
}

fn document(path: &JsString, content: &JsString, bytes: &[u8]) -> Value {
    json!({"path":path,"content":content,"size":bytes.len(),"markdown":markdown(path),"version":explorer::version(bytes)})
}

fn text(root: Dir, path: &JsString) -> Result<Value> {
    let entry = Entry::resolve(root, path, false)?;
    ensure!(entry.metadata.is_file(), "Chat file path is not a file.");
    ensure!(
        entry.metadata.len() <= TEXT_LIMIT,
        "Chat file is too large to preview as text."
    );
    let file = open_file(&entry.parent, &entry.name, "Chat file path is not a file.")?;
    let mut bytes = Vec::new();
    file.take(TEXT_LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= TEXT_LIMIT,
        "Chat file is too large to preview as text."
    );
    Ok(document(path, &explorer::decode(&bytes)?.into(), &bytes))
}

fn media(root: Dir, path: &JsString, request: &Value) -> Result<Value> {
    let name = path.lossy();
    let (kind, mime) = explorer::media_type_for_name(name.rsplit('/').next().unwrap_or_default())
        .context("Chat file is not supported media.")?;
    let entry = Entry::resolve(root, path, false)?;
    ensure!(entry.metadata.is_file(), "Chat media path is not a file.");
    let mut file = open_file(&entry.parent, &entry.name, "Chat media path is not a file.")?;
    let metadata = file.metadata()?;
    let size = metadata.len();
    ensure!(
        size <= MEDIA_LIMIT,
        "Chat media file is too large to preview."
    );
    let offset = request["offset"]
        .as_u64()
        .context("Invalid Chat media offset.")?;
    let limit = request["limit"]
        .as_u64()
        .context("Invalid Chat media limit.")?;
    ensure!(offset <= size, "Chat media offset is outside the file.");
    let bytes = read_chunk(&mut file, offset, limit.min(size - offset))?;
    Ok(json!({
        "path":path,"kind":kind,"mimeType":mime,"size":size,"modifiedAt":modified(metadata.modified()?)?,
        "offset":offset,"data":STANDARD.encode(&bytes),"eof":offset + bytes.len() as u64 == size,
    }))
}

fn read_chunk(file: &mut File, offset: u64, length: u64) -> Result<Vec<u8>> {
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::with_capacity(usize::try_from(length)?);
    file.take(length).read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn resolve_reference(root: &Path, dir: Dir, reference: &JsString) -> Result<JsString> {
    static LINE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"#[Ll][0-9]+(?:[Cc][0-9]+)?$").unwrap());
    static COLON: LazyLock<Regex> = LazyLock::new(|| Regex::new(r":[0-9]+(?::[0-9]+)?$").unwrap());
    let line = remove_suffix(reference, &LINE);
    let mut reference = remove_suffix(&line, &COLON);
    if reference
        .units()
        .get(..5)
        .is_some_and(|prefix| JsString::new(prefix.to_vec()).lowercase() == "file:".into())
    {
        let url = url::Url::parse(&reference.lossy())?;
        let raw = url.path().as_bytes();
        ensure!(
            raw.iter().enumerate().all(|(i, byte)| *byte != b'%'
                || raw
                    .get(i + 1..i + 3)
                    .is_some_and(|bytes| bytes.iter().all(u8::is_ascii_hexdigit))),
            "Malformed Chat file URL."
        );
        let decoded = percent_encoding::percent_decode(raw).decode_utf8()?;
        let decoded = if cfg!(windows) && decoded.as_bytes().get(2..4) == Some(b":/") {
            decoded.strip_prefix('/').unwrap_or(&decoded)
        } else {
            &decoded
        };
        reference = decoded.into();
    }
    let native = paths::native(&reference);
    let relative = if paths::absolute(&native) {
        let native = paths::resolve(&native)?;
        ensure!(
            paths::within(root, &native),
            "Chat file reference is outside the scratch folder."
        );
        ensure!(
            !paths::equal(root, &native),
            "A Chat file path is required."
        );
        paths::relative(root, &native)
    } else {
        let normalized: Vec<_> = reference
            .units()
            .iter()
            .map(|&u| if u == 92 { 47 } else { u })
            .collect();
        let prefix = explorer::joined(
            &"chat-scratch".into(),
            &paths::text(Path::new(root.file_name().unwrap_or_default())),
        );
        let prefix = [prefix.units(), &[47]].concat();
        JsString::new(
            normalized
                .strip_prefix(prefix.as_slice())
                .unwrap_or(&normalized)
                .to_vec(),
        )
    };
    let path = JsString::new(segments(&relative)?.join(&47));
    Entry::resolve(dir, &path, false)?;
    Ok(path)
}

fn remove_suffix(value: &JsString, suffix: &Regex) -> JsString {
    let text = value.lossy();
    let length = suffix.find(&text).map_or(0, |matched| matched.len());
    JsString::new(value.units()[..value.units().len() - length].to_vec())
}

fn write(
    root: Dir,
    path: &JsString,
    content: &JsString,
    version: &Value,
    scope: &Scope,
) -> Result<Value> {
    let entry = Entry::resolve(root, path, false)?;
    ensure!(entry.metadata.is_file(), "Chat file path is not a file.");
    let (has_nul, invalid_utf8) = verify_version(&entry, version, scope)?;
    ensure!(!has_nul, "Binary files cannot be previewed.");
    ensure!(!invalid_utf8, "Only UTF-8 text files can be previewed.");
    let bytes = content.lossy();
    ensure!(
        bytes.len() as u64 <= TEXT_LIMIT,
        "Chat file content exceeds the write limit."
    );
    explorer::decode(bytes.as_bytes())?;
    let name = format!(".cantrip-chat-{}.tmp", Uuid::new_v4());
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut temporary = entry.parent.open_with(&name, &options)?;
    let result = (|| {
        temporary.write_all(bytes.as_bytes())?;
        temporary.sync_all()?;
        drop(temporary);
        verify_version(&entry, version, scope)?;
        scope.check()?;
        entry.parent.rename(&name, &entry.parent, &entry.name)?;
        Ok(document(path, content, bytes.as_bytes()))
    })();
    if result.is_err() {
        let _ = entry.parent.remove_file(&name);
    }
    result
}

/// Hash the original without loading a whole file when it grew outside the editor.
fn verify_version(entry: &Entry, expected: &Value, scope: &Scope) -> Result<(bool, bool)> {
    let mut file = open_file(&entry.parent, &entry.name, "Chat file path is not a file.")?;
    let size = file.metadata()?.len();
    let mut input = (&mut file).take(size);
    let mut hash = Sha256::new();
    let mut bytes = [0u8; 32 * 1024 + 3];
    let mut prefix = 0;
    let mut has_nul = false;
    let mut invalid_utf8 = false;
    loop {
        scope.check()?;
        let count = input.read(&mut bytes[prefix..])?;
        if count == 0 {
            break;
        }
        hash.update(&bytes[prefix..prefix + count]);
        has_nul |= bytes[prefix..prefix + count].contains(&0);
        let len = prefix + count;
        prefix = 0;
        if !invalid_utf8 && let Err(error) = std::str::from_utf8(&bytes[..len]) {
            if error.error_len().is_some() {
                invalid_utf8 = true;
            } else {
                prefix = len - error.valid_up_to();
                bytes.copy_within(len - prefix..len, 0);
            }
        }
    }
    ensure!(
        input.limit() == 0
            && file.metadata()?.len() == size
            && expected
                .as_str()
                .is_some_and(|version| version == explorer::hex_digest(&hash.finalize())),
        "Chat file changed since it was opened. Reload it first."
    );
    Ok((has_nul, invalid_utf8 || prefix != 0))
}

fn remove(root: Dir, path: &JsString, recursive: bool) -> Result<()> {
    let entry = Entry::resolve(root, path, false)?;
    if entry.metadata.is_dir() {
        if recursive {
            entry.parent.remove_dir_all(entry.name)?;
        } else if let Err(error) = entry.parent.remove_dir(entry.name) {
            if error.kind() == ErrorKind::DirectoryNotEmpty {
                bail!("Recursive confirmation is required for this folder.");
            }
            return Err(error.into());
        }
    } else {
        entry.parent.remove_file(entry.name)?;
    }
    Ok(())
}
