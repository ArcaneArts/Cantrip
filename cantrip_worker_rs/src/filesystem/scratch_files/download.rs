//! Bounded snapshots for chunked Chat file download operations.
use super::{DEPTH_LIMIT, Entry, Scope, explorer, names, open_file, paths, read_chunk};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_wire::{JsString, Value, value::json};
use cap_fs_ext::DirExt;
use cap_std::fs::Dir;
use chrono::{DateTime, Datelike, Local, Timelike};
use std::{
    collections::HashMap,
    fs::File,
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

const FILE_LIMIT: u64 = 128 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 128 * 1024 * 1024;
const OUTPUT_LIMIT: u64 = 160 * 1024 * 1024;
const ENTRY_LIMIT: usize = 2_000;
const DOWNLOAD_LIMIT: usize = 4;
const TTL: Duration = Duration::from_secs(5 * 60);

pub(super) struct Downloads {
    profile: PathBuf,
    staged: Mutex<HashMap<String, Download>>,
    slots: Arc<Semaphore>,
}

struct Download {
    _slot: OwnedSemaphorePermit,
    created: Instant,
    file: File,
    root: PathBuf,
    size: u64,
    offset: u64,
}

impl Downloads {
    pub(super) fn new(profile: &Path) -> Self {
        Self {
            profile: profile.to_owned(),
            staged: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(DOWNLOAD_LIMIT)),
        }
    }

    pub(super) fn prepare(
        &self,
        root: &Path,
        directory: Dir,
        path: &JsString,
        kind: &Value,
        scope: &Scope,
    ) -> Result<Value> {
        expire(&mut self.staged.lock().unwrap());
        let slot = self
            .slots
            .clone()
            .try_acquire_owned()
            .context("Too many Chat file downloads are already being prepared.")?;
        let entry = Entry::resolve(directory, path, kind == "all")?;
        // The snapshot has no retained directory entry and is dropped at EOF,
        // cancellation, expiry, shutdown, or any error during preparation.
        let mut file = tempfile::tempfile_in(&self.profile)?;
        let raw_name = path.lossy();
        let simple_name = raw_name
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or_default();
        let mut file_name = safe_name(simple_name);
        let mime = if kind == "file" {
            ensure!(
                entry.metadata.is_file(),
                "Chat download path is not a file."
            );
            ensure!(
                entry.metadata.len() <= FILE_LIMIT,
                "Chat file exceeds the download limit."
            );
            copy_file(&mut file, &entry.parent, &entry.name, entry.metadata.len())?;
            let media_name = raw_name.rsplit('/').next().unwrap_or_default();
            explorer::media_type_for_name(media_name)
                .map_or_else(|| text_mime(simple_name), |(_, mime)| mime)
        } else {
            ensure!(
                entry.metadata.is_dir(),
                "Chat archive path is not a folder."
            );
            let directory = entry.directory()?;
            let prefix = if kind == "folder" {
                paths::text(Path::new(&entry.name)).lossy().into_owned()
            } else {
                String::new()
            };
            let prefix = if prefix.is_empty() {
                prefix
            } else {
                format!("{prefix}/")
            };
            let mut archive = Archive {
                writer: ZipWriter::new(&mut file),
                sorting: explorer::Sorting::new()?,
                files: 0,
                bytes: 0,
                scope,
            };
            archive.visit(&directory, &prefix, 0)?;
            archive.writer.finish()?;
            if kind == "all" {
                file_name = "chat-files".into();
            }
            file_name = JsString::new([file_name.units(), &[46, 122, 105, 112]].concat());
            "application/zip"
        };
        let size = file.metadata()?.len();
        ensure!(size <= OUTPUT_LIMIT, "The Chat files archive is too large.");
        let id = Uuid::new_v4().to_string();
        self.staged.lock().unwrap().insert(
            id.clone(),
            Download {
                _slot: slot,
                created: Instant::now(),
                file,
                root: root.into(),
                size,
                offset: 0,
            },
        );
        Ok(json!({"downloadId":id,"fileName":file_name,"mimeType":mime,"size":size}))
    }

    pub(super) fn read(&self, root: &Path, request: &Value) -> Result<Value> {
        let id = request["downloadId"]
            .as_str()
            .context("Missing Chat file download ID.")?;
        let offset = request["offset"]
            .as_u64()
            .context("Invalid Chat download offset.")?;
        let limit = request["limit"]
            .as_u64()
            .context("Invalid Chat download limit.")?;
        let mut staged = self.staged.lock().unwrap();
        expire(&mut staged);
        let download = staged
            .get_mut(id)
            .context("Chat file download is no longer available.")?;
        download.check_root(root)?;
        ensure!(
            offset == download.offset,
            "Chat file download offset is stale."
        );
        let length = limit.min(download.size - offset);
        let bytes = read_chunk(&mut download.file, offset, length)?;
        ensure!(
            bytes.len() as u64 == length,
            "The prepared Chat download changed."
        );
        download.offset += length;
        let eof = download.offset == download.size;
        if eof {
            staged.remove(id);
        }
        Ok(json!({"downloadId":id,"offset":offset,"data":STANDARD.encode(&bytes),"eof":eof}))
    }

    pub(super) fn cancel(&self, root: &Path, id: &Value) -> Result<()> {
        let id = id.as_str().context("Missing Chat file download ID.")?;
        let mut staged = self.staged.lock().unwrap();
        if let Some(download) = staged.get(id) {
            download.check_root(root)?;
            staged.remove(id);
        }
        Ok(())
    }
}

impl Download {
    fn check_root(&self, root: &Path) -> Result<()> {
        ensure!(
            self.root == root,
            "Chat file download belongs to another scratch folder."
        );
        Ok(())
    }
}

fn expire(staged: &mut HashMap<String, Download>) {
    staged.retain(|_, download| download.created.elapsed() < TTL);
}

struct Archive<'a> {
    writer: ZipWriter<&'a mut File>,
    sorting: explorer::Sorting,
    files: usize,
    bytes: u64,
    scope: &'a Scope,
}

impl Archive<'_> {
    fn visit(&mut self, directory: &Dir, prefix: &str, depth: usize) -> Result<()> {
        self.scope.check()?;
        ensure!(
            depth <= DEPTH_LIMIT,
            "Chat archive contains paths that are too deeply nested."
        );
        let mut children = names(directory)?;
        children.sort_by(|left, right| {
            self.sorting.compare(
                &paths::text(Path::new(&left.0)),
                &paths::text(Path::new(&right.0)),
            )
        });
        for (name, _) in children {
            self.scope.check()?;
            let label = paths::text(Path::new(&name));
            let label = label.lossy();
            ensure!(
                !label.contains('\\'),
                "Chat archive contains an unsafe file name."
            );
            let metadata = directory.symlink_metadata(&name)?;
            ensure!(
                !metadata.file_type().is_symlink(),
                "Chat archives cannot contain symbolic links."
            );
            let path = format!("{prefix}{label}");
            if metadata.is_dir() {
                self.visit(
                    &directory.open_dir_nofollow(&name)?,
                    &format!("{path}/"),
                    depth + 1,
                )?;
                continue;
            }
            ensure!(
                metadata.is_file(),
                "Chat archives can contain only files and folders."
            );
            let size = metadata.len();
            ensure!(size <= FILE_LIMIT, "A Chat file exceeds the archive limit.");
            self.bytes += size;
            self.files += 1;
            ensure!(
                self.bytes <= TOTAL_LIMIT,
                "Chat files exceed the archive size limit."
            );
            ensure!(
                self.files <= ENTRY_LIMIT,
                "Chat files exceed the archive entry limit."
            );
            let modified = DateTime::<Local>::from(metadata.modified()?.into_std());
            let date = zip::DateTime::from_date_and_time(
                modified.year().clamp(1980, 2107) as u16,
                modified.month() as u8,
                modified.day() as u8,
                modified.hour() as u8,
                modified.minute() as u8,
                modified.second() as u8,
            )
            .unwrap_or_default();
            self.writer.start_file(
                path,
                SimpleFileOptions::default()
                    .compression_method(CompressionMethod::Stored)
                    .last_modified_time(date),
            )?;
            copy_file(&mut self.writer, directory, &name, size)?;
        }
        Ok(())
    }
}

fn copy_file(
    output: &mut impl io::Write,
    directory: &Dir,
    name: &std::ffi::OsStr,
    size: u64,
) -> Result<()> {
    let message = "A Chat file changed while its download was prepared.";
    let source = open_file(directory, name, message)?;
    if source.metadata()?.len() != size || io::copy(&mut source.take(size + 1), output)? != size {
        bail!("{message}");
    }
    Ok(())
}

fn safe_name(name: &str) -> JsString {
    let name: String = name
        .nfkc()
        .map(|c| {
            if matches!(
                c,
                '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\u{0}'..='\u{1f}'
            ) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let name = JsString::from(name.as_str()).trim();
    if name.is_empty() {
        "chat-files".into()
    } else {
        JsString::new(name.units().iter().take(240).copied().collect())
    }
}

fn text_mime(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    let extension = Path::new(&lower)
        .extension()
        .and_then(std::ffi::OsStr::to_str)
        .unwrap_or_default();
    if matches!(
        lower.as_str(),
        ".dockerignore"
            | ".editorconfig"
            | ".gitattributes"
            | ".gitignore"
            | ".npmrc"
            | "dockerfile"
            | "gradlew"
            | "license"
            | "makefile"
            | "readme"
    ) || matches!(
        extension,
        "bat"
            | "c"
            | "cc"
            | "conf"
            | "config"
            | "cpp"
            | "cs"
            | "css"
            | "csv"
            | "dart"
            | "env"
            | "go"
            | "gradle"
            | "graphql"
            | "h"
            | "hpp"
            | "html"
            | "ini"
            | "java"
            | "js"
            | "json"
            | "jsx"
            | "kt"
            | "kts"
            | "less"
            | "log"
            | "lua"
            | "md"
            | "mdx"
            | "mjs"
            | "properties"
            | "py"
            | "rb"
            | "rs"
            | "scss"
            | "sh"
            | "sol"
            | "sql"
            | "swift"
            | "toml"
            | "ts"
            | "tsx"
            | "txt"
            | "vue"
            | "xml"
            | "yaml"
            | "yml"
    ) {
        "text/plain;charset=utf-8"
    } else {
        "application/octet-stream"
    }
}
