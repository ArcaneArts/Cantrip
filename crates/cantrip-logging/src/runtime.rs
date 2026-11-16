//! Instance-owned capture, console, serialized archive thread, and explicit close.
use crate::{
    log_archive::{Archive, Options},
    log_records::Buffer,
    logging,
};
use cantrip_wire::Value;
use std::{
    io::Write,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

pub type Level = Arc<dyn Fn() -> String + Send + Sync>;
enum Command {
    Initialize(oneshot::Sender<()>),
    Append(Value),
    Close(oneshot::Sender<()>),
}
struct ArchiveTask {
    send: mpsc::Sender<Command>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}
struct Console {
    colors: bool,
    stdout: Mutex<os_pipe::PipeWriter>,
    stderr: Mutex<os_pipe::PipeWriter>,
}

/// Each process owns its runtime and closes it after its producers stop.
/// The level reader is evaluated per console record, preserving dynamic policy.
pub struct Runtime {
    active: Mutex<Option<Arc<ArchiveTask>>>,
    buffer: Mutex<Buffer>,
    console: Arc<OnceLock<Console>>,
    initialized: AtomicBool,
    level: Level,
}
impl Runtime {
    pub fn new(level: Level) -> Self {
        Self {
            active: Mutex::new(None),
            buffer: Mutex::new(Buffer::new(&Value::Null).expect("default log buffer")),
            console: Arc::new(OnceLock::new()),
            initialized: AtomicBool::new(false),
            level,
        }
    }
    pub fn capture(&self, record: Value) {
        self.capture_kind(record, false, &[]);
    }
    pub fn capture_with_undefined(&self, record: Value, fields: &[&str]) {
        self.capture_kind(record, false, fields);
    }
    /// Capture once and return the exact minimized, cursor-assigned record for
    /// caller-owned subscriptions. Console formatting still uses the full record.
    pub fn capture_record(&self, record: Value, fields: &[&str]) -> Value {
        self.capture_kind(record, false, fields)
    }
    pub fn capture_http(&self, record: Value) {
        self.capture_kind(record, true, &[]);
    }
    pub fn is_initialized(&self) -> bool {
        self.initialized.load(Ordering::Acquire)
    }
    pub fn has_archive(&self) -> bool {
        self.active.lock().unwrap().is_some()
    }
    fn capture_kind(&self, record: Value, http: bool, fields: &[&str]) -> Value {
        let json_record =
            (!fields.is_empty()).then(|| logging::without_undefined(record.clone(), fields));
        let archived = json_record.as_ref().unwrap_or(&record);
        let stored = {
            // Cursor assignment and archive admission share one order even when
            // several Tokio/OS threads emit at the same time.
            let mut buffer = self.buffer.lock().unwrap();
            let stored = buffer.append(archived);
            if let Some(runtime) = self.active.lock().unwrap().as_ref() {
                let _ = runtime.send.send(Command::Append(stored.clone()));
            }
            stored
        };
        let Some(console) = self.console.get() else {
            eprintln!("{}", archived.stringify());
            return stored;
        };
        let level = record["level"].as_str().unwrap_or("info");
        let threshold = (self.level)();
        if (level == "trace" && threshold != "trace")
            || (level == "debug" && threshold != "debug" && threshold != "trace")
        {
            return stored;
        }
        let destination = if matches!(level, "warn" | "error" | "fatal") {
            &console.stderr
        } else {
            &console.stdout
        };
        let line = if http {
            crate::log_format::http(&record, console.colors)
        } else {
            crate::log_format::service_with_undefined(&record, console.colors, fields)
                .unwrap_or_else(|_| archived.stringify().into())
        };
        let _ = writeln!(destination.lock().unwrap(), "{}", line.lossy());
        stored
    }
    pub fn read_buffer(&self, options: &Value) -> anyhow::Result<Value> {
        self.buffer.lock().unwrap().read(options)
    }
    /// Duplicate stdout/stderr and start the archive at the caller's startup point.
    /// Archive failures remain diagnostic-only, as in the existing server sink.
    pub async fn initialize(&self, options: Options, colors: bool) {
        self.initialized.store(true, Ordering::Release);
        if let (Ok(stdout), Ok(stderr)) = (os_pipe::dup_stdout(), os_pipe::dup_stderr()) {
            let _ = self.console.set(Console {
                colors,
                stdout: Mutex::new(stdout),
                stderr: Mutex::new(stderr),
            });
        }
        let source = options.source.clone();
        match spawn_archive(options, self.console.clone()) {
            Ok(runtime) => {
                let (tx, rx) = oneshot::channel();
                *self.active.lock().unwrap() = Some(runtime.clone());
                let _ = runtime.send.send(Command::Initialize(tx));
                let _ = rx.await;
            }
            Err(error) => {
                eprintln!("[{source}] WARN Service log archive initialize failed: {error}")
            }
        }
    }
    /// Stop archive admission, drain admitted records, then join the owned thread.
    /// Call after application producers finish; repeated-event flush is caller-owned.
    pub async fn close(&self) {
        let runtime = self.active.lock().unwrap().take();
        if let Some(runtime) = runtime {
            close_archive(runtime).await;
        }
    }
}
fn spawn_archive(
    options: Options,
    console: Arc<OnceLock<Console>>,
) -> anyhow::Result<Arc<ArchiveTask>> {
    let clock = options.clock.clone();
    let source = options.source.clone();
    let mut archive = Archive::new(options)?;
    let (send, receive) = mpsc::channel();
    let child = thread::Builder::new()
        .name("cantrip-log-archive".into())
        .spawn(move || {
            let (mut timer, mut last_diagnostic) = (None::<Instant>, 0_i64);
            loop {
                let incoming = match timer {
                    Some(at) => receive.recv_timeout(at.saturating_duration_since(Instant::now())),
                    None => receive
                        .recv()
                        .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
                };
                let (operation, result, ack, closing) = match incoming {
                    Ok(Command::Initialize(ack)) => {
                        ("initialize", archive.initialize(), Some(ack), false)
                    }
                    Ok(Command::Append(record)) => ("append", archive.append(&record), None, false),
                    Ok(Command::Close(ack)) => {
                        archive.close();
                        ("close", Ok(()), Some(ack), true)
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        timer = None;
                        ("maintain", archive.maintain(), None, false)
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        archive.close();
                        break;
                    }
                };
                if let Err(error) = result {
                    let now = clock();
                    if now - last_diagnostic >= 30_000 {
                        last_diagnostic = now;
                        let line = format!(
                            "[{source}] WARN Service log archive {operation} failed: {error}"
                        );
                        if let Some(console) = console.get() {
                            let _ = writeln!(console.stderr.lock().unwrap(), "{line}");
                        } else {
                            eprintln!("{line}");
                        }
                    }
                }
                if let Some(delay) = archive.next_delay_ms.take() {
                    timer = Some(
                        Instant::now()
                            + Duration::from_millis(if delay > 2_147_483_647 { 1 } else { delay }),
                    );
                }
                if let Some(ack) = ack {
                    let _ = ack.send(());
                }
                if closing {
                    break;
                }
            }
        })?;
    Ok(Arc::new(ArchiveTask {
        send,
        thread: Mutex::new(Some(child)),
    }))
}
async fn close_archive(runtime: Arc<ArchiveTask>) {
    let (tx, rx) = oneshot::channel();
    let _ = runtime.send.send(Command::Close(tx));
    let _ = rx.await;
    let child = runtime.thread.lock().unwrap().take();
    if let Some(child) = child {
        let _ = tokio::task::spawn_blocking(move || child.join()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_archive::Options;
    use cantrip_wire::value::json;
    use std::sync::OnceLock;
    use std::{fs, io::Read};
    #[tokio::test]
    async fn instances_keep_separate_cursors_archives_and_close_lifetimes() -> anyhow::Result<()> {
        let left = tempfile::tempdir()?;
        let right = tempfile::tempdir()?;
        let a = Runtime::new(Arc::new(|| "info".into()));
        let b = Runtime::new(Arc::new(|| "info".into()));
        a.initialize(
            Options::new("fixture-a".into(), left.path().into(), vec![]),
            false,
        )
        .await;
        b.initialize(
            Options::new("fixture-b".into(), right.path().into(), vec![]),
            false,
        )
        .await;
        let record = |system: &str, attempt: u32| {
            json!({
                "timestamp":"2026-11-08T00:00:00.000Z","system":system,"level":"trace",
                "message":"private detail", "context":json!({"event":"fixture.instance","attempt":attempt})
            })
        };
        a.capture(record("fixture-a", 1));
        b.capture(record("fixture-b", 2));
        a.close().await;
        assert!(!a.has_archive());
        assert!(b.has_archive());
        b.capture(record("fixture-b", 3));
        b.close().await;
        b.close().await;
        for (runtime, root, system, expected) in [
            (&a, left.path(), "fixture-a", vec![1]),
            (&b, right.path(), "fixture-b", vec![2, 3]),
        ] {
            let mut attempts = Vec::new();
            for entry in fs::read_dir(root)? {
                let entry = entry?;
                assert!(entry.file_name().to_str().unwrap().starts_with(system));
                for line in fs::read_to_string(entry.path())?.lines() {
                    let record: Value = serde_json::from_str(line)?;
                    assert_eq!(record["system"], system);
                    assert_eq!(record["cursor"].as_u64(), Some(attempts.len() as u64 + 1));
                    assert_eq!(record["message"], "fixture.instance");
                    attempts.push(record["context"]["attempt"].as_u64().unwrap());
                }
            }
            assert_eq!(attempts, expected);
            assert_eq!(
                runtime.read_buffer(&Value::Null)?["records"]
                    .as_array()
                    .unwrap()
                    .len(),
                expected.len()
            );
        }
        Ok(())
    }
    async fn initialized(options: Options) -> anyhow::Result<Arc<ArchiveTask>> {
        let runtime = spawn_archive(options, Arc::new(OnceLock::new()))?;
        let (tx, rx) = oneshot::channel();
        runtime.send.send(Command::Initialize(tx))?;
        rx.await?;
        Ok(runtime)
    }
    #[tokio::test]
    async fn idle_boundary_timer_compresses_previous_active_file() -> anyhow::Result<()> {
        let root = tempfile::tempdir()?;
        let boundary = (chrono::Utc::now()
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            + chrono::Duration::days(2))
        .timestamp_millis();
        let now = boundary - 250;
        let day = cantrip_wire::date::iso_milliseconds(now).unwrap()[..10].to_owned();
        let plain = root.path().join(format!("server-{day}.part-0001.jsonl"));
        fs::write(&plain, b"previous active record\n")?;
        let mut options = Options::new("server".into(), root.path().into(), vec![]);
        options.compression_age_ms = 1000;
        let start = OnceLock::<Instant>::new();
        options.clock =
            Arc::new(move || now + start.get_or_init(Instant::now).elapsed().as_millis() as i64);
        let runtime = initialized(options).await?;
        assert!(
            plain.is_file(),
            "Initialization must protect the current active file"
        );
        let compressed = plain.with_extension("jsonl.gz");
        let deadline = Instant::now() + Duration::from_secs(10);
        while !compressed.is_file() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        close_archive(runtime).await;
        let mut content = String::new();
        flate2::read::GzDecoder::new(fs::File::open(compressed)?).read_to_string(&mut content)?;
        assert_eq!(content, "previous active record\n");
        assert!(!plain.exists());
        Ok(())
    }
    #[tokio::test]
    async fn close_drains_concurrent_producers_before_joining() -> anyhow::Result<()> {
        let root = tempfile::tempdir()?;
        let runtime =
            initialized(Options::new("server".into(), root.path().into(), vec![])).await?;
        let capture_runtime = Runtime::new(Arc::new(|| "info".into()));
        *capture_runtime.active.lock().unwrap() = Some(runtime.clone());
        thread::scope(|scope| {
            for producer in 0..4 {
                let capture_runtime = &capture_runtime;
                scope.spawn(move || {
                    for index in 0..32 {
                        capture_runtime.capture(json!({"timestamp":"2026-11-08T00:00:00.000Z","system":"server","level":"trace","message":"private human message","context":json!({"event":"fixture.concurrent-capture","producerId":producer.to_string(),"attempt":index})}));
                    }
                });
            }
        });
        capture_runtime.active.lock().unwrap().take();
        close_archive(runtime.clone()).await;
        assert!(runtime.send.send(Command::Append(Value::Null)).is_err());
        let mut identities = std::collections::HashSet::new();
        let mut previous_cursor = 0;
        for entry in fs::read_dir(root.path())? {
            for line in fs::read_to_string(entry?.path())?.lines() {
                let record: serde_json::Value = serde_json::from_str(line)?;
                let cursor = record["cursor"].as_u64().unwrap();
                assert!(
                    cursor > previous_cursor,
                    "Archive order must follow buffer cursor order"
                );
                previous_cursor = cursor;
                if record["context"]["event"] != "fixture.concurrent-capture" {
                    continue;
                }
                assert_eq!(record["message"], "fixture.concurrent-capture");
                assert!(identities.insert((
                    record["context"]["producerId"].as_str().unwrap().to_owned(),
                    record["context"]["attempt"].as_u64().unwrap()
                )));
            }
        }
        assert_eq!(identities.len(), 128);
        Ok(())
    }
}
