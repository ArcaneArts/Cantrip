//! Process-local capture and owned, serialized filesystem archive lifetime.
use super::{
    log_archive::{Archive, Options},
    log_records::Buffer,
    logging::{self, LogCall},
};
use crate::{
    config::Environment,
    wire::{Value, value::json},
};
use std::{
    io::{IsTerminal, Write},
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

enum Command {
    Initialize(oneshot::Sender<()>),
    Append(Value),
    Close(oneshot::Sender<()>),
}
struct Runtime {
    send: mpsc::Sender<Command>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
}
struct Console {
    colors: bool,
    stdout: Mutex<os_pipe::PipeWriter>,
    stderr: Mutex<os_pipe::PipeWriter>,
}
fn active() -> &'static Mutex<Option<Arc<Runtime>>> {
    static ACTIVE: OnceLock<Mutex<Option<Arc<Runtime>>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(None))
}
fn buffer() -> &'static Mutex<Buffer> {
    static BUFFER: OnceLock<Mutex<Buffer>> = OnceLock::new();
    BUFFER.get_or_init(|| Mutex::new(Buffer::new(&Value::Null).expect("default log buffer")))
}
static CONSOLE: OnceLock<Console> = OnceLock::new();
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
static INITIALIZED: AtomicBool = AtomicBool::new(false);
static SHUTDOWN_STARTED: Mutex<Option<Instant>> = Mutex::new(None);
pub fn capture(record: Value) {
    capture_kind(record, false)
}
pub fn capture_http(record: Value) {
    capture_kind(record, true)
}
pub fn is_initialized() -> bool {
    INITIALIZED.load(Ordering::Acquire)
}
fn capture_kind(record: Value, http: bool) {
    {
        // Cursor assignment and archive admission share one order even when
        // several Tokio/OS threads emit at the same time.
        let mut buffer = buffer().lock().unwrap();
        let stored = buffer.append(&record);
        if let Some(runtime) = active().lock().unwrap().as_ref() {
            let _ = runtime.send.send(Command::Append(stored));
        }
    }
    let Some(console) = CONSOLE.get() else {
        eprintln!("{}", record.stringify());
        return;
    };
    let level = record["level"].as_str().unwrap_or("info");
    let threshold = std::env::var("CANTRIP_LOG_LEVEL")
        .unwrap_or_else(|_| "info".into())
        .to_lowercase();
    if (level == "trace" && threshold != "trace")
        || (level == "debug" && threshold != "debug" && threshold != "trace")
    {
        return;
    }
    let destination = if matches!(level, "warn" | "error" | "fatal") {
        &console.stderr
    } else {
        &console.stdout
    };
    let line = if http {
        super::log_format::http(&record, console.colors)
    } else {
        super::log_format::service(&record, console.colors)
            .unwrap_or_else(|_| record.stringify().into())
    };
    let _ = writeln!(destination.lock().unwrap(), "{}", line.lossy());
}
pub fn read_buffer(options: &Value) -> anyhow::Result<Value> {
    buffer().lock().unwrap().read(options)
}
fn resolve(cwd: &Path, value: &str) -> PathBuf {
    let joined = cwd.join(value);
    let mut path = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                path.pop();
            }
            other => path.push(other.as_os_str()),
        }
    }
    path
}
pub fn archive_options(data: &Path, environment: &Environment, cwd: &Path) -> Options {
    let trimmed = |key: &str| {
        environment
            .get(key)
            .map(|value| crate::text::trim(value))
            .filter(|s| !s.is_empty())
    };
    let file = trimmed("CANTRIP_SERVICE_LOG_FILE").map(|s| resolve(cwd, s));
    let directory = trimmed("CANTRIP_SERVICE_LOG_DIR")
        .map(|s| resolve(cwd, s))
        .or_else(|| {
            file.as_ref()
                .map(|file| file.parent().unwrap_or(file).to_owned())
        })
        .unwrap_or_else(|| data.join("logs"));
    let legacy = trimmed("CANTRIP_SERVICE_LOG_FILE").map_or_else(
        || vec!["server.jsonl".into(), "server.service.jsonl".into()],
        |p| {
            let separator = |c| c == '/' || (cfg!(windows) && c == '\\');
            vec![
                p.trim_end_matches(separator)
                    .rsplit(separator)
                    .next()
                    .unwrap_or("")
                    .into(),
            ]
        },
    );
    Options::server(directory, legacy)
}
pub async fn initialize(data: &Path, environment: &Environment, cwd: &Path) {
    INITIALIZED.store(true, Ordering::Release);
    if let (Ok(stdout), Ok(stderr)) = (os_pipe::dup_stdout(), os_pipe::dup_stderr()) {
        let _ = CONSOLE.set(Console {
            colors: std::env::var_os("NO_COLOR").is_none()
                && std::env::var_os("FORCE_COLOR")
                    .map_or_else(|| std::io::stdout().is_terminal(), |v| v != "0"),
            stdout: Mutex::new(stdout),
            stderr: Mutex::new(stderr),
        });
    }
    match spawn_archive(archive_options(data, environment, cwd)) {
        Ok(runtime) => {
            let (tx, rx) = oneshot::channel();
            *active().lock().unwrap() = Some(runtime.clone());
            let _ = runtime.send.send(Command::Initialize(tx));
            let _ = rx.await;
        }
        Err(error) => eprintln!("[server] WARN Service log archive initialize failed: {error}"),
    }
}
fn spawn_archive(options: Options) -> std::io::Result<Arc<Runtime>> {
    let clock = options.clock.clone();
    let mut archive = Archive::new(options).expect("fixed server archive options");
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
                            "[server] WARN Service log archive {operation} failed: {error}"
                        );
                        if let Some(console) = CONSOLE.get() {
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
    Ok(Arc::new(Runtime {
        send,
        thread: Mutex::new(Some(child)),
    }))
}
async fn close_archive(runtime: Arc<Runtime>) {
    let (tx, rx) = oneshot::channel();
    let _ = runtime.send.send(Command::Close(tx));
    let _ = rx.await;
    let child = runtime.thread.lock().unwrap().take();
    if let Some(child) = child {
        let _ = tokio::task::spawn_blocking(move || child.join()).await;
    }
}

pub fn lifecycle(
    level: &'static str,
    message: &'static str,
    event: &str,
    operation: &str,
    status: &str,
    extra: Value,
) {
    let mut context =
        json!({"event":event,"subsystem":"server-lifecycle","operation":operation,"status":status});
    if let (Value::Object(context), Value::Object(extra)) = (&mut context, &extra) {
        for (key, value) in extra {
            context.insert(key.clone(), value.clone());
        }
    }
    logging::server_logger()(LogCall::event(level, message, context));
}
pub fn startup_started(config: &crate::config::ServerConfig) {
    lifecycle(
        "info",
        "Cantrip Server startup began",
        "server.startup.started",
        "start",
        "starting",
        json!({"serverVersion":crate::settings::quota::server_version(),"deploymentMode":match config.deployment_mode{crate::config::DeploymentMode::Local=>"local",crate::config::DeploymentMode::Hosted=>"hosted"},"databaseEngine":if config.database_mode==crate::config::DatabaseMode::Pglite{"pglite"}else{"postgres"},"sharedCoordination":config.redis_url.is_some()}),
    );
}
pub fn database_ready(engine: &str, started: Instant) {
    lifecycle(
        "info",
        "Database is ready",
        "server.startup.database-ready",
        "connect-database",
        "ready",
        json!({"durationMs":started.elapsed().as_millis() as f64,"databaseEngine":engine}),
    );
}
pub fn ready(engine: &str, shared: bool, started: Instant) {
    lifecycle(
        "info",
        "Cantrip Server is ready",
        "server.startup.completed",
        "start",
        "ready",
        json!({"serverVersion":crate::settings::quota::server_version(),"durationMs":started.elapsed().as_millis() as f64,"databaseEngine":engine,"sharedCoordination":shared}),
    );
}
pub fn begin_shutdown(reason: &str) {
    SHUTTING_DOWN.store(true, Ordering::Release);
    *SHUTDOWN_STARTED.lock().unwrap() = Some(Instant::now());
    lifecycle(
        "info",
        "Cantrip Server shutdown began",
        "server.shutdown.started",
        "shutdown",
        "stopping",
        json!({"reasonCode":reason}),
    );
}
pub async fn finish(error: Option<&anyhow::Error>) {
    if active().lock().unwrap().is_none() {
        return;
    }
    match error {
        Some(error) => {
            let stopping = SHUTTING_DOWN.load(Ordering::Acquire);
            let mut extra = json!({"reasonCode":if stopping{"cleanup-failed"}else{"startup-error"},"error":logging::error_details(error)});
            if !stopping {
                extra["serverVersion"] = json!(crate::settings::quota::server_version());
            }
            lifecycle(
                if stopping { "error" } else { "fatal" },
                if stopping {
                    "Cantrip Server shutdown cleanup failed"
                } else {
                    "Cantrip Server failed to start"
                },
                if stopping {
                    "server.shutdown.failed"
                } else {
                    "server.startup.failed"
                },
                if stopping { "shutdown" } else { "start" },
                "failed",
                extra,
            );
        }
        None if SHUTTING_DOWN.load(Ordering::Acquire) => {
            let duration = SHUTDOWN_STARTED
                .lock()
                .unwrap()
                .map_or(0, |at| at.elapsed().as_millis());
            lifecycle(
                "info",
                "Cantrip Server shutdown completed",
                "server.shutdown.completed",
                "shutdown",
                "stopped",
                json!({"durationMs":duration as f64}),
            );
        }
        None => {}
    }
    let runtime = active().lock().unwrap().take();
    if let Some(runtime) = runtime {
        close_archive(runtime).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Read};
    async fn initialized(options: Options) -> anyhow::Result<Arc<Runtime>> {
        let runtime = spawn_archive(options)?;
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
        let day = crate::wire::date_iso_milliseconds(now).unwrap()[..10].to_owned();
        let plain = root.path().join(format!("server-{day}.part-0001.jsonl"));
        fs::write(&plain, b"previous active record\n")?;
        let mut options = Options::server(root.path().into(), vec![]);
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
        let runtime = initialized(Options::server(root.path().into(), vec![])).await?;
        *active().lock().unwrap() = Some(runtime.clone());
        thread::scope(|scope| {
            for producer in 0..4 {
                scope.spawn(move || {
                    for index in 0..32 {
                        capture(json!({"timestamp":"2026-11-08T00:00:00.000Z","system":"server","level":"trace","message":"private human message","context":json!({"event":"fixture.concurrent-capture","producerId":producer.to_string(),"attempt":index})}));
                    }
                });
            }
        });
        active().lock().unwrap().take();
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
