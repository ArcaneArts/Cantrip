//! Server-owned logging configuration, singleton, and lifecycle messages.
use super::{
    log_archive::Options,
    logging::{self, LogCall},
};
use crate::{
    config::Environment,
    wire::{Value, value::json},
};
use cantrip_logging::runtime::Runtime;
use std::{
    io::IsTerminal,
    path::{Component, Path, PathBuf},
    sync::{
        Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};
fn runtime() -> &'static Runtime {
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();
    RUNTIME.get_or_init(|| {
        Runtime::new(std::sync::Arc::new(|| {
            std::env::var("CANTRIP_LOG_LEVEL")
                .unwrap_or_else(|_| "info".into())
                .to_lowercase()
        }))
    })
}
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
static SHUTDOWN_STARTED: Mutex<Option<Instant>> = Mutex::new(None);
pub fn capture(record: Value) {
    runtime().capture(record);
}
pub fn capture_with_undefined(record: Value, fields: &[&str]) {
    runtime().capture_with_undefined(record, fields);
}
pub fn capture_http(record: Value) {
    runtime().capture_http(record);
}
pub fn is_initialized() -> bool {
    runtime().is_initialized()
}
pub fn read_buffer(options: &Value) -> anyhow::Result<Value> {
    runtime().read_buffer(options)
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
    Options::new("server".into(), directory, legacy)
}
pub async fn initialize(data: &Path, environment: &Environment, cwd: &Path) {
    let colors = std::env::var_os("NO_COLOR").is_none()
        && std::env::var_os("FORCE_COLOR")
            .map_or_else(|| std::io::stdout().is_terminal(), |v| v != "0");
    runtime()
        .initialize(archive_options(data, environment, cwd), colors)
        .await;
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
    if !runtime().has_archive() {
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
    runtime().close().await;
}
