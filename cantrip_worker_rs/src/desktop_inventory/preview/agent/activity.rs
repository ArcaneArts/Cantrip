use super::super::input;
use crate::metadata::Signal;
use cantrip_wire::{JsString, Value, value::json};
use uuid::Uuid;

/// Correlation supplied by the observed execution. The publisher receives
/// only typed operation metadata.
pub struct HostActivity<'a> {
    pub chat: &'a Value,
    pub worker: &'a Value,
    pub task: &'a Value,
    pub thread: &'a JsString,
    pub turn: &'a JsString,
    pub scope: &'a Value,
    pub item: &'a Value,
    pub request: Uuid,
    pub publish: &'a (dyn Fn(Value) + Send + Sync),
}

impl HostActivity<'_> {
    pub(crate) fn terminal(&self, reset: bool, signal: Signal) -> Record<'_> {
        Record::new(
            self,
            self.request,
            if reset { "js.reset" } else { "js.evaluate" },
            signal,
        )
    }

    pub(super) fn action(
        &self,
        operation: &'static str,
        command: &Value,
        session: &Value,
        target: &Value,
        signal: Signal,
    ) -> Record<'_> {
        let mut record = Record::new(self, Uuid::new_v4(), operation, signal);
        record.target = target.clone();
        record.session = session.clone();
        record.method = input::method(command, "");
        if operation == "input.click" {
            record.position = command
                .get("position")
                .unwrap_or(&session["cursor"]["position"])
                .clone();
        }
        record
    }
}

pub(crate) struct Record<'a> {
    context: &'a HostActivity<'a>,
    id: Uuid,
    operation: &'static str,
    signal: Signal,
    started: i64,
    finished: bool,
    code: Option<String>,
    submitted: bool,
    session: Value,
    target: Value,
    input: Value,
    image: Value,
    method: Option<&'static str>,
    position: Value,
}

impl<'a> Record<'a> {
    fn new(
        context: &'a HostActivity<'a>,
        id: Uuid,
        operation: &'static str,
        signal: Signal,
    ) -> Self {
        Self {
            context,
            id,
            operation,
            signal,
            started: chrono::Utc::now().timestamp_millis(),
            finished: false,
            code: None,
            submitted: false,
            session: Value::Null,
            target: Value::Null,
            input: Value::Null,
            image: Value::Null,
            method: None,
            position: Value::Null,
        }
    }

    pub(crate) fn session(&mut self, session: Value) {
        if !session.is_null() {
            self.session = session;
        }
    }

    pub(super) fn submitted(&mut self) {
        self.submitted = true;
    }

    pub(super) fn result(&mut self, result: &Value) {
        self.session(result["session"].clone());
        self.input = result["input"].clone();
        if self.operation == "observation.snapshot" {
            self.image = result["image"].clone();
        }
    }

    pub(crate) fn complete(&mut self, code: Option<&str>) {
        self.finished = true;
        self.code = code.map(str::to_owned);
        if code.is_some() {
            self.image = Value::Null;
        }
    }
}

impl Drop for Record<'_> {
    fn drop(&mut self) {
        let context = self.context;
        let completed = chrono::Utc::now().timestamp_millis().max(self.started);
        let duration = completed - self.started;
        let code = self
            .code
            .as_deref()
            .or((!self.finished).then_some("cancelled"));
        let outcome = match code {
            _ if self.signal.check().is_err() => "cancelled",
            Some("cancelled" | "revoked" | "closed") => "cancelled",
            Some("denied") => "declined",
            Some(_) => "failed",
            None => "completed",
        };
        let status = if outcome == "cancelled" {
            "failed"
        } else {
            outcome
        };
        let target = if self.target.is_null() && !self.session["target"].is_null() {
            json!({"targetId":self.session["target"]["id"],"targetGeneration":self.session["target"]["generation"]})
        } else {
            std::mem::take(&mut self.target)
        };
        let observation = if self.image.is_null() {
            Value::Null
        } else {
            json!({"revision":self.session["observationRevision"],"image":self.image})
        };
        let receipt = if self.input.is_null() {
            self.method.map_or(Value::Null, |method| {
                let receipt_outcome = match outcome {
                    _ if code == Some("input-unknown") || (!self.finished && self.submitted) => {
                        "unknown"
                    }
                    "completed" => "dispatched",
                    other => other,
                };
                input::failed_receipt(method, &self.position, code, receipt_outcome)
            })
        } else {
            std::mem::take(&mut self.input)
        };
        let id = self.id.to_string();
        (context.publish)(json!({
            "id":Uuid::new_v4().to_string(),"type":"computerUse","status":status,
            "startedAtMs":self.started,"updatedAtMs":completed,"completedAtMs":completed,
            "source":"agent-mcp","operation":self.operation,"operationId":id,
            "requestId":context.request.to_string(),
            "binding":json!({
                "chatId":context.chat,"taskId":context.task,"workerId":context.worker,
                "threadId":context.thread,"turnId":context.turn,"sessionId":self.session["binding"]["sessionId"],
            }),
            "target":target,"cursor":self.session["cursor"],"input":receipt,"observation":observation,
            "outcome":outcome,"errorCode":code,"durationMs":duration,
            "correlation":json!({
                "sourceMethod":format!("computer-use/{}",self.operation),"diagnosticId":id,
                "threadId":context.thread,"turnId":context.turn,"itemId":context.item,
            }),
            "agentScope":context.scope,
            "raw":json!({
                "schemaVersion":1,"request":Value::Null,"response":Value::Null,"metadata":json!({
                    "source":"agent-mcp","operation":self.operation,"operationId":id,
                    "outcome":outcome,"errorCode":code.unwrap_or(""),"durationMs":duration.to_string(),
                }),
            }),
        }));
    }
}
