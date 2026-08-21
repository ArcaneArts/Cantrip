use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{App, AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::desktop_worker::DesktopWorkers;

const MAX_BYTES: usize = 5 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
const MAX_RECORD_BYTES: usize = 16 * 1024;
const MAX_CONTEXT_DEPTH: usize = 6;
const MAX_CONTEXT_ENTRIES: usize = 100;
const REDACTED: &str = "[REDACTED]";
const ARCHIVE_MAX_BYTES: u64 = 100 * 1024 * 1024;
const ARCHIVE_PART_BYTES: u64 = 10 * 1024 * 1024;
const COMPRESSION_AGE: Duration = Duration::from_secs(48 * 60 * 60);

fn secret_field_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?i)^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|passphrase|secret|client-secret|api-key|apikey|token|access-token|refresh-token|id-token|bearer-token|provider-token|private-key|credential|csrf|csrf-token|xsrf-token|device-code|oauth-code|pairing-code|enrollment-code|signed-url)$",
        )
        .expect("secret field regex must compile")
    })
}

fn named_secret_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r#"(?i)\b(authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|password|passwd|passphrase|secret|client[_-]?secret|api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|id[_-]?token|provider[_-]?token|private[_-]?key|credential|csrf(?:[_-]?token)?|xsrf[_-]?token|device[_-]?code|oauth[_-]?code|pairing[_-]?code|enrollment[_-]?code|signed[_-]?url)(\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)"#,
        )
        .expect("named secret regex must compile")
    })
}

fn provider_token_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"\b(?:sk|gh[opusr]|xox[baprs]|pat)[-_][A-Za-z0-9_-]{8,}\b")
            .expect("provider token regex must compile")
    })
}

fn url_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r#"https?://[^\s\"'<>]+"#).expect("URL regex must compile"))
}

fn normalize_field_name(value: &str) -> String {
    let mut normalized = String::with_capacity(value.len());
    let mut previous_was_lowercase_or_digit = false;
    for character in value.chars() {
        if character.is_ascii_uppercase() {
            if previous_was_lowercase_or_digit && !normalized.ends_with('-') {
                normalized.push('-');
            }
            normalized.push(character.to_ascii_lowercase());
            previous_was_lowercase_or_digit = false;
        } else if matches!(character, '_' | '.' | ' ') {
            if !normalized.is_empty() && !normalized.ends_with('-') {
                normalized.push('-');
            }
            previous_was_lowercase_or_digit = false;
        } else {
            normalized.push(character.to_ascii_lowercase());
            previous_was_lowercase_or_digit =
                character.is_ascii_lowercase() || character.is_ascii_digit();
        }
    }
    normalized
}

fn is_secret_field(value: &str) -> bool {
    secret_field_pattern().is_match(&normalize_field_name(value))
}

fn is_signed_url_query(value: &str) -> bool {
    matches!(
        value.to_ascii_lowercase().as_str(),
        "signature"
            | "sig"
            | "x-amz-signature"
            | "x-amz-credential"
            | "x-amz-security-token"
            | "x-goog-signature"
            | "x-goog-credential"
    )
}

fn redact_url(candidate: &str) -> String {
    let Ok(mut url) = Url::parse(candidate) else {
        return candidate.to_string();
    };
    if !url.username().is_empty() {
        let _ = url.set_username("redacted");
    }
    if url.password().is_some() {
        let _ = url.set_password(Some("redacted"));
    }
    let original_pairs = url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    let signed_url = original_pairs
        .iter()
        .any(|(key, _)| is_signed_url_query(key));
    let pairs = original_pairs
        .into_iter()
        .map(|(key, value)| {
            let value = if signed_url || is_secret_field(&key) {
                REDACTED.to_string()
            } else {
                value
            };
            (key, value)
        })
        .collect::<Vec<_>>();
    if !pairs.is_empty() {
        url.query_pairs_mut().clear().extend_pairs(pairs);
    }
    url.to_string()
}

fn sanitize_context(value: Value, depth: usize) -> Value {
    if depth >= MAX_CONTEXT_DEPTH {
        return Value::String("[Truncated]".into());
    }
    match value {
        Value::String(value) => Value::String(sanitize_text(&value)),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .take(MAX_CONTEXT_ENTRIES)
                .map(|value| sanitize_context(value, depth + 1))
                .collect(),
        ),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .take(MAX_CONTEXT_ENTRIES)
                .map(|(key, value)| {
                    let value = if is_secret_field(&key) {
                        Value::String(REDACTED.into())
                    } else {
                        sanitize_context(value, depth + 1)
                    };
                    (key, value)
                })
                .collect(),
        ),
        value => value,
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum LocalLogSource {
    Client,
    Server,
    Worker,
    LinkedWorker,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ServiceLogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

impl ServiceLogLevel {
    fn weight(self) -> u8 {
        match self {
            Self::Trace => 10,
            Self::Debug => 20,
            Self::Info => 30,
            Self::Warn => 40,
            Self::Error => 50,
            Self::Fatal => 60,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServiceLogReadRequest {
    source: LocalLogSource,
    worker_id: Option<String>,
    after_cursor: Option<u64>,
    limit: Option<usize>,
    minimum_level: Option<ServiceLogLevel>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DiskServiceLogRecord {
    #[serde(default)]
    cursor: u64,
    timestamp: String,
    system: String,
    level: ServiceLogLevel,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<Value>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalServiceLogRecord {
    cursor: u64,
    timestamp: String,
    system: String,
    level: ServiceLogLevel,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    context: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalServiceLogReadResult {
    records: Vec<LocalServiceLogRecord>,
    next_cursor: u64,
    oldest_cursor: Option<u64>,
    latest_cursor: u64,
    has_more: bool,
    truncated: bool,
}

struct BufferedRecord {
    bytes: usize,
    record: LocalServiceLogRecord,
}

#[derive(Clone)]
struct ManagedArchiveFile {
    compressed: bool,
    created: SystemTime,
    day: String,
    part: u32,
    path: PathBuf,
    size: u64,
}

impl ManagedArchiveFile {
    fn part_key(&self) -> String {
        format!("{}:{:04}", self.day, self.part)
    }
}

fn managed_archive_name(source: &str, day: &str, part: u32) -> String {
    format!("{source}-{day}.part-{part:04}.jsonl")
}

fn parse_managed_archive_file(path: PathBuf, source: &str) -> Option<ManagedArchiveFile> {
    let name = path.file_name()?.to_str()?;
    let suffix = name.strip_prefix(&format!("{source}-"))?;
    let (day, suffix) = suffix.split_at_checked(10)?;
    chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    let suffix = suffix.strip_prefix(".part-")?;
    let (part, extension) = suffix.split_at_checked(4)?;
    let part = part.parse::<u32>().ok()?;
    let compressed = match extension {
        ".jsonl" => false,
        ".jsonl.gz" => true,
        _ => return None,
    };
    let metadata = fs::metadata(&path).ok()?;
    let fallback = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .ok()?
        .and_hms_milli_opt(23, 59, 59, 999)?
        .and_utc()
        .timestamp_millis();
    let fallback = UNIX_EPOCH + Duration::from_millis(fallback.max(0) as u64);
    Some(ManagedArchiveFile {
        compressed,
        created: metadata.created().unwrap_or(fallback),
        day: day.to_string(),
        part,
        path,
        size: metadata.len(),
    })
}

fn managed_archive_files(
    directory: &Path,
    source: &str,
) -> Result<Vec<ManagedArchiveFile>, String> {
    let mut files = fs::read_dir(directory)
        .map_err(|error| format!("Could not list local service logs: {error}"))?
        .filter_map(Result::ok)
        .filter_map(|entry| parse_managed_archive_file(entry.path(), source))
        .collect::<Vec<_>>();
    files.sort_by(|left, right| {
        left.day
            .cmp(&right.day)
            .then(left.part.cmp(&right.part))
            .then(left.compressed.cmp(&right.compressed))
    });
    Ok(files)
}

fn set_private_file_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
}

pub(crate) fn migrate_legacy_archive(
    directory: &Path,
    source: &str,
    legacy_paths: &[PathBuf],
) -> Result<(), String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create local log archive: {error}"))?;
    let mut candidates = Vec::new();
    for base in legacy_paths {
        for suffix in [".3", ".2", ".1", ""] {
            let candidate = PathBuf::from(format!("{}{}", base.display(), suffix));
            if candidate.is_file() {
                let metadata = fs::metadata(&candidate)
                    .map_err(|error| format!("Could not inspect legacy service logs: {error}"))?;
                candidates.push((metadata.modified().unwrap_or(UNIX_EPOCH), candidate));
            }
        }
    }
    candidates.sort_by_key(|(modified, _)| *modified);
    let mut files = managed_archive_files(directory, source)?;
    for (modified, candidate) in candidates {
        let day = chrono::DateTime::<chrono::Utc>::from(modified)
            .format("%Y-%m-%d")
            .to_string();
        let part = files
            .iter()
            .filter(|file| file.day == day)
            .map(|file| file.part)
            .max()
            .unwrap_or(0)
            + 1;
        let destination = directory.join(managed_archive_name(source, &day, part));
        fs::rename(&candidate, &destination)
            .map_err(|error| format!("Could not adopt legacy service logs: {error}"))?;
        set_private_file_permissions(&destination);
        if let Some(file) = parse_managed_archive_file(destination, source) {
            files.push(file);
        }
    }
    Ok(())
}

struct SourceTail {
    bytes: usize,
    cursor: u64,
    directory: PathBuf,
    initialized: bool,
    offsets: HashMap<PathBuf, u64>,
    pending: HashMap<PathBuf, Vec<u8>>,
    read_parts: HashSet<String>,
    records: VecDeque<BufferedRecord>,
    source: String,
}

impl SourceTail {
    fn new(directory: PathBuf, source: impl Into<String>) -> Self {
        Self {
            bytes: 0,
            cursor: 0,
            directory,
            initialized: false,
            offsets: HashMap::new(),
            pending: HashMap::new(),
            read_parts: HashSet::new(),
            records: VecDeque::new(),
            source: source.into(),
        }
    }

    fn append_line(&mut self, line: &[u8]) {
        if line.is_empty() || line.len() > MAX_RECORD_BYTES * 2 {
            return;
        }
        let Ok(mut disk) = serde_json::from_slice::<DiskServiceLogRecord>(line) else {
            return;
        };
        disk.message = sanitize_text(&disk.message);
        disk.system = sanitize_text(&disk.system);
        disk.context = disk.context.map(|context| sanitize_context(context, 0));
        if disk.message.len() > MAX_RECORD_BYTES {
            disk.message.truncate(MAX_RECORD_BYTES);
        }
        self.cursor += 1;
        let record = LocalServiceLogRecord {
            cursor: self.cursor,
            timestamp: disk.timestamp,
            system: disk.system,
            level: disk.level,
            message: disk.message,
            context: disk.context,
        };
        let bytes = serde_json::to_vec(&record)
            .map(|encoded| encoded.len())
            .unwrap_or(MAX_RECORD_BYTES)
            .min(MAX_RECORD_BYTES);
        self.records.push_back(BufferedRecord { bytes, record });
        self.bytes += bytes;
        while self.records.len() > MAX_ENTRIES || self.bytes > MAX_BYTES {
            let Some(removed) = self.records.pop_front() else {
                break;
            };
            self.bytes = self.bytes.saturating_sub(removed.bytes);
        }
    }

    fn consume(&mut self, path: &Path, bytes: &[u8]) {
        let mut pending = self.pending.remove(path).unwrap_or_default();
        pending.extend_from_slice(bytes);
        let mut consumed = 0;
        while let Some(relative) = pending[consumed..].iter().position(|byte| *byte == b'\n') {
            let end = consumed + relative;
            let line = pending[consumed..end].to_vec();
            self.append_line(&line);
            consumed = end + 1;
        }
        if consumed > 0 {
            pending.drain(..consumed);
        }
        if pending.len() <= MAX_RECORD_BYTES * 2 {
            self.pending.insert(path.to_path_buf(), pending);
        }
    }

    fn read_range(&mut self, path: &Path, offset: u64) -> Result<u64, String> {
        let mut file = match File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => return Err(format!("Could not open local service logs: {error}")),
        };
        let length = file
            .metadata()
            .map_err(|error| format!("Could not inspect local service logs: {error}"))?
            .len();
        if offset >= length {
            return Ok(length);
        }
        let bounded_offset = offset.max(length.saturating_sub(MAX_BYTES as u64));
        if bounded_offset > offset {
            self.pending.remove(path);
        }
        file.seek(SeekFrom::Start(bounded_offset))
            .map_err(|error| format!("Could not seek local service logs: {error}"))?;
        let mut contents = Vec::new();
        file.read_to_end(&mut contents)
            .map_err(|error| format!("Could not read local service logs: {error}"))?;
        self.consume(path, &contents);
        Ok(length)
    }

    fn read_gzip(&mut self, path: &Path) -> Result<(), String> {
        let file = File::open(path)
            .map_err(|error| format!("Could not open compressed service logs: {error}"))?;
        let mut decoder = GzDecoder::new(file);
        let mut contents = Vec::new();
        decoder
            .read_to_end(&mut contents)
            .map_err(|error| format!("Could not decompress service logs: {error}"))?;
        self.consume(path, &contents);
        self.pending.remove(path);
        Ok(())
    }

    fn refresh(&mut self) -> Result<(), String> {
        let files = managed_archive_files(&self.directory, &self.source)?;
        if !self.initialized {
            let mut retained_bytes = 0_u64;
            let mut selected = Vec::new();
            for file in files.iter().rev() {
                selected.push(file.clone());
                retained_bytes = retained_bytes.saturating_add(file.size);
                if retained_bytes >= MAX_BYTES as u64 {
                    break;
                }
            }
            selected.reverse();
            for file in selected {
                if file.compressed {
                    self.read_gzip(&file.path)?;
                } else {
                    let offset = self.read_range(&file.path, 0)?;
                    self.offsets.insert(file.path.clone(), offset);
                }
                self.read_parts.insert(file.part_key());
            }
            self.initialized = true;
            return Ok(());
        }

        let current_paths = files
            .iter()
            .map(|file| file.path.clone())
            .collect::<HashSet<_>>();
        self.offsets.retain(|path, _| current_paths.contains(path));
        self.pending.retain(|path, _| current_paths.contains(path));
        for file in files {
            let part_key = file.part_key();
            if file.compressed {
                if self.read_parts.insert(part_key) {
                    self.read_gzip(&file.path)?;
                }
                continue;
            }
            let offset = self.offsets.get(&file.path).copied().unwrap_or(0);
            let length = fs::metadata(&file.path)
                .map(|metadata| metadata.len())
                .unwrap_or(0);
            let offset = if length < offset { 0 } else { offset };
            let next = self.read_range(&file.path, offset)?;
            self.offsets.insert(file.path.clone(), next);
            self.read_parts.insert(part_key);
        }
        Ok(())
    }

    fn read(
        &self,
        after_cursor: u64,
        limit: usize,
        minimum_level: ServiceLogLevel,
    ) -> LocalServiceLogReadResult {
        let oldest_cursor = self.records.front().map(|entry| entry.record.cursor);
        let truncated = oldest_cursor
            .map(|oldest| after_cursor > 0 && after_cursor < oldest.saturating_sub(1))
            .unwrap_or(false);
        let mut records = Vec::new();
        let mut next_cursor = after_cursor;
        let mut has_more = false;
        for entry in &self.records {
            if entry.record.cursor <= after_cursor {
                continue;
            }
            if entry.record.level.weight() >= minimum_level.weight() {
                if records.len() >= limit {
                    has_more = true;
                    break;
                }
                records.push(entry.record.clone());
            }
            next_cursor = entry.record.cursor;
        }
        if !has_more {
            next_cursor = self.cursor.max(next_cursor);
        }
        LocalServiceLogReadResult {
            records,
            next_cursor,
            oldest_cursor,
            latest_cursor: self.cursor,
            has_more,
            truncated,
        }
    }
}

struct DailyJsonlWriter {
    bytes: u64,
    cursor: u64,
    day: String,
    directory: PathBuf,
    path: PathBuf,
    source: String,
}

impl DailyJsonlWriter {
    fn new(directory: PathBuf, source: impl Into<String>) -> Result<Self, String> {
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Could not create local log directory: {error}"))?;
        let mut writer = Self {
            bytes: 0,
            cursor: 0,
            day: String::new(),
            path: PathBuf::new(),
            source: source.into(),
            directory,
        };
        writer.open_day(&chrono::Utc::now().format("%Y-%m-%d").to_string())?;
        writer.maintain()?;
        Ok(writer)
    }

    fn append(
        &mut self,
        level: ServiceLogLevel,
        message: String,
        context: Option<Value>,
    ) -> Result<(), String> {
        let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
        if day != self.day {
            self.open_day(&day)?;
            self.maintain()?;
        }
        self.cursor += 1;
        let mut record = DiskServiceLogRecord {
            cursor: self.cursor,
            timestamp: timestamp_now(),
            system: "client".into(),
            level,
            message: sanitize_text(&message),
            context: context.map(|context| sanitize_context(context, 0)),
        };
        let mut line = serde_json::to_vec(&record)
            .map_err(|error| format!("Could not encode client log: {error}"))?;
        if line.len() >= MAX_RECORD_BYTES {
            record.context = None;
            while line.len() >= MAX_RECORD_BYTES && !record.message.is_empty() {
                let target = record.message.chars().count().saturating_mul(3) / 4;
                record.message = record.message.chars().take(target).collect();
                line = serde_json::to_vec(&record)
                    .map_err(|error| format!("Could not encode client log: {error}"))?;
            }
        }
        line.push(b'\n');
        if self.bytes > 0 && self.bytes + line.len() as u64 > ARCHIVE_PART_BYTES {
            self.open_next_part(&day)?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| format!("Could not open client log: {error}"))?;
        set_private_file_permissions(&self.path);
        file.write_all(&line)
            .map_err(|error| format!("Could not write client log: {error}"))?;
        self.bytes += line.len() as u64;
        let total = managed_archive_files(&self.directory, &self.source)?
            .iter()
            .map(|file| file.size)
            .sum::<u64>();
        if total > ARCHIVE_MAX_BYTES {
            self.enforce_quota()?;
        }
        Ok(())
    }

    fn open_day(&mut self, day: &str) -> Result<(), String> {
        let files = managed_archive_files(&self.directory, &self.source)?;
        let newest = files
            .iter()
            .filter(|file| file.day == day && !file.compressed)
            .max_by_key(|file| file.part);
        let (part, bytes) = newest
            .filter(|file| file.size < ARCHIVE_PART_BYTES)
            .map(|file| (file.part, file.size))
            .unwrap_or_else(|| {
                (
                    files
                        .iter()
                        .filter(|file| file.day == day)
                        .map(|file| file.part)
                        .max()
                        .unwrap_or(0)
                        + 1,
                    0,
                )
            });
        self.day = day.to_string();
        self.path = self
            .directory
            .join(managed_archive_name(&self.source, day, part));
        self.bytes = bytes;
        Ok(())
    }

    fn open_next_part(&mut self, day: &str) -> Result<(), String> {
        let part = managed_archive_files(&self.directory, &self.source)?
            .iter()
            .filter(|file| file.day == day)
            .map(|file| file.part)
            .max()
            .unwrap_or(0)
            + 1;
        self.day = day.to_string();
        self.path = self
            .directory
            .join(managed_archive_name(&self.source, day, part));
        self.bytes = 0;
        Ok(())
    }

    fn maintain(&mut self) -> Result<(), String> {
        self.recover_temporary_files()?;
        let now = SystemTime::now();
        for file in managed_archive_files(&self.directory, &self.source)? {
            if file.compressed || file.path == self.path {
                continue;
            }
            let old_enough = now
                .duration_since(file.created)
                .map(|age| age > COMPRESSION_AGE)
                .unwrap_or(false);
            if !old_enough {
                continue;
            }
            let completed = PathBuf::from(format!("{}.gz", file.path.display()));
            if completed.exists() {
                fs::remove_file(&file.path)
                    .map_err(|error| format!("Could not remove compressed source log: {error}"))?;
                continue;
            }
            let temporary = PathBuf::from(format!("{}.tmp", completed.display()));
            let source = File::open(&file.path)
                .map_err(|error| format!("Could not open service log for compression: {error}"))?;
            let target = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .map_err(|error| format!("Could not create compressed service log: {error}"))?;
            set_private_file_permissions(&temporary);
            let mut encoder = GzEncoder::new(target, Compression::best());
            if let Err(error) = std::io::copy(&mut std::io::BufReader::new(source), &mut encoder)
                .and_then(|_| encoder.finish().map(|_| 0))
            {
                return Err(format!("Could not compress service log: {error}"));
            }
            fs::rename(&temporary, &completed)
                .map_err(|error| format!("Could not publish compressed service log: {error}"))?;
            fs::remove_file(&file.path)
                .map_err(|error| format!("Could not remove compressed source log: {error}"))?;
        }
        self.enforce_quota()
    }

    fn recover_temporary_files(&self) -> Result<(), String> {
        for entry in fs::read_dir(&self.directory)
            .map_err(|error| format!("Could not inspect temporary service logs: {error}"))?
            .filter_map(Result::ok)
        {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let Some(completed_name) = name.strip_suffix(".jsonl.gz.tmp") else {
                continue;
            };
            let completed = self.directory.join(format!("{completed_name}.jsonl.gz"));
            let source = self.directory.join(format!("{completed_name}.jsonl"));
            if (completed.exists() || source.exists())
                && parse_managed_archive_file(completed, &self.source).is_some()
            {
                let _ = fs::remove_file(path);
            }
        }
        Ok(())
    }

    fn enforce_quota(&self) -> Result<(), String> {
        let files = managed_archive_files(&self.directory, &self.source)?;
        let mut total = files.iter().map(|file| file.size).sum::<u64>();
        for file in files {
            if total <= ARCHIVE_MAX_BYTES {
                break;
            }
            if file.path == self.path {
                continue;
            }
            fs::remove_file(&file.path)
                .map_err(|error| format!("Could not prune old service logs: {error}"))?;
            total = total.saturating_sub(file.size);
        }
        Ok(())
    }
}

pub struct LocalServiceLogs {
    archive_root: PathBuf,
    client: Mutex<DailyJsonlWriter>,
    client_directory: PathBuf,
    server_directory: PathBuf,
    worker_directory: PathBuf,
    tails: Mutex<HashMap<String, SourceTail>>,
}

impl LocalServiceLogs {
    pub fn append_client(&self, level: &str, message: String, source: Option<String>) {
        let level = match level {
            "trace" | "debug" => ServiceLogLevel::Debug,
            "warn" => ServiceLogLevel::Warn,
            "error" => ServiceLogLevel::Error,
            _ => ServiceLogLevel::Info,
        };
        let context = source.map(|source| json!({ "source": sanitize_text(&source) }));
        if let Ok(mut writer) = self.client.lock() {
            if let Err(error) = writer.append(level, message, context) {
                eprintln!("Could not persist client log: {error}");
            }
        }
    }

    pub fn runtime_event(&self, level: &str, message: impl Into<String>, context: Option<Value>) {
        let level = match level {
            "trace" => ServiceLogLevel::Trace,
            "debug" => ServiceLogLevel::Debug,
            "warn" => ServiceLogLevel::Warn,
            "error" => ServiceLogLevel::Error,
            "fatal" => ServiceLogLevel::Fatal,
            _ => ServiceLogLevel::Info,
        };
        let message = sanitize_text(&message.into());
        let context = context.map(|context| sanitize_context(context, 0));
        let encoded_context = context
            .as_ref()
            .and_then(|value| serde_json::to_string(value).ok())
            .unwrap_or_default();
        let suffix = if encoded_context.is_empty() {
            String::new()
        } else {
            format!(" {encoded_context}")
        };
        if matches!(
            level,
            ServiceLogLevel::Warn | ServiceLogLevel::Error | ServiceLogLevel::Fatal
        ) {
            eprintln!("[desktop] {} {message}{suffix}", level_label(level));
        } else {
            println!("[desktop] {} {message}{suffix}", level_label(level));
        }
        if let Ok(mut writer) = self.client.lock() {
            if let Err(error) = writer.append(level, message, context) {
                eprintln!("[desktop] ERROR Could not persist native client event: {error}");
            }
        }
    }

    fn read_archive(
        &self,
        directory: PathBuf,
        source: &str,
        request: &LocalServiceLogReadRequest,
    ) -> Result<LocalServiceLogReadResult, String> {
        let key = format!("{}:{source}", directory.to_string_lossy());
        let mut tails = self
            .tails
            .lock()
            .map_err(|_| "The local service log reader is unavailable.".to_string())?;
        let tail = tails
            .entry(key)
            .or_insert_with(|| SourceTail::new(directory, source));
        tail.refresh()?;
        Ok(tail.read(
            request.after_cursor.unwrap_or(0),
            request.limit.unwrap_or(200).clamp(1, 500),
            request.minimum_level.unwrap_or(ServiceLogLevel::Trace),
        ))
    }
}

pub fn build(app: &App) -> Result<LocalServiceLogs, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve application data: {error}"))?;
    let packaged_logs = app_data.join("logs");
    fs::create_dir_all(&packaged_logs)
        .map_err(|error| format!("Could not create local log directory: {error}"))?;

    let archive_root = if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| "Could not resolve the Cantrip repository root.".to_string())?
            .join(".cantrip/dev/logs");
        fs::create_dir_all(&root)
            .map_err(|error| format!("Could not create development logs: {error}"))?;
        root
    } else {
        packaged_logs
    };
    let client_directory = archive_root.join("client");
    let server_directory = archive_root.join("server");
    let worker_directory = archive_root.join("workers/desktop-local");
    migrate_legacy_archive(
        &client_directory,
        "client",
        &[
            archive_root.join("client.jsonl"),
            archive_root.join("client.service.jsonl"),
        ],
    )?;
    migrate_legacy_archive(
        &server_directory,
        "server",
        &[
            archive_root.join("server.jsonl"),
            archive_root.join("server.service.jsonl"),
        ],
    )?;
    migrate_legacy_archive(
        &worker_directory,
        "worker",
        &[
            archive_root.join("worker.jsonl"),
            archive_root.join("worker.service.jsonl"),
        ],
    )?;

    Ok(LocalServiceLogs {
        archive_root,
        client: Mutex::new(DailyJsonlWriter::new(client_directory.clone(), "client")?),
        client_directory,
        server_directory,
        worker_directory,
        tails: Mutex::new(HashMap::new()),
    })
}

pub fn start_maintenance(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let now = chrono::Utc::now();
            let next = (now.date_naive() + chrono::Days::new(1))
                .and_hms_opt(0, 0, 0)
                .expect("UTC midnight must exist")
                .and_utc();
            let delay = (next - now)
                .to_std()
                .unwrap_or_else(|_| Duration::from_secs(1));
            tokio::time::sleep(delay.max(Duration::from_secs(1))).await;
            let logs = app.state::<LocalServiceLogs>();
            if let Ok(mut writer) = logs.client.lock() {
                if let Err(error) = writer.maintain() {
                    eprintln!("Could not maintain client log archive: {error}");
                }
            };
        }
    });
}

#[tauri::command]
pub fn open_local_logs_directory(
    app: AppHandle,
    logs: State<'_, LocalServiceLogs>,
) -> Result<(), String> {
    app.opener()
        .open_path(logs.archive_root.to_string_lossy(), None::<&str>)
        .map_err(|error| format!("Could not open the Cantrip logs directory: {error}"))
}

#[tauri::command]
pub fn read_local_service_logs(
    request: LocalServiceLogReadRequest,
    logs: State<'_, LocalServiceLogs>,
    workers: State<'_, DesktopWorkers>,
) -> Result<LocalServiceLogReadResult, String> {
    let (directory, source) = match request.source {
        LocalLogSource::Client => (logs.client_directory.clone(), "client"),
        LocalLogSource::Server => (logs.server_directory.clone(), "server"),
        LocalLogSource::Worker => (logs.worker_directory.clone(), "worker"),
        LocalLogSource::LinkedWorker => {
            let worker_id = request
                .worker_id
                .as_deref()
                .ok_or_else(|| "Choose a linked worker.".to_string())?;
            (workers.service_log_path(worker_id)?, "worker")
        }
    };
    logs.read_archive(directory, source, &request)
}

fn sanitize_text(value: &str) -> String {
    let controlled = value
        .chars()
        .filter(|character| matches!(character, '\n' | '\t') || !character.is_control())
        .take(MAX_RECORD_BYTES)
        .collect::<String>();
    let named = named_secret_pattern()
        .replace_all(&controlled, |captures: &regex::Captures<'_>| {
            format!("{}{}{}", &captures[1], &captures[2], REDACTED)
        });
    let tokens = provider_token_pattern().replace_all(&named, REDACTED);
    url_pattern()
        .replace_all(&tokens, |captures: &regex::Captures<'_>| {
            redact_url(&captures[0])
        })
        .chars()
        .take(MAX_RECORD_BYTES)
        .collect()
}

fn level_label(level: ServiceLogLevel) -> &'static str {
    match level {
        ServiceLogLevel::Trace => "TRACE",
        ServiceLogLevel::Debug => "DEBUG",
        ServiceLogLevel::Info => "INFO",
        ServiceLogLevel::Warn => "WARN",
        ServiceLogLevel::Error => "ERROR",
        ServiceLogLevel::Fatal => "FATAL",
    }
}

fn timestamp_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_enum_rejects_paths() {
        let input = serde_json::from_value::<LocalServiceLogReadRequest>(json!({
            "source": "../../private",
        }));
        assert!(input.is_err());
    }

    #[test]
    fn local_tail_filters_and_advances_cursors() {
        let root = std::env::temp_dir().join(format!("cantrip-local-log-{}", std::process::id()));
        let path = root.join("worker-2026-08-16.part-0001.jsonl");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            &path,
            concat!(
                "{\"cursor\":1,\"timestamp\":\"2026-08-16T00:00:00.000Z\",\"system\":\"worker\",\"level\":\"info\",\"message\":\"ready\"}\n",
                "{\"cursor\":2,\"timestamp\":\"2026-08-16T00:00:01.000Z\",\"system\":\"worker\",\"level\":\"error\",\"message\":\"failed\"}\n",
            ),
        )
        .unwrap();
        let mut tail = SourceTail::new(root.clone(), "worker");
        tail.refresh().unwrap();
        let result = tail.read(0, 10, ServiceLogLevel::Warn);
        assert_eq!(result.records.len(), 1);
        assert_eq!(result.records[0].message, "failed");
        assert_eq!(result.next_cursor, 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn client_writer_emits_parseable_bounded_jsonl() {
        let root = std::env::temp_dir().join(format!(
            "cantrip-client-log-writer-{}",
            uuid::Uuid::new_v4()
        ));
        let mut writer = DailyJsonlWriter::new(root.clone(), "client").unwrap();
        writer
            .append(
                ServiceLogLevel::Error,
                "client failed".into(),
                Some(json!({ "source": "bootstrap" })),
            )
            .unwrap();
        let path = managed_archive_files(&root, "client").unwrap()[0]
            .path
            .clone();
        let contents = fs::read_to_string(path).unwrap();
        let record = serde_json::from_str::<DiskServiceLogRecord>(contents.trim()).unwrap();
        assert_eq!(record.system, "client");
        assert_eq!(record.message, "client failed");
        assert!(contents.len() < MAX_RECORD_BYTES);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn native_records_redact_nested_credentials_and_url_secrets() {
        let root = std::env::temp_dir().join(format!(
            "cantrip-native-log-redaction-{}",
            uuid::Uuid::new_v4()
        ));
        let mut writer = DailyJsonlWriter::new(root.clone(), "client").unwrap();
        writer
            .append(
                ServiceLogLevel::Warn,
                "refresh failed token=ghp_abcdefghijk".into(),
                Some(json!({
                    "authorization": "Bearer private-token",
                    "API_KEY": "private-api-key",
                    "endpoint": "https://user:pass@example.test/models?access_token=unsafe&view=all",
                    "signed": "https://download.test/artifact?signature=private-signature&expires=private-expiry",
                    "nested": {
                        "deviceCode": "private-device-code",
                        "safe": "kept"
                    }
                })),
            )
            .unwrap();
        let path = managed_archive_files(&root, "client").unwrap()[0]
            .path
            .clone();
        let contents = fs::read_to_string(path).unwrap();
        assert!(!contents.contains("ghp_abcdefghijk"));
        assert!(!contents.contains("private-token"));
        assert!(!contents.contains("private-api-key"));
        assert!(!contents.contains("private-device-code"));
        assert!(!contents.contains("user:pass"));
        assert!(!contents.contains("access_token=unsafe"));
        assert!(!contents.contains("private-signature"));
        assert!(!contents.contains("private-expiry"));
        let record = serde_json::from_str::<DiskServiceLogRecord>(contents.trim()).unwrap();
        assert_eq!(record.context.unwrap()["nested"]["safe"], "kept");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn local_tail_resanitizes_untrusted_disk_context() {
        let root = std::env::temp_dir().join(format!(
            "cantrip-local-tail-redaction-{}",
            uuid::Uuid::new_v4()
        ));
        let path = root.join("worker-2026-08-16.part-0001.jsonl");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            &path,
            concat!(
                "{\"cursor\":1,\"timestamp\":\"2026-08-16T00:00:00.000Z\",\"system\":\"worker\",\"level\":\"warn\",\"message\":\"token=unsafe\",\"context\":{\"cookie\":\"session=unsafe\",\"safe\":\"kept\"}}\n",
            ),
        )
        .unwrap();
        let mut tail = SourceTail::new(root.clone(), "worker");
        tail.refresh().unwrap();
        let result = tail.read(0, 10, ServiceLogLevel::Trace);
        let encoded = serde_json::to_string(&result.records).unwrap();
        assert!(!encoded.contains("session=unsafe"));
        assert!(!encoded.contains("token=unsafe"));
        assert!(encoded.contains("kept"));
        let _ = fs::remove_dir_all(root);
    }
}
