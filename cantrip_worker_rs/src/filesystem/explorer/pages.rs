//! Bounded, stateless Explorer reads shared by the worker and the guest helper.
use super::{
    date_iso,
    files::decode,
    io_error, modified_milliseconds, paths,
    stamp::{Stamp, hash},
};
use anyhow::{Context, Result, anyhow, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    fs::{File, Metadata, OpenOptions},
    io::{self, Read, Seek, SeekFrom},
    path::Path,
};

const PAGE: u64 = 256 * 1024;
const PREVIEW_LIMIT: u64 = 10 * 1024 * 1024;
const PREVIEW_LINES: usize = 10_000;
const MAX_SAFE_SIZE: u64 = (1 << 53) - 1;
const PREVIEW_CHANGED: &str =
    "The file changed while previewing. Refresh to load its latest contents.";
const LOG_CHANGED: &str = "The log changed during reading. Try again.";
const MEDIA_CHANGED: &str = "The media file changed while it was being read.";

#[derive(Debug)]
pub(super) struct BinaryFileChanged;
impl std::fmt::Display for BinaryFileChanged {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("The file changed while reading. Reopen it to load its latest version.")
    }
}
impl std::error::Error for BinaryFileChanged {}

pub(super) async fn execute(root: &Path, relative: &JsString, request: &Value) -> Result<Value> {
    let (_, target) = paths::resolve(root, relative).await?;
    let relative = relative.clone();
    let request = request.clone();
    tokio::task::spawn_blocking(move || {
        let kind = request["type"].as_str().context("Explorer read type")?;
        let media = if kind == "explorer.media.read" {
            Some(media_type(&target, &request["mediaType"])?)
        } else {
            None
        };
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let mut file = options
            .open(&target)
            .map_err(|error| io_error("open", &target, error))?;
        let metadata = file.metadata()?;
        let (kind, value) = match kind {
            "explorer.binary.read" => (
                "explorer.binary",
                binary(&mut file, &metadata, &relative, &request)?,
            ),
            "explorer.file.preview" => (kind, preview(&mut file, &metadata, &relative, &request)?),
            "explorer.file.tail" => (
                kind,
                tail(&mut file, &metadata, &relative, &request["cursor"])?,
            ),
            "explorer.media.read" => (
                "explorer.media",
                media_page(&mut file, &metadata, &relative, &request, media.unwrap())?,
            ),
            _ => unreachable!("Explorer page reader dispatch"),
        };
        Ok(json!({"type":kind,"value":value}))
    })
    .await?
}

fn read_range(
    file: &mut File,
    offset: u64,
    length: u64,
    changed: impl FnOnce() -> anyhow::Error,
) -> Result<Vec<u8>> {
    let mut data = vec![0; usize::try_from(length)?];
    if !data.is_empty() {
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(&mut data).map_err(|error| {
            if error.kind() == io::ErrorKind::UnexpectedEof {
                changed()
            } else {
                error.into()
            }
        })?;
    }
    Ok(data)
}

fn binary(file: &mut File, metadata: &Metadata, path: &JsString, request: &Value) -> Result<Value> {
    ensure!(
        metadata.is_file(),
        "Binary reading requires a regular file."
    );
    let before = Stamp::read(file, metadata)?;
    let size = before.size;
    ensure!(
        size <= MAX_SAFE_SIZE,
        "The file exceeds supported byte addressing."
    );
    let offset = request["offset"].as_u64().context("Binary read offset")?;
    let limit = request["limit"].as_u64().context("Binary read limit")?;
    let version = before.binary_version();
    if request["version"]
        .as_str()
        .is_some_and(|expected| expected != version)
    {
        return Err(BinaryFileChanged.into());
    }
    ensure!(offset <= size, "Binary read offset is beyond the file.");
    let bytes = read_range(file, offset, limit.min(size - offset), || {
        BinaryFileChanged.into()
    })?;
    if Stamp::read(file, &file.metadata()?)?.binary_version() != version {
        return Err(BinaryFileChanged.into());
    }
    let next = offset + bytes.len() as u64;
    Ok(
        json!({"path":path,"size":size,"offset":offset,"nextOffset":next,"eof":next==size,
        "version":version,"data":STANDARD.encode(bytes)}),
    )
}

fn preview(
    file: &mut File,
    metadata: &Metadata,
    path: &JsString,
    request: &Value,
) -> Result<Value> {
    let offset = request["offset"]
        .as_u64()
        .context("Invalid text preview offset or revision.")?;
    let expected = request["version"].as_str();
    ensure!(
        offset == 0 || expected.is_some(),
        "Invalid text preview offset or revision."
    );
    ensure!(
        metadata.is_file(),
        "This file type is not available for preview."
    );
    ensure!(
        metadata.len() <= PREVIEW_LIMIT,
        "Text previews are limited to 10 MB."
    );
    let before = Stamp::read(file, metadata)?;
    let size = before.size;
    let version = before.preview_version();
    ensure!(
        expected.is_none_or(|expected| expected == version),
        PREVIEW_CHANGED
    );
    ensure!(offset <= size, "Text preview offset is beyond the file.");
    let bytes = read_range(file, offset, PAGE.min(size - offset), || {
        anyhow!(PREVIEW_CHANGED)
    })?;
    ensure!(
        Stamp::read(file, &file.metadata()?)?.preview_version() == version,
        PREVIEW_CHANGED
    );

    let mut end = preview_line_end(&bytes);
    if offset + (end as u64) < size && end > 0 {
        let lead = last_lead(&bytes, 0, end);
        let width = match bytes[lead] {
            0xf0..=0xff => 4,
            0xe0..=0xef => 3,
            0xc0..=0xdf => 2,
            _ => 1,
        };
        if lead + width > end {
            end = lead;
        }
    }
    let next = offset + end as u64;
    Ok(
        json!({"path":path,"content":decode(&bytes[..end])?,"size":size,"offset":offset,
        "nextOffset":next,"eof":next==size,"version":version}),
    )
}

fn preview_line_end(data: &[u8]) -> usize {
    let mut index = 0;
    let mut lines = 0;
    while let Some(&byte) = data.get(index) {
        index += 1;
        if byte == b'\r' && data.get(index) == Some(&b'\n') {
            index += 1;
        }
        if matches!(byte, b'\r' | b'\n') {
            lines += 1;
            if lines == PREVIEW_LINES {
                break;
            }
        }
    }
    index
}

fn last_lead(bytes: &[u8], first: usize, end: usize) -> usize {
    let mut lead = end - 1;
    while lead > first && bytes[lead] & 0xc0 == 0x80 {
        lead -= 1;
    }
    lead
}

fn log_range(file: &mut File, start: u64, length: u64) -> Result<Vec<u8>> {
    read_range(file, start, length, || anyhow!(LOG_CHANGED))
}

fn anchor(file: &mut File, offset: u64) -> Result<String> {
    let length = offset.min(64);
    Ok(hash(&log_range(file, offset - length, length)?))
}

fn tail(file: &mut File, metadata: &Metadata, path: &JsString, cursor: &Value) -> Result<Value> {
    ensure!(metadata.is_file(), "This log path is not a file.");
    let before = Stamp::read(file, metadata)?;
    let size = before.size;
    ensure!(
        size <= MAX_SAFE_SIZE,
        "The log is too large to address safely."
    );
    let identity = before.log_identity();
    let continuing = match cursor["offset"].as_u64() {
        Some(offset)
            if cursor["identity"] == identity && offset <= size && size - offset <= PAGE =>
        {
            (cursor["anchor"] == anchor(file, offset)?).then_some(offset)
        }
        _ => None,
    };
    let start = continuing.unwrap_or_else(|| size.saturating_sub(PAGE));
    let bytes = log_range(file, start, size - start)?;
    let mut first = 0;
    let mut end = bytes.len();
    if continuing.is_none() && start > 0 {
        while first < end && bytes[first] & 0xc0 == 0x80 {
            first += 1;
        }
        if let Some(newline) = bytes[first..].iter().position(|&byte| byte == b'\n')
            && first + newline + 1 < end
        {
            first += newline + 1;
        }
    }
    if end > first {
        let lead = last_lead(&bytes, first, end);
        let width = match bytes[lead] {
            0xf0..=0xf4 => 4,
            0xe0..=0xef => 3,
            0xc2..=0xdf => 2,
            _ => 1,
        };
        if lead + width > end {
            end = lead;
        }
    }
    let content = decode(&bytes[first..end])?;
    let after = Stamp::read(file, &file.metadata()?)?;
    ensure!(
        after.size >= size && (after.size != size || after.modified_ns == before.modified_ns),
        LOG_CHANGED
    );
    let offset = start + end as u64;
    Ok(
        json!({"path":path,"content":content,"startOffset":start + first as u64,"size":size,
        "reset":continuing.is_none(),"cursor":json!({"offset":offset,"identity":identity,"anchor":anchor(file,offset)?})}),
    )
}

fn media_type<'a>(target: &Path, override_type: &'a Value) -> Result<(&'a str, &'a str)> {
    if let (Some(kind), Some(mime)) = (
        override_type["kind"].as_str(),
        override_type["mimeType"].as_str(),
    ) {
        return Ok((kind, mime));
    }
    let name = target.file_name().unwrap_or_default().to_string_lossy();
    let extension = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    Ok(match extension.as_str() {
        "apng" => ("image", "image/apng"),
        "avif" => ("image", "image/avif"),
        "bmp" => ("image", "image/bmp"),
        "gif" => ("image", "image/gif"),
        "ico" => ("image", "image/x-icon"),
        "jpeg" | "jpg" => ("image", "image/jpeg"),
        "png" => ("image", "image/png"),
        "svg" => ("image", "image/svg+xml"),
        "webp" => ("image", "image/webp"),
        "aac" => ("audio", "audio/aac"),
        "flac" => ("audio", "audio/flac"),
        "m4a" => ("audio", "audio/mp4"),
        "mp3" => ("audio", "audio/mpeg"),
        "oga" | "ogg" | "opus" => ("audio", "audio/ogg"),
        "wav" => ("audio", "audio/wav"),
        "weba" => ("audio", "audio/webm"),
        "m4v" | "mp4" => ("video", "video/mp4"),
        "mov" => ("video", "video/quicktime"),
        "ogv" => ("video", "video/ogg"),
        "webm" => ("video", "video/webm"),
        _ => anyhow::bail!("This file type is not available as media."),
    })
}

fn media_page(
    file: &mut File,
    metadata: &Metadata,
    path: &JsString,
    request: &Value,
    (kind, mime): (&str, &str),
) -> Result<Value> {
    ensure!(
        metadata.is_file(),
        "This file type is not available as media."
    );
    let size = metadata.len();
    let modified = modified_milliseconds(metadata)?;
    let offset = request["offset"]
        .as_u64()
        .context("The media read offset is invalid.")?;
    let limit = request["limit"]
        .as_u64()
        .context("The media read limit is invalid.")?;
    ensure!(offset <= size, "The media read offset is outside the file.");
    let bytes = read_range(file, offset, limit.min(size - offset), || {
        anyhow!(MEDIA_CHANGED)
    })?;
    let after = file.metadata()?;
    ensure!(
        after.len() == size && modified_milliseconds(&after)? == modified,
        MEDIA_CHANGED
    );
    Ok(
        json!({"path":path,"kind":kind,"mimeType":mime,"size":size,"modifiedAt":date_iso(modified)?,
        "offset":offset,"data":STANDARD.encode(&bytes),"eof":offset + bytes.len() as u64 >= size}),
    )
}
