//! Protected, worker-owned provider operations. The worker keeps only replay
//! metadata after the encrypted response has been delivered.
mod decision;
mod embedding;
mod http;
mod timing;
mod usage;

use crate::{
    codex::managed::Worker,
    encryption::Service,
    http::checked,
    inference::admission::{DirectRequest, Manager, Promise, Source},
    metadata::{Abort, Signal},
    protected_content::{open_endpoint_content, protect_endpoint_content},
    protected_secrets::open_runtime_provider,
};
use anyhow::{Context, Result, bail};
use cantrip_history::projection::Work;
use cantrip_wire::{JsString, Value, value::json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

pub(crate) const EMBEDDING: &str = "model.embedding";
pub(crate) const DECISION: &str = "model.decision";
pub(crate) const CANCEL: &str = "model.operation.cancel";
const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_RECORDS: usize = 10_000;
const CANCELLED: &str = "The model operation was cancelled.";
const MAX_SAFE_COUNT: u64 = 9_007_199_254_740_991;
type Emit = Arc<dyn Fn(Value) -> Result<()> + Send + Sync>;

#[derive(Clone, Debug)]
struct Failure {
    code: &'static str,
    message: String,
    status: Option<u16>,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for Failure {}

fn error(code: &'static str, message: impl Into<String>) -> anyhow::Error {
    Failure {
        code,
        message: message.into(),
        status: None,
    }
    .into()
}
fn count(value: &Value) -> Option<u64> {
    value.as_u64().filter(|count| *count <= MAX_SAFE_COUNT)
}
fn either<'a>(value: &'a Value, default: &'a Value) -> &'a Value {
    if value.is_null() { default } else { value }
}
fn object(value: &Value) -> cantrip_wire::value::Object {
    value.as_object().cloned().unwrap_or_default()
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Operation {
    Embedding,
    Decision,
}

impl Operation {
    fn name(self) -> &'static str {
        match self {
            Self::Embedding => "embedding",
            Self::Decision => "decision",
        }
    }

    fn input_schema(self) -> &'static str {
        match self {
            Self::Embedding => "embeddingInputSchema",
            Self::Decision => "decisionInputSchema",
        }
    }

    fn outcome_schema(self) -> &'static str {
        match self {
            Self::Embedding => "embeddingOutcomeSchema",
            Self::Decision => "decisionOutcomeSchema",
        }
    }

    fn malformed(self) -> anyhow::Error {
        error(
            "invalid-response",
            match self {
                Self::Embedding => "The provider returned malformed embedding data.",
                Self::Decision => "The provider returned malformed decision answers.",
            },
        )
    }
}

struct Request<'a> {
    route: &'a Value,
    provider: &'a Value,
    input: &'a Value,
    admission: Manager,
    http: &'a reqwest::Client,
    request_id: JsString,
    signal: &'a Signal,
    usage: Arc<Mutex<usage::Usage>>,
    clock: &'a Arc<timing::Timing>,
}

impl Request<'_> {
    fn configure(&self) -> Result<()> {
        self.admission.configure(json!({
            "providerId":self.provider["id"],
            "maxConcurrentInference":self.provider["maxConcurrentInference"],
            "inferenceConfigRevision":self.provider["inferenceConfigRevision"],
            "inferenceCatalogCreatedRevision":self.provider["inferenceCatalogCreatedRevision"],
        }))?;
        Ok(())
    }

    async fn run_direct<T: Clone + Send + Sync + 'static>(
        &self,
        attempt: usize,
        yield_after: bool,
        execute: impl FnOnce(Signal) -> Work<T> + Send + 'static,
    ) -> Result<T> {
        let provider_id = self.provider["id"].as_js_string().context("Provider ID")?;
        let source = Source::claimed(
            format!("worker-command:{}:inference:{attempt}", self.request_id).into(),
            Some(self.signal.clone()),
        );
        let mut direct = DirectRequest::new(source.clone(), provider_id.clone());
        direct.input.provider_creation_revision =
            self.provider["inferenceCatalogCreatedRevision"].as_f64();
        direct.input.signal = Some(self.signal.clone());
        direct.yield_after = yield_after;
        let clock = self.clock.clone();
        direct.input.observe = Some(Arc::new(move |phase| {
            clock.observe(phase);
            Ok(())
        }));
        let clock = self.clock.clone();
        direct.input.admitted = Some(Arc::new(move || {
            clock.admitted();
            Ok(())
        }));
        let result = self.admission.run_direct(direct, execute).await;
        source.close();
        result
    }
}

fn merged_options(route: &Value, input: &Value) -> Value {
    let mut options = object(&route["options"]);
    options.extend(object(&input["options"]));
    let mut parameters = object(&route["options"]["parameters"]);
    parameters.extend(object(&input["options"]["parameters"]));
    options.insert("parameters".into(), Value::Object(parameters));
    Value::Object(options)
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
    owner: JsString,
    server: JsString,
    operation: JsString,
}

struct Flight {
    signature: [u8; 32],
    abort: Abort,
    cancelled: bool,
    result: Promise<Value>,
}
#[derive(Clone, Copy)]
enum Ended {
    Completed,
    Cancelled,
}
enum Entry {
    Active(Flight),
    Ended(Ended),
}

pub(crate) struct Commands {
    encryption: Arc<Service>,
    worker: Worker,
    http: reqwest::Client,
    calls: Mutex<HashMap<Key, Entry>>,
}

impl Commands {
    pub(crate) fn new(encryption: Arc<Service>, worker: Worker) -> Result<Self> {
        Ok(Self {
            encryption,
            worker,
            http: http::client()?,
            calls: Mutex::default(),
        })
    }

    fn key(&self, command: &Value) -> Result<Key> {
        let (owner, server) = self.encryption.bound_identity()?;
        if command["serverId"] != server
            || command["scope"]["workerId"].as_js_string() != Some(self.encryption.worker_id())
        {
            bail!("The model operation targets another worker scope.");
        }
        Ok(Key {
            owner,
            server: server
                .as_js_string()
                .context("Verified inference server")?
                .clone(),
            operation: command["operationId"]
                .as_js_string()
                .context("Model operation identity")?
                .clone(),
        })
    }

    pub(crate) fn cancel(&self, command: &Value) -> Result<Value> {
        let key = self.key(command)?;
        let mut calls = self.calls.lock().unwrap();
        let has_room = calls.len() < MAX_RECORDS;
        let cancelled = match calls.get_mut(&key) {
            Some(Entry::Active(flight)) => {
                flight.cancelled = true;
                flight.abort.abort(error("cancelled", CANCELLED));
                true
            }
            Some(Entry::Ended(ended)) => matches!(ended, Ended::Cancelled),
            None if has_room => {
                calls.insert(key.clone(), Entry::Ended(Ended::Cancelled));
                true
            }
            None => false,
        };
        checked(
            "modelOperationCancelResultSchema",
            &json!({"operationId":key.operation,"cancelled":cancelled}),
        )
    }

    pub(crate) async fn execute(
        self: Arc<Self>,
        command: Value,
        request_id: JsString,
        collect_usage: bool,
        acknowledge_admission: bool,
        signal: Signal,
        emit: Emit,
    ) -> Result<Value> {
        let key = self.key(&command)?;
        let signature: [u8; 32] = Sha256::digest(command.stringify().as_bytes()).into();
        let pending = {
            let mut calls = self.calls.lock().unwrap();
            match calls.get(&key) {
                Some(Entry::Active(flight)) => {
                    if flight.signature != signature {
                        bail!("The model operation cannot change during redelivery.");
                    }
                    Ok(flight.result.clone())
                }
                Some(Entry::Ended(ended)) => Err(*ended),
                None => {
                    if calls.len() >= MAX_RECORDS {
                        bail!(
                            "The worker model-operation replay ledger is full. Reconnect with a new worker incarnation before submitting more operations."
                        );
                    }
                    let (abort, cancel) = Abort::new();
                    let signal = Signal::any(vec![signal.clone(), cancel]);
                    let this = self.clone();
                    let task_key = key.clone();
                    let input = command.clone();
                    let result = Promise::spawn(async move {
                        let clock = timing::Timing::new(
                            input["route"]["provider"]["id"].clone(),
                            acknowledge_admission,
                            emit,
                        );
                        let outcome = this
                            .perform(&task_key, &input, request_id, signal, &clock, None)
                            .await;
                        clock.finish();
                        let mut calls = this.calls.lock().unwrap();
                        let ended = match calls.get(&task_key) {
                            Some(Entry::Active(flight)) if flight.cancelled => Ended::Cancelled,
                            _ => Ended::Completed,
                        };
                        calls.insert(task_key, Entry::Ended(ended));
                        outcome
                    });
                    calls.insert(
                        key.clone(),
                        Entry::Active(Flight {
                            signature,
                            abort,
                            result: result.clone(),
                            cancelled: false,
                        }),
                    );
                    Ok(result)
                }
            }
        };
        let mut result = match pending {
            Ok(pending) => pending.work().await?,
            Err(ended) => {
                let clock = timing::Timing::new(Value::Null, false, emit_noop());
                self.perform(&key, &command, "".into(), signal, &clock, Some(ended))
                    .await?
            }
        };
        if !collect_usage && let Value::Object(fields) = &mut result {
            fields.shift_remove("usageReceipt");
        }
        Ok(result)
    }

    async fn perform(
        &self,
        key: &Key,
        command: &Value,
        request_id: JsString,
        signal: Signal,
        clock: &Arc<timing::Timing>,
        ended: Option<Ended>,
    ) -> Result<Value> {
        let operation = match command["type"].as_str() {
            Some(EMBEDDING) => Operation::Embedding,
            Some(DECISION) => Operation::Decision,
            _ => bail!("Unknown model operation command."),
        };
        let scope = &command["scope"];
        let context = |direction| {
            json!({
                "domain":"model-operation-content","serverId":key.server,
                "workerId":scope["workerId"],
                "scopeId":Value::Array(vec![
                    scope["workerId"].clone(),
                    scope["modelId"].clone(),
                    scope["routeId"].clone(),
                ]).stringify(),
                "operationId":key.operation,"operation":operation.name(),"direction":direction,"sequence":0,
            })
        };
        let route = &command["route"];
        let usage = Arc::new(Mutex::new(usage::Usage::default()));
        let result = async {
            match ended {
                Some(Ended::Cancelled) => return Err(error("cancelled", CANCELLED)),
                Some(Ended::Completed) => {
                    return Err(error(
                        "invalid-request",
                        "This model operation already completed and was not replayed.",
                    ));
                }
                None => {}
            }
            if ["modelId", "routeId"]
                .iter()
                .any(|field| !scope[*field].is_null() && scope[*field] != route[*field])
            {
                return Err(error(
                    "invalid-request",
                    "The selected model route does not match the protected request.",
                ));
            }
            let provider = open_runtime_provider(&self.encryption, &route["provider"])?;
            let input = open_endpoint_content(
                &self.encryption,
                &context("request"),
                &command["protectedRequest"],
                operation.input_schema(),
            )?;
            if self.key(command)? != *key {
                bail!("The worker binding changed during the model operation.");
            }
            let admission = self.worker.inference_manager(&key.owner, &key.server)?;
            let request = Request {
                route,
                provider: &provider,
                input: &input,
                admission,
                http: &self.http,
                request_id,
                signal: &signal,
                usage: usage.clone(),
                clock,
            };
            match operation {
                Operation::Embedding => embedding::run(request).await,
                Operation::Decision => decision::run(request).await,
            }
        }
        .await
        .and_then(|value| {
            checked(
                operation.outcome_schema(),
                &json!({"status":"succeeded","value":value}),
            )
        });
        let (outcome, status) = match result {
            Ok(outcome) => (outcome, "completed"),
            Err(cause) => {
                let cancelled = signal.check().is_err();
                let (code, message, http_status) = if let Some(failure) = cause
                    .chain()
                    .find_map(|error| error.downcast_ref::<Failure>())
                {
                    (failure.code, failure.message.as_str(), failure.status)
                } else if cancelled {
                    ("cancelled", CANCELLED, None)
                } else {
                    (
                        "invalid-request",
                        "The protected model operation could not be completed.",
                        None,
                    )
                };
                (
                    json!({"status":"failed","error":json!({"code":code,"message":message,"httpStatus":http_status})}),
                    if cancelled { "cancelled" } else { "failed" },
                )
            }
        };
        if self.key(command)? != *key {
            bail!("The worker binding changed during the model operation.");
        }
        let protected = protect_endpoint_content(
            &self.encryption,
            &context("response"),
            &outcome,
            operation.outcome_schema(),
        )?;
        let mut result = checked(
            "protectedEmbeddingResponseSchema",
            &json!({
                "operationId":key.operation,"scope":scope,"protectedResponse":protected,
            }),
        )?;
        if ended.is_none()
            && let Ok(receipt) = usage
                .lock()
                .unwrap()
                .receipt(operation.name(), route, status)
        {
            result["usageReceipt"] = receipt;
        }
        Ok(result)
    }
}
fn emit_noop() -> Emit {
    Arc::new(|_| Ok(()))
}
