use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{App, Manager, State};

use crate::desktop_worker::DesktopWorkers;

const MAX_BYTES: usize = 5 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
const MAX_FILES: usize = 3;
const MAX_RECORD_BYTES: usize = 16 * 1024;

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

struct SourceTail {
    bytes: usize,
    cursor: u64,
    initialized: bool,
    offset: u64,
    path: PathBuf,
    pending: Vec<u8>,
    records: VecDeque<BufferedRecord>,
}

impl SourceTail {
    fn new(path: PathBuf) -> Self {
        Self {
            bytes: 0,
            cursor: 0,
            initialized: false,
            offset: 0,
            path,
            pending: Vec::new(),
            records: VecDeque::new(),
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

    fn consume(&mut self, bytes: &[u8]) {
        self.pending.extend_from_slice(bytes);
        let mut consumed = 0;
        while let Some(relative) = self.pending[consumed..]
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let end = consumed + relative;
            let line = self.pending[consumed..end].to_vec();
            self.append_line(&line);
            consumed = end + 1;
        }
        if consumed > 0 {
            self.pending.drain(..consumed);
        }
        if self.pending.len() > MAX_RECORD_BYTES * 2 {
            self.pending.clear();
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
            self.pending.clear();
        }
        file.seek(SeekFrom::Start(bounded_offset))
            .map_err(|error| format!("Could not seek local service logs: {error}"))?;
        let mut contents = Vec::new();
        file.read_to_end(&mut contents)
            .map_err(|error| format!("Could not read local service logs: {error}"))?;
        self.consume(&contents);
        Ok(length)
    }

    fn refresh(&mut self) -> Result<(), String> {
        if !self.initialized {
            for index in (1..=MAX_FILES).rev() {
                let archive = PathBuf::from(format!("{}.{}", self.path.display(), index));
                self.read_range(&archive, 0)?;
                self.pending.clear();
            }
            let path = self.path.clone();
            self.offset = self.read_range(&path, 0)?;
            self.initialized = true;
            return Ok(());
        }

        let length = fs::metadata(&self.path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if length < self.offset {
            let archive = PathBuf::from(format!("{}.1", self.path.display()));
            self.read_range(&archive, self.offset)?;
            self.pending.clear();
            self.offset = 0;
        }
        let path = self.path.clone();
        self.offset = self.read_range(&path, self.offset)?;
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

struct RotatingJsonlWriter {
    bytes: u64,
    cursor: u64,
    path: PathBuf,
}

impl RotatingJsonlWriter {
    fn new(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Could not create local log directory: {error}"))?;
        }
        let bytes = fs::metadata(&path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        Ok(Self {
            bytes,
            cursor: 0,
            path,
        })
    }

    fn rotate(&mut self) -> Result<(), String> {
        let oldest = PathBuf::from(format!("{}.{}", self.path.display(), MAX_FILES));
        let _ = fs::remove_file(oldest);
        for index in (1..MAX_FILES).rev() {
            let source = PathBuf::from(format!("{}.{}", self.path.display(), index));
            let target = PathBuf::from(format!("{}.{}", self.path.display(), index + 1));
            if source.exists() {
                fs::rename(source, target)
                    .map_err(|error| format!("Could not rotate client logs: {error}"))?;
            }
        }
        if self.path.exists() {
            fs::rename(
                &self.path,
                PathBuf::from(format!("{}.1", self.path.display())),
            )
            .map_err(|error| format!("Could not rotate client logs: {error}"))?;
        }
        self.bytes = 0;
        Ok(())
    }

    fn append(
        &mut self,
        level: ServiceLogLevel,
        message: String,
        context: Option<Value>,
    ) -> Result<(), String> {
        self.cursor += 1;
        let mut record = DiskServiceLogRecord {
            cursor: self.cursor,
            timestamp: timestamp_now(),
            system: "client".into(),
            level,
            message: sanitize_text(&message),
            context,
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
        if self.bytes > 0 && self.bytes + line.len() as u64 > MAX_BYTES as u64 {
            self.rotate()?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| format!("Could not open client log: {error}"))?;
        file.write_all(&line)
            .map_err(|error| format!("Could not write client log: {error}"))?;
        self.bytes += line.len() as u64;
        Ok(())
    }
}

pub struct LocalServiceLogs {
    client: Mutex<RotatingJsonlWriter>,
    client_path: PathBuf,
    server_path: PathBuf,
    worker_path: PathBuf,
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

    fn read_path(
        &self,
        path: PathBuf,
        request: &LocalServiceLogReadRequest,
    ) -> Result<LocalServiceLogReadResult, String> {
        let key = path.to_string_lossy().into_owned();
        let mut tails = self
            .tails
            .lock()
            .map_err(|_| "The local service log reader is unavailable.".to_string())?;
        let tail = tails.entry(key).or_insert_with(|| SourceTail::new(path));
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

    let (client_path, server_path, worker_path) = if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| "Could not resolve the Cantrip repository root.".to_string())?
            .join(".cantrip/dev/logs");
        fs::create_dir_all(&root)
            .map_err(|error| format!("Could not create development logs: {error}"))?;
        (
            root.join("client.jsonl"),
            root.join("server.jsonl"),
            root.join("worker.jsonl"),
        )
    } else {
        (
            packaged_logs.join("client.service.jsonl"),
            packaged_logs.join("server.service.jsonl"),
            packaged_logs.join("worker.service.jsonl"),
        )
    };

    Ok(LocalServiceLogs {
        client: Mutex::new(RotatingJsonlWriter::new(client_path.clone())?),
        client_path,
        server_path,
        worker_path,
        tails: Mutex::new(HashMap::new()),
    })
}

#[tauri::command]
pub fn read_local_service_logs(
    request: LocalServiceLogReadRequest,
    logs: State<'_, LocalServiceLogs>,
    workers: State<'_, DesktopWorkers>,
) -> Result<LocalServiceLogReadResult, String> {
    let path = match request.source {
        LocalLogSource::Client => logs.client_path.clone(),
        LocalLogSource::Server => logs.server_path.clone(),
        LocalLogSource::Worker => logs.worker_path.clone(),
        LocalLogSource::LinkedWorker => {
            let worker_id = request
                .worker_id
                .as_deref()
                .ok_or_else(|| "Choose a linked worker.".to_string())?;
            workers.service_log_path(worker_id)?
        }
    };
    logs.read_path(path, &request)
}

fn sanitize_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| matches!(character, '\n' | '\t') || !character.is_control())
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
        let path = root.join("service.jsonl");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            &path,
            concat!(
                "{\"cursor\":1,\"timestamp\":\"2026-08-16T00:00:00.000Z\",\"system\":\"worker\",\"level\":\"info\",\"message\":\"ready\"}\n",
                "{\"cursor\":2,\"timestamp\":\"2026-08-16T00:00:01.000Z\",\"system\":\"worker\",\"level\":\"error\",\"message\":\"failed\"}\n",
            ),
        )
        .unwrap();
        let mut tail = SourceTail::new(path);
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
        let path = root.join("client.jsonl");
        let mut writer = RotatingJsonlWriter::new(path.clone()).unwrap();
        writer
            .append(
                ServiceLogLevel::Error,
                "client failed".into(),
                Some(json!({ "source": "bootstrap" })),
            )
            .unwrap();
        let contents = fs::read_to_string(path).unwrap();
        let record = serde_json::from_str::<DiskServiceLogRecord>(contents.trim()).unwrap();
        assert_eq!(record.system, "client");
        assert_eq!(record.message, "client failed");
        assert!(contents.len() < MAX_RECORD_BYTES);
        let _ = fs::remove_dir_all(root);
    }
}
