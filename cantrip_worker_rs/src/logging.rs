//! Worker archive configuration and subscriptions over the shared log runtime.
use cantrip_config::{Environment, resolve};
use cantrip_logging::{log_archive::Options, logging::Emitter, runtime::Runtime};
use cantrip_wire::{Value, text::trim, value::json};
use std::{
    io::IsTerminal,
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;

pub struct Logs {
    pub emitter: Arc<Emitter>,
    runtime: Arc<Runtime>,
    listeners: Arc<Mutex<Vec<mpsc::UnboundedSender<Value>>>>,
}
pub fn archive_options(data: &Path, environment: &Environment, cwd: &Path) -> Options {
    let get = |key: &str| {
        environment
            .get(key)
            .map(|v| trim(v))
            .filter(|v| !v.is_empty())
    };
    let file = get("CANTRIP_SERVICE_LOG_FILE").map(|v| resolve(cwd, Path::new(v)));
    let directory = get("CANTRIP_SERVICE_LOG_DIR")
        .map(|v| resolve(cwd, Path::new(v)))
        .or_else(|| file.as_ref().map(|p| p.parent().unwrap_or(p).to_path_buf()))
        .unwrap_or_else(|| data.join("logs"));
    let legacy = get("CANTRIP_SERVICE_LOG_FILE").map_or_else(
        || vec!["worker.jsonl".into(), "worker.service.jsonl".into()],
        |p| {
            vec![
                Path::new(p)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
            ]
        },
    );
    Options::new("worker".into(), directory, legacy)
}
impl Logs {
    pub async fn initialize(data: &Path, environment: &Environment, cwd: &Path) -> Self {
        let level = environment
            .get("CANTRIP_LOG_LEVEL")
            .cloned()
            .unwrap_or_else(|| "info".into())
            .to_lowercase();
        let runtime = Arc::new(Runtime::new(Arc::new(move || level.clone())));
        let colors = !environment.contains_key("NO_COLOR")
            && environment
                .get("FORCE_COLOR")
                .map_or_else(|| std::io::stdout().is_terminal(), |v| v != "0");
        runtime
            .initialize(archive_options(data, environment, cwd), colors)
            .await;
        let listeners = Arc::new(Mutex::new(Vec::<mpsc::UnboundedSender<Value>>::new()));
        let output = runtime.clone();
        let subscribers = listeners.clone();
        let emitter = Emitter::with_console_context(
            "worker".into(),
            Arc::new(|| chrono::Utc::now().timestamp_millis() as f64),
            Arc::new(move |record, fields| {
                // Serialize capture and channel admission so subscriptions see cursor
                // order even when several worker tasks emit concurrently.
                let mut senders = subscribers.lock().unwrap();
                let stored = output.capture_record(record, fields);
                senders.retain(|sender| sender.send(stored.clone()).is_ok());
            }),
        );
        Self {
            emitter,
            runtime,
            listeners,
        }
    }
    pub fn event(&self, level: &str, message: &str, context: Value) {
        let _ = self.emitter.event(level, &message.into(), Some(&context));
    }
    pub fn repeated(&self, key: String, level: &str, message: &str, context: Value) {
        let _ = self
            .emitter
            .rate_limited(key.into(), level, &message.into(), Some(&context), None);
    }
    pub fn read(&self, query: &Value) -> anyhow::Result<Value> {
        self.runtime.read_buffer(query)
    }
    pub async fn reopen(&self, data: &Path, environment: &Environment, cwd: &Path) {
        let colors = !environment.contains_key("NO_COLOR")
            && environment
                .get("FORCE_COLOR")
                .map_or_else(|| std::io::stdout().is_terminal(), |v| v != "0");
        self.runtime
            .initialize(archive_options(data, environment, cwd), colors)
            .await;
    }
    pub fn subscribe(&self) -> mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut listeners = self.listeners.lock().unwrap();
        listeners.retain(|sender| !sender.is_closed());
        listeners.push(tx);
        rx
    }
    pub async fn close(&self) {
        let _ = self.emitter.flush_repeated(None);
        self.runtime.close().await;
        self.listeners.lock().unwrap().clear();
    }
}
pub fn error(error: &anyhow::Error) -> Value {
    cantrip_logging::log_sanitize::error(Some(&json!({"name":"Error","message":error.to_string()})))
}
