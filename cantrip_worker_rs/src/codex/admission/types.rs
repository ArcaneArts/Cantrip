use super::*;
pub type Queued = Arc<dyn Fn() -> Work<()> + Send + Sync>;
pub type Track = Arc<dyn Fn(JsString) -> Result<()> + Send + Sync>;
#[derive(Clone)]
pub struct Input {
    pub purpose: Option<JsString>,
    pub operation_id: JsString,
    pub provider: Value,
    pub chat_id: Option<Value>,
    pub project_id: Option<Value>,
    pub thread_id: Option<JsString>,
    pub expected_turn_id: Option<JsString>,
    pub native_scope_id: Option<JsString>,
    pub signal: Option<Signal>,
    pub initially_suspended: bool,
    pub recovery_key: Option<Value>,
    pub recovery: Option<Value>,
    pub on_queued: Option<Queued>,
    pub track: Option<Track>,
    pub on_native_bound: Option<Arc<dyn Fn() -> Result<()> + Send + Sync>>,
}
impl Input {
    pub fn new(operation_id: JsString, provider: Value) -> Self {
        Self {
            purpose: None,
            operation_id,
            provider,
            chat_id: None,
            project_id: None,
            thread_id: None,
            expected_turn_id: None,
            native_scope_id: None,
            signal: None,
            initially_suspended: false,
            recovery_key: None,
            recovery: None,
            on_queued: None,
            track: None,
            on_native_bound: None,
        }
    }
    pub(super) fn provider_id(&self) -> JsString {
        self.provider["id"]
            .as_js_string()
            .cloned()
            .unwrap_or_else(|| "".into())
    }
    pub(super) fn worker_request(&self, lifetime: Lifetime) -> WorkerRequest {
        let mut request = WorkerRequest::new(lifetime, self.provider_id());
        request.operation_id = self.operation_id.clone();
        request.purpose = self.purpose.clone();
        request.provider_creation_revision =
            self.provider["inferenceCatalogCreatedRevision"].as_f64();
        request.chat_id = self.chat_id.clone();
        request.project_id = self.project_id.clone();
        request.signal = self.signal.clone();
        request.recovery_key = self.recovery_key.clone();
        request.recovery = self.recovery.clone();
        request.initially_suspended = self.initially_suspended;
        request
    }
    pub(super) fn identity(&self) -> String {
        json!([
            Value::String(self.operation_id.clone()),
            Value::String(self.provider_id()),
            nullish(self.provider.get("inferenceCatalogCreatedRevision")),
            json!(self.purpose.clone().unwrap_or_else(|| "helper".into())),
            nullish(self.chat_id.as_ref()),
            nullish(self.project_id.as_ref()),
            json!(self.thread_id),
            json!(self.expected_turn_id),
            json!(self.native_scope_id),
            nullish(self.recovery_key.as_ref()),
            json!(identity::recovery(&nullish(self.recovery.as_ref())))
        ])
        .stringify()
    }
}
#[derive(Clone)]
pub struct Acquire {
    pub input: Input,
    pub lifetime: Option<Lifetime>,
}
impl Acquire {
    pub fn new(lifetime: Lifetime, provider: Value) -> Self {
        Self {
            input: Input::new(lifetime.operation_id().clone(), provider),
            lifetime: Some(lifetime),
        }
    }
}
impl std::ops::Deref for Acquire {
    type Target = Input;
    fn deref(&self) -> &Input {
        &self.input
    }
}
impl std::ops::DerefMut for Acquire {
    fn deref_mut(&mut self) -> &mut Input {
        &mut self.input
    }
}
pub type Confirm = Arc<dyn Fn() -> Work<Value> + Send + Sync>;
pub type TaskQueued = Arc<dyn Fn(Value, JsString, JsString) -> Work<()> + Send + Sync>;
pub type TaskDispatch =
    Arc<dyn Fn(Value, JsString, Value, Value, JsString) -> Work<()> + Send + Sync>;
#[derive(Clone)]
pub struct NativeRequest {
    pub gate_attempt_id: JsString,
    pub confirm_ownership: Confirm,
    pub goal_epoch: Option<JsString>,
    pub runner_generation: Option<JsString>,
    pub task_goal_cycle: Option<Value>,
    pub on_task_goal_queued: Option<TaskQueued>,
    pub on_task_goal_dispatch: Option<TaskDispatch>,
    pub thread_id: JsString,
    pub turn_id: JsString,
    pub scope_id: JsString,
    pub provider: Value,
    pub signal: Signal,
    pub is_paused: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    pub root_thread_id: Option<JsString>,
    pub chat_id: Option<Value>,
    pub project_id: Option<Value>,
    pub independent: bool,
}
#[derive(Clone)]
pub struct Revoked {
    pub thread_id: JsString,
    pub turn_id: JsString,
    pub settled: Promise<()>,
}
pub type OnRevoked = Arc<dyn Fn(Revoked) -> Result<()> + Send + Sync>;
pub(super) fn nullish(value: Option<&Value>) -> Value {
    value
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(Value::Null)
}
pub(super) fn unused(message: &str) -> anyhow::Error {
    AdmissionError {
        message: message.into(),
        code: None,
        unstarted_unavailable: true,
    }
    .into()
}
pub(super) fn key(thread: &JsString, turn: &JsString, scope: Option<&JsString>) -> String {
    let mut fields = vec![Value::String(thread.clone()), Value::String(turn.clone())];
    if let Some(scope) = scope.filter(|s| !s.is_empty()) {
        fields.push(Value::String(scope.clone()));
    }
    Value::Array(fields).stringify()
}
