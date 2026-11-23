//! Durable source-to-outbox projection transactions. Callbacks own canonical
//! identity/encryption and authenticated delivery, never native input here.
mod inspect;
mod rebases;
use crate::{
    checked,
    content::{self, Encryption, Field},
    files::{self, Queue},
    outbox::{Outbox, baseline},
    parse,
    source::Journal,
    source_digest as hash,
};
use anyhow::{Result, bail};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    fs,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
};
use uuid::Uuid;

pub type Work<T> = Pin<Box<dyn Future<Output = Result<T>> + Send>>;
pub struct Projected {
    pub state: Value,
    pub batches: Vec<Value>,
}
pub type Project = Arc<dyn Fn(Vec<Value>, Value) -> Work<Projected> + Send + Sync>;
pub type Deliver = Arc<dyn Fn(Value, Value, JsString) -> Work<Value> + Send + Sync>;
/// The owning runtime's actual cancellation reason, equivalent to throwIfAborted.
pub type Check = Arc<dyn Fn() -> Result<()> + Send + Sync>;
pub struct Options {
    pub worker_id: JsString,
    pub chat_id: JsString,
    pub binding_id: JsString,
    pub service: Arc<dyn Encryption>,
    pub source: Journal,
    pub outbox: Outbox,
    pub project: Project,
    pub rebase: Option<Project>,
    pub deliver: Deliver,
    pub check: Option<Check>,
}
/// Only an authenticated, matched permanent rejection may instantiate this error.
/// An ordinary 409 or transport error does not select the rebase path.
#[derive(Debug)]
pub struct BatchRejected {
    rejection: Value,
}
impl BatchRejected {
    pub fn verified(raw: &Value, request: &Value, code: &Value) -> Result<Self> {
        Ok(Self {
            rejection: baseline::verify_rejection(raw, request, code)?,
        })
    }
    pub fn rejection(&self) -> &Value {
        &self.rejection
    }
}
impl std::fmt::Display for BatchRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Native history batch was durably rejected.")
    }
}
impl std::error::Error for BatchRejected {}

fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::object(fields)
}
fn empty_cursor() -> Value {
    json!({"sequence":0,"recordId":Value::Null})
}
fn sequence(value: &Value) -> u64 {
    value["sequence"]
        .as_u64()
        .expect("validated projection sequence")
}
fn filename(sequence: u64, kind: &str) -> String {
    format!("{sequence:016}.{kind}.json")
}
fn unsigned(record: &Value) -> Value {
    let mut value = record.clone();
    if let Value::Object(fields) = &mut value {
        fields.shift_remove("digest");
    }
    value
}
async fn blocking<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(operation).await?
}
async fn names(directory: PathBuf) -> Result<Vec<String>> {
    blocking(move || {
        fs::read_dir(directory)?
            .map(|entry| Ok(entry?.file_name().to_string_lossy().into_owned()))
            .collect()
    })
    .await
}
async fn read(schema: &'static str, path: PathBuf) -> Result<Value> {
    blocking(move || checked(schema, &files::read_json(&path)?)).await
}
async fn write(path: PathBuf, body: String) -> Result<bool> {
    blocking(move || files::write_immutable(&path, &body)).await
}
struct Inner {
    directory: PathBuf,
    manifest: Value,
    options: Options,
    queue: Arc<Queue>,
}
#[derive(Clone)]
pub struct Projection(Arc<Inner>);
#[derive(Clone)]
struct Rebase {
    header: Value,
    payload: Value,
}
struct Pending {
    stage: Value,
    payload: Value,
    rebases: Vec<Rebase>,
}
struct Current {
    cursor: Value,
    state: Value,
    previous: Option<Value>,
    pending: Option<Pending>,
}
impl Projection {
    pub async fn open(directory: PathBuf, options: Options) -> Result<Self> {
        let (owner, server) = options.service.identity()?;
        let manifest = checked(
            "nativeHistoryProjectionManifestSchema",
            &json!({"version":1,"ownerId":owner,"serverId":server,"workerId":options.worker_id,"chatId":options.chat_id,"bindingId":options.binding_id,"sourceId":options.source.journal_id(),"streamId":options.outbox.stream_id()}),
        )?;
        let source = options.source.scope();
        let outbox = options.outbox.scope();
        for key in ["ownerId", "serverId", "workerId", "chatId", "bindingId"] {
            if source[key] != manifest[key] || outbox[key] != manifest[key] {
                bail!(
                    "Native history source and outbox must belong to the projection's exact binding."
                );
            }
        }
        let key = hash(&json!([
            manifest["ownerId"].clone(),
            manifest["serverId"].clone(),
            manifest["workerId"].clone(),
            manifest["chatId"].clone(),
            manifest["bindingId"].clone()
        ]));
        let requested = directory.join(key);
        let directory = blocking(move || {
            cantrip_host::files::private_directory(&requested)?;
            Ok(fs::canonicalize(requested)?)
        })
        .await?;
        let queue = files::queue(&directory);
        queue
            .run_async(async move {
                let present = names(directory.clone()).await?;
                if !present.iter().any(|n| n == "projection.json") {
                    if present.iter().any(|n| {
                        [".stage.json", ".commit.json", ".rebase.json"]
                            .iter()
                            .any(|suffix| n.ends_with(suffix))
                    }) {
                        bail!("Native history projection lost its identity.");
                    }
                    write(directory.join("projection.json"), manifest.stringify()).await?;
                }
                let actual = read(
                    "nativeHistoryProjectionManifestSchema",
                    directory.join("projection.json"),
                )
                .await?;
                if hash(&actual) != hash(&manifest) {
                    bail!(
                        "Native history projection belongs to different source or outbox journals."
                    );
                }
                let queue = files::queue(&directory);
                let projection = Self(Arc::new(Inner {
                    directory,
                    manifest: actual,
                    options,
                    queue,
                }));
                projection.inspect().await?;
                projection.flush().await?;
                Ok(projection)
            })
            .await
    }
    pub fn directory(&self) -> &Path {
        &self.0.directory
    }
    fn check(&self) -> Result<()> {
        if let Some(check) = &self.0.options.check {
            check()?;
        }
        Ok(())
    }
    fn check_identity(&self, message: &str) -> Result<()> {
        let (owner, server) = self.0.options.service.identity()?;
        if self.0.manifest["ownerId"].as_js_string() != Some(&owner)
            || self.0.manifest["serverId"].as_js_string() != Some(&server)
        {
            bail!("{message}");
        }
        Ok(())
    }
    fn context(&self, header: &Value) -> Value {
        let mut context = self.0.manifest.clone();
        if let Value::Object(fields) = header {
            for (key, value) in fields {
                if let Value::Object(target) = &mut context {
                    target.insert(key.clone(), value.clone());
                }
            }
        }
        context
    }
    async fn flush(&self) -> Result<()> {
        let directory = self.0.directory.clone();
        blocking(move || files::flush_directory(&directory)).await
    }
    async fn open_stage(&self, stage: &Value) -> Result<Value> {
        let stage = stage.clone();
        let context = self.context(&stage);
        let service = self.0.options.service.clone();
        blocking(move || {
            if stage["digest"] != hash(&unsigned(&stage)) {
                bail!("Native history projection stage is corrupt.");
            }
            let body = content::open(
                service.as_ref(),
                &context,
                &stage["envelope"],
                Field::ProjectionState,
            )?;
            checked("nativeHistoryProjectionPayloadSchema", &parse(&body)?)
        })
        .await
    }
    async fn assert_cursor(&self, cursor: &Value) -> Result<()> {
        let next = sequence(cursor);
        if next == 0 {
            if !cursor["recordId"].is_null() {
                bail!("Invalid native history projection origin.");
            }
            return Ok(());
        }
        let page = self.0.options.source.read(next - 1, 1).await?;
        if page
            .first()
            .is_none_or(|r| sequence(r) != next || r["recordId"] != cursor["recordId"])
        {
            bail!("Native history projection cursor disagrees with its durable source.");
        }
        Ok(())
    }
    fn payload(from: &Value, through: &Value, result: Projected) -> Result<Value> {
        let batches = if result.batches.is_empty() {
            vec![json!({"items":Vec::<Value>::new(),"turns":Vec::<Value>::new()})]
        } else {
            result.batches
        };
        let batches = batches
            .into_iter()
            .map(|batch| {
                object([
                    ("recordId", json!(Uuid::new_v4().to_string())),
                    ("batch", batch),
                ])
            })
            .collect::<Vec<_>>();
        checked(
            "nativeHistoryProjectionPayloadSchema",
            &object([
                ("from", from.clone()),
                ("through", through.clone()),
                ("state", result.state),
                ("batches", Value::Array(batches)),
            ]),
        )
    }
    pub fn checkpoint(&self) -> impl Future<Output = Result<Value>> + Send + use<> {
        let this = self.clone();
        self.0.queue.run_async(async move {
            let current = this.inspect().await?;
            this.flush().await?;
            Ok(object([
                ("cursor", current.cursor),
                ("state", current.state),
            ]))
        })
    }
    async fn deliver_pending(&self, pending: &Pending, receipts: &mut Vec<Value>) -> Result<()> {
        for batch in pending.payload["batches"].as_array().unwrap() {
            self.check()?;
            let body: JsString = batch["batch"].stringify().into();
            let id = batch["recordId"].as_js_string().unwrap();
            let mut receipt = self
                .0
                .options
                .outbox
                .committed_receipt(id, Some(&body))
                .await?;
            if receipt.is_null() {
                let record = self.0.options.outbox.append(id, &body).await?;
                receipt = (self.0.options.deliver)(
                    json!({"chatId":self.0.manifest["chatId"],"bindingId":self.0.manifest["bindingId"]}),
                    record,
                    body,
                )
                .await?;
                self.check()?;
                self.0
                    .options
                    .outbox
                    .acknowledge_committed(&receipt)
                    .await?;
            }
            receipts.push(receipt);
        }
        Ok(())
    }
    /// Wake after recovery and source persistence; caller response lifetime does
    /// not cancel an accepted transaction. Only the explicit check signals stop.
    pub fn drain(&self) -> impl Future<Output = Result<()>> + Send + use<> {
        let this = self.clone();
        self.0.queue.run_async(async move {
            let mut current = this.inspect().await?;
            loop {
                this.check()?;
                let pending = if let Some(pending) = current.pending.take() {
                    pending
                } else {
                    let records = this.0.options.source.read(sequence(&current.cursor), 128).await?;
                    if records.is_empty() {
                        return Ok(());
                    }
                    let last = records.last().unwrap();
                    let through = object([
                        ("sequence", last["sequence"].clone()),
                        ("recordId", last["recordId"].clone()),
                    ]);
                    let result = (this.0.options.project)(records, current.state.clone()).await?;
                    this.check()?;
                    let payload = Self::payload(&current.cursor, &through, result)?;
                    let header = json!({"version":1,"sequence":current.previous.as_ref().map(sequence).unwrap_or(0)+1,"recordId":Uuid::new_v4().to_string(),"previousDigest":current.previous.as_ref().map(|v|v["digest"].clone()).unwrap_or(Value::Null)});
                    let context = this.context(&header);
                    let service = this.0.options.service.clone();
                    let body: JsString = payload.stringify().into();
                    let stage = blocking(move || {
                        let mut saved = header;
                        saved["envelope"] = content::protect(service.as_ref(), &context, &body, Field::ProjectionState)?;
                        saved["digest"] = json!(hash(&saved));
                        checked("nativeHistoryProjectionStageSchema", &saved)
                    }).await?;
                    if !write(this.directory().join(filename(sequence(&stage), "stage")), stage.stringify()).await? {
                        bail!("Native history projection advanced concurrently; recover its saved stage.");
                    }
                    Pending { stage, payload, rebases: Vec::new() }
                };
                this.flush().await?;
                this.resume_rebase(&pending).await?;
                let mut receipts = Vec::new();
                if let Err(error) = this.deliver_pending(&pending, &mut receipts).await {
                    if this.0.options.rebase.is_none() {
                        return Err(error);
                    }
                    let Some(rejected) = error.downcast_ref::<BatchRejected>() else {
                        return Err(error);
                    };
                    this.stage_rebase(&pending, &rejected.rejection, receipts).await?;
                    current = this.inspect().await?;
                    continue;
                }
                this.check()?;
                let mut commit = object([
                    ("sequence", pending.stage["sequence"].clone()),
                    ("digest", pending.stage["digest"].clone()),
                ]);
                if let Some(rebase) = pending.rebases.last() {
                    commit["rebaseDigest"] = rebase.header["digest"].clone();
                }
                commit["receipts"] = Value::Array(receipts);
                let commit = checked("nativeHistoryProjectionCommitSchema", &commit)?;
                let path = this.directory().join(filename(sequence(&commit), "commit"));
                if !write(path.clone(), commit.stringify()).await?
                    && hash(&read("nativeHistoryProjectionCommitSchema", path).await?) != hash(&commit)
                {
                    bail!("Native history projection has a conflicting commit.");
                }
                current = Current {
                    cursor: pending.payload["through"].clone(),
                    state: pending.payload["state"].clone(),
                    previous: Some(pending.stage),
                    pending: None,
                };
            }
        })
    }
}
