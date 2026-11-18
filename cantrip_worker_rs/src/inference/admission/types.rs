use super::*;
pub trait Ownership: Send + Sync {
    fn available(&self) -> bool;
    fn prepare(&self, generation: JsString) -> Work<HashMap<String, String>>;
    fn retire(&self, generation: JsString) -> Work<()>;
    fn close(&self) -> Work<()>;
    fn journal(&self, command: Value) -> Work<Option<Value>>;
    fn on_lost(&self, listener: super::super::ownership::LostListener);
}
impl Ownership for super::super::ownership::Owner {
    fn available(&self) -> bool {
        self.available()
    }
    fn prepare(&self, generation: JsString) -> Work<HashMap<String, String>> {
        self.prepare(generation)
    }
    fn retire(&self, generation: JsString) -> Work<()> {
        self.retire(generation)
    }
    fn close(&self) -> Work<()> {
        self.close()
    }
    fn journal(&self, command: Value) -> Work<Option<Value>> {
        self.journal(command)
    }
    fn on_lost(&self, listener: super::super::ownership::LostListener) {
        self.on_lost(listener);
    }
}
pub type Report = Arc<dyn Fn(Failure) -> Result<()> + Send + Sync>;
pub type Observer = Arc<dyn Fn(Value) -> Result<()> + Send + Sync>;
pub type Reconcile = Arc<dyn Fn(Value, Signal) -> Work<Value> + Send + Sync>;
pub type TaskBound = Arc<dyn Fn(Value, Value, JsString, Signal) -> Work<()> + Send + Sync>;
#[derive(Clone)]
pub struct Clock {
    pub wall: Arc<dyn Fn() -> f64 + Send + Sync>,
    pub monotonic: Arc<dyn Fn() -> f64 + Send + Sync>,
}
impl Default for Clock {
    fn default() -> Self {
        let start = std::time::Instant::now();
        Self {
            wall: Arc::new(|| chrono::Utc::now().timestamp_millis() as f64),
            monotonic: Arc::new(move || start.elapsed().as_secs_f64() * 1000.),
        }
    }
}
#[derive(Clone)]
pub struct Options {
    pub scope: super::super::ownership::Scope,
    pub ownership: Option<Arc<dyn Ownership>>,
    pub observer_error: Report,
    pub journal_error: Report,
    pub diagnostic: Observer,
    pub reconcile: Option<Reconcile>,
    pub task_bound: Option<TaskBound>,
    pub clock: Clock,
}
impl Options {
    pub fn local(scope: super::super::ownership::Scope) -> Self {
        Self {
            scope,
            ownership: None,
            observer_error: Arc::new(|_| Ok(())),
            journal_error: Arc::new(|_| Ok(())),
            diagnostic: Arc::new(|_| Ok(())),
            reconcile: None,
            task_bound: None,
            clock: Clock::default(),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Waiting,
    Granted,
    Running,
    Cancelling,
    Suspended,
    Released,
}
impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::Granted => "granted",
            Self::Running => "running",
            Self::Cancelling => "cancelling",
            Self::Suspended => "suspended",
            Self::Released => "released",
        }
    }
    pub(super) fn timing(self) -> Option<usize> {
        match self {
            Self::Waiting => Some(0),
            Self::Granted => Some(1),
            Self::Running | Self::Cancelling => Some(2),
            Self::Suspended => Some(3),
            Self::Released => None,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Completed,
    Failed,
    Interrupted,
    RuntimeExited,
    NeverStarted,
}
impl Outcome {
    pub fn name(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
            Self::RuntimeExited => "runtime-exited",
            Self::NeverStarted => "never-started",
        }
    }
}
#[derive(Clone)]
pub struct Request {
    pub lifetime: Lifetime,
    pub input: Input,
}
#[derive(Clone)]
pub struct Input {
    pub operation_id: JsString,
    pub provider_id: JsString,
    pub provider_creation_revision: Option<f64>,
    pub purpose: Option<JsString>,
    pub chat_id: Option<Value>,
    pub project_id: Option<Value>,
    pub recovery_key: Option<Value>,
    pub recovery: Option<Value>,
    pub signal: Option<Signal>,
    pub initially_suspended: bool,
    pub observe: Option<Arc<dyn Fn(Phase) -> Result<()> + Send + Sync>>,
    pub admitted: Option<Arc<dyn Fn() -> Result<()> + Send + Sync>>,
}
impl Request {
    pub fn new(lifetime: Lifetime, provider_id: JsString) -> Self {
        Self {
            input: Input::new(lifetime.operation_id().clone(), provider_id),
            lifetime,
        }
    }
}
impl std::ops::Deref for Request {
    type Target = Input;
    fn deref(&self) -> &Input {
        &self.input
    }
}
impl std::ops::DerefMut for Request {
    fn deref_mut(&mut self) -> &mut Input {
        &mut self.input
    }
}
impl Input {
    pub fn new(operation_id: JsString, provider_id: JsString) -> Self {
        Self {
            operation_id,
            provider_id,
            provider_creation_revision: None,
            purpose: None,
            chat_id: None,
            project_id: None,
            recovery_key: None,
            recovery: None,
            signal: None,
            initially_suspended: false,
            observe: None,
            admitted: None,
        }
    }
    pub(super) fn identity(&self, generation: &JsString) -> Value {
        json!({"operationId":self.operation_id,"providerId":self.provider_id,"runtimeGeneration":generation,"recoveryKey":nullish(&self.recovery_key),"recovery":nullish(&self.recovery),"chatId":nullish(&self.chat_id),"projectId":nullish(&self.project_id)})
    }
}
pub(super) fn nullish(value: &Option<Value>) -> Value {
    value.clone().unwrap_or(Value::Null)
}
#[derive(Clone, Debug)]
pub struct AdmissionError {
    pub message: JsString,
    pub code: Option<&'static str>,
    pub unstarted_unavailable: bool,
}
impl std::fmt::Display for AdmissionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message.lossy())
    }
}
impl std::error::Error for AdmissionError {}
pub(super) fn unavailable() -> anyhow::Error {
    AdmissionError {
        message: "The inference provider was removed or replaced. Select an available provider."
            .into(),
        code: Some("provider-removed"),
        unstarted_unavailable: false,
    }
    .into()
}
pub(super) fn unused(message: &str) -> anyhow::Error {
    AdmissionError {
        message: message.into(),
        code: None,
        unstarted_unavailable: true,
    }
    .into()
}
