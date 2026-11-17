//! Durable opaque batch delivery. Only an authenticated canonical receipt is an
//! acknowledgment; a timeout or permanent rejection never consumes a record.
pub mod baseline;
mod ledger;
mod mutations;
use crate::{
    checked,
    content::{self, Encryption, Field},
    files::{self, Queue},
    parse, source_digest as hash,
};
use anyhow::{Result, bail};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
};
use uuid::Uuid;

pub type Recovery =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<Value>> + Send>> + Send + Sync>;
fn object<const N: usize>(fields: [(&str, Value); N]) -> Value {
    Value::object(fields)
}
fn unsigned(record: &Value) -> Value {
    let mut value = record.clone();
    if let Value::Object(fields) = &mut value {
        fields.shift_remove("digest");
    }
    value
}
fn sequence(value: &Value) -> u64 {
    value["sequence"]
        .as_u64()
        .expect("validated history sequence")
}
fn identifier(value: &Value) -> JsString {
    value["recordId"]
        .as_js_string()
        .expect("validated record identity")
        .clone()
}
fn filename(sequence: u64, kind: &str) -> String {
    format!("{sequence:016}.{kind}.json")
}
fn names(directory: &Path) -> Result<Vec<String>> {
    fs::read_dir(directory)?
        .map(|entry| Ok(entry?.file_name().to_string_lossy().into_owned()))
        .collect()
}
fn check_identity(service: &dyn Encryption, scope: &Value, message: &str) -> Result<()> {
    let (owner, server) = service.identity()?;
    if scope["ownerId"].as_js_string() != Some(&owner)
        || scope["serverId"].as_js_string() != Some(&server)
    {
        bail!("{message}");
    }
    Ok(())
}
pub fn scope(
    service: &dyn Encryption,
    worker: &JsString,
    chat: &JsString,
    binding: &JsString,
) -> Result<Value> {
    let (owner, server) = service.identity()?;
    checked(
        "nativeHistoryOutboxScopeSchema",
        &json!({"serverId":server,"ownerId":owner,"workerId":worker,"chatId":chat,"bindingId":binding}),
    )
}
struct Inner {
    directory: PathBuf,
    manifest: Value,
    service: Arc<dyn Encryption>,
    baseline: Vec<Value>,
    queue: Arc<Queue>,
}
#[derive(Clone)]
pub struct Outbox(Arc<Inner>);
impl Outbox {
    /// Recovery must be a complete authenticated server archive. It is called
    /// only for an absent stream with no committed local record files.
    pub async fn open(
        directory: PathBuf,
        scope: Value,
        service: Arc<dyn Encryption>,
        recover: Option<Recovery>,
    ) -> Result<Self> {
        let scope = checked("nativeHistoryOutboxScopeSchema", &scope)?;
        let requested = directory.join(hash(&scope));
        let directory = tokio::task::spawn_blocking(move || -> Result<PathBuf> {
            cantrip_host::files::private_directory(&requested)?;
            Ok(fs::canonicalize(requested)?)
        })
        .await??;
        let queue = files::queue(&directory);
        queue
            .run_async(async move {
                let at = directory.clone();
                let files = tokio::task::spawn_blocking(move || names(&at)).await??;
                if !files.iter().any(|name| name == "stream.json") {
                    if files.iter().any(|name| {
                        [".batch.json", ".ack.json", ".mutation.json"]
                            .iter()
                            .any(|suffix| name.ends_with(suffix))
                    }) {
                        bail!("Native history journal is missing its stream identity.");
                    }
                    let recovered = if let Some(recover) = recover {
                        baseline::prepare(&recover().await?, &scope)?
                    } else {
                        None
                    };
                    let directory = directory.clone();
                    let scope = scope.clone();
                    let service = service.clone();
                    tokio::task::spawn_blocking(move || -> Result<()> {
                        check_identity(
                            service.as_ref(),
                            &scope,
                            "Native history encryption identity changed during recovery.",
                        )?;
                        let stream = recovered
                            .as_ref()
                            .map(|v| v["streamId"].clone())
                            .unwrap_or_else(|| json!(Uuid::new_v4().to_string()));
                        let mut manifest = json!({"version":1,"scope":scope,"streamId":stream});
                        if let Some(recovered) = recovered {
                            let context = Self::baseline_context(&scope, &stream);
                            manifest["baseline"] = content::protect(
                                service.as_ref(),
                                &context,
                                &recovered["entries"].stringify().into(),
                                Field::OutboxBaseline,
                            )?;
                        }
                        check_identity(
                            service.as_ref(),
                            &scope,
                            "Native history encryption identity changed during recovery.",
                        )?;
                        files::write_immutable(
                            &directory.join("stream.json"),
                            &manifest.stringify(),
                        )?;
                        Ok(())
                    })
                    .await??;
                }
                tokio::task::spawn_blocking(move || -> Result<Self> {
                    let manifest = checked(
                        "nativeHistoryOutboxManifestSchema",
                        &files::read_json(&directory.join("stream.json"))?,
                    )?;
                    if hash(&manifest["scope"]) != hash(&scope) {
                        bail!("Native history journal belongs to a different scope.");
                    }
                    let baseline = if let Some(envelope) = manifest.get("baseline") {
                        let body = content::open(
                            service.as_ref(),
                            &Self::baseline_context(&scope, &manifest["streamId"]),
                            envelope,
                            Field::OutboxBaseline,
                        )?;
                        baseline::validate(&parse(&body)?, &manifest["streamId"])?
                    } else {
                        Vec::new()
                    };
                    check_identity(
                        service.as_ref(),
                        &scope,
                        "Native history encryption identity changed during recovery.",
                    )?;
                    let queue = files::queue(&directory);
                    let outbox = Self(Arc::new(Inner {
                        directory,
                        manifest,
                        service,
                        baseline,
                        queue,
                    }));
                    outbox.read_ledger()?;
                    files::flush_directory(outbox.directory())?;
                    Ok(outbox)
                })
                .await?
            })
            .await
    }
    fn baseline_context(scope: &Value, stream: &Value) -> Value {
        let mut context = scope.clone();
        for (key, value) in [
            ("streamId", stream.clone()),
            ("sequence", json!(0)),
            ("recordId", stream.clone()),
            ("previousDigest", Value::Null),
        ] {
            context[key] = value;
        }
        context
    }
    pub fn directory(&self) -> &Path {
        &self.0.directory
    }
    pub fn stream_id(&self) -> &Value {
        &self.0.manifest["streamId"]
    }
    pub fn scope(&self) -> Value {
        self.0.manifest["scope"].clone()
    }
    fn assert_scope(&self) -> Result<()> {
        check_identity(
            self.0.service.as_ref(),
            &self.0.manifest["scope"],
            "Native history encryption identity changed.",
        )
    }
    fn context(&self, record: &Value) -> Value {
        let mut value = self.scope();
        if let Some(fields) = record.as_object() {
            for (key, field) in fields {
                if let Value::Object(map) = &mut value {
                    map.insert(key.clone(), field.clone());
                }
            }
        }
        value
    }
    fn new_record(
        &self,
        sequence: u64,
        id: &JsString,
        previous: &Value,
        body: &JsString,
    ) -> Result<Value> {
        let mut saved = json!({"version":1,"streamId":self.stream_id(),"sequence":sequence,"recordId":id,"previousDigest":previous});
        saved["envelope"] = content::protect(
            self.0.service.as_ref(),
            &self.context(&saved),
            body,
            Field::PreparedBatch,
        )?;
        saved["digest"] = json!(hash(&saved));
        checked("nativeHistoryOutboxRecordSchema", &saved)
    }
    /// Retry the same ID and exact body after an uncertain write. Runtime/socket
    /// generations do not participate in durable batch identity.
    pub fn append(
        &self,
        id: &JsString,
        body: &JsString,
    ) -> impl Future<Output = Result<Value>> + Send + use<> {
        let (this, id, body) = (self.clone(), id.clone(), body.clone());
        self.0.queue.run(move||{
            this.assert_scope()?;
            cantrip_protocol::parse_property("nativeHistoryOutboxRecordSchema","recordId",&json!(id)).map_err(cantrip_protocol::response::response_error)?;
            let ledger=this.read_ledger()?;
            if this.0.baseline.iter().any(|v|v["receipt"]["recordId"].as_js_string()==Some(&id)){bail!("Native history record was restored as committed; retrieve its verified receipt instead of appending it.");}
            if let Some(existing)=ledger.records.iter().find(|v|v["recordId"].as_js_string()==Some(&id)) {
                if JsString::from(this.open_body(existing)?.as_str())!=body{bail!("Native history record identity was reused with different content.");}
                files::flush_directory(this.directory())?;return Ok(existing.clone());
            }
            if ledger.identities.contains(&id){bail!("Native history record was superseded; recover its replacement instead of appending it.");}
            let previous=ledger.records.last().or_else(||this.0.baseline.last().map(|v|&v["receipt"]));
            let next=previous.map(sequence).unwrap_or(0)+1;checked("nativeHistoryOutboxSequenceSchema",&json!(next))?;
            let saved=this.new_record(next,&id,&previous.map(|v|v["digest"].clone()).unwrap_or(Value::Null),&body)?;
            this.append_mutation(&ledger,&object([("kind",json!("append")),("record",saved.clone())]))?;
            this.assert_scope()?;Ok(saved)
        })
    }
    pub fn pending(&self) -> impl Future<Output = Result<Vec<Value>>> + Send + use<> {
        let this = self.clone();
        self.0.queue.run(move || {
            this.assert_scope()?;
            let ledger = this.read_ledger()?;
            files::flush_directory(this.directory())?;
            Ok(ledger
                .records
                .into_iter()
                .skip(ledger.receipts.len())
                .collect())
        })
    }
    pub fn open_body(&self, record: &Value) -> Result<cantrip_crypto::Zeroizing<String>> {
        self.assert_scope()?;
        let record = checked("nativeHistoryOutboxRecordSchema", record)?;
        if record["streamId"] != *self.stream_id() || record["digest"] != hash(&unsigned(&record)) {
            bail!("Native history record does not match its stream or digest.");
        }
        content::open(
            self.0.service.as_ref(),
            &self.context(&record),
            &record["envelope"],
            Field::PreparedBatch,
        )
    }
    fn correlate(&self, receipt: &Value, record: Option<&Value>) -> Result<()> {
        if record.is_none_or(|r| {
            receipt["streamId"] != *self.stream_id()
                || ["recordId", "digest", "sequence"]
                    .iter()
                    .any(|k| receipt[k] != r[k])
        }) {
            bail!("Native history acknowledgment does not match the durable batch.");
        }
        Ok(())
    }
    pub fn acknowledge_committed(
        &self,
        input: &Value,
    ) -> impl Future<Output = Result<()>> + Send + use<> {
        let (this, input) = (self.clone(), input.clone());
        self.0.queue.run(move || {
            this.assert_scope()?;
            let receipt = checked("nativeHistoryCommitReceiptSchema", &input)?;
            let ledger = this.read_ledger()?;
            if let Some(restored) = this.0.baseline.get(sequence(&receipt) as usize - 1) {
                if hash(&restored["receipt"]) != hash(&receipt) {
                    bail!("Native history recovered commit receipt changed.");
                }
                files::flush_directory(this.directory())?;
                return Ok(());
            }
            let index = (sequence(&receipt) as usize).checked_sub(this.0.baseline.len() + 1);
            this.correlate(&receipt, index.and_then(|i| ledger.records.get(i)))?;
            if let Some(existing) = index.and_then(|i| ledger.receipts.get(i)) {
                if hash(existing) != hash(&receipt) {
                    bail!("Native history commit receipt changed for an acknowledged batch.");
                }
                files::flush_directory(this.directory())?;
                return Ok(());
            }
            if sequence(&receipt) as usize != this.0.baseline.len() + ledger.receipts.len() + 1 {
                bail!("Native history acknowledgment would skip an uncommitted batch.");
            }
            let file = this.directory().join(filename(sequence(&receipt), "ack"));
            if !files::write_immutable(&file, &receipt.stringify())? {
                let stored = checked(
                    "nativeHistoryCommitReceiptSchema",
                    &files::read_json(&file)?,
                )?;
                if hash(&stored) != hash(&receipt) {
                    bail!("Native history acknowledgment conflicted with another writer.");
                }
            }
            Ok(())
        })
    }
    pub fn committed_receipt(
        &self,
        id: &JsString,
        expected: Option<&JsString>,
    ) -> impl Future<Output = Result<Value>> + Send + use<> {
        let (this, id, expected) = (self.clone(), id.clone(), expected.cloned());
        self.0.queue.run(move || {
            this.assert_scope()?;
            let ledger = this.read_ledger()?;
            if let Some(restored) = this
                .0
                .baseline
                .iter()
                .find(|v| v["receipt"]["recordId"].as_js_string() == Some(&id))
            {
                if let Some(expected) = expected {
                    baseline::verify_body(restored, &expected)?;
                }
                files::flush_directory(this.directory())?;
                return Ok(restored["receipt"].clone());
            }
            let index = ledger
                .records
                .iter()
                .position(|v| v["recordId"].as_js_string() == Some(&id));
            if let Some(receipt) = index.and_then(|i| ledger.receipts.get(i)) {
                if let Some(expected) = expected
                    && JsString::from(this.open_body(&ledger.records[index.unwrap()])?.as_str())
                        != expected
                {
                    bail!("Native history committed receipt belongs to different batch content.");
                }
                files::flush_directory(this.directory())?;
                return Ok(receipt.clone());
            }
            Ok(Value::Null)
        })
    }
    fn verify_rejection(&self, rejection: &Value, record: &Value) -> Result<Value> {
        let mut request = self.scope();
        for key in [
            "streamId",
            "sequence",
            "recordId",
            "digest",
            "previousDigest",
        ] {
            request[key] = record[key].clone();
        }
        // The ingest request has no owner/server fields.
        if let Value::Object(fields) = &mut request {
            fields.shift_remove("ownerId");
            fields.shift_remove("serverId");
        }
        request["batch"] = parse(&self.open_body(record)?)?;
        baseline::verify_rejection(rejection, &request, &rejection["code"])
    }
    pub fn replace_rejected(
        &self,
        input: &Value,
        id: &JsString,
        body: &JsString,
    ) -> impl Future<Output = Result<Vec<Value>>> + Send + use<> {
        let (this, input, id, body) = (self.clone(), input.clone(), id.clone(), body.clone());
        self.0.queue.run(move || {
            this.assert_scope()?;
            let rejection = checked("nativeHistoryBatchRejectionSchema", &input)?;
            cantrip_protocol::parse_property(
                "nativeHistoryOutboxRecordSchema",
                "recordId",
                &json!(id),
            )
            .map_err(cantrip_protocol::response::response_error)?;
            let ledger = this.read_ledger()?;
            if let Some(prior) = ledger.mutations.iter().find(|m| {
                m.payload["kind"] == "replace"
                    && m.payload["rejection"]["rejectionId"] == rejection["rejectionId"]
            }) {
                let records = prior.payload["records"].as_array().unwrap();
                if hash(&prior.payload["rejection"]) != hash(&rejection)
                    || records[0]["recordId"].as_js_string() != Some(&id)
                    || JsString::from(this.open_body(&records[0])?.as_str()) != body
                {
                    bail!("Native history replacement identity was reused with different content.");
                }
                files::flush_directory(this.directory())?;
                return Ok(records.clone());
            }
            let Some(original) = ledger.records.get(ledger.receipts.len()) else {
                bail!("Native history replacement has no uncommitted record.");
            };
            this.verify_rejection(&rejection, original)?;
            if ledger.identities.contains(&id) {
                bail!("Native history replacement must use a new record identity.");
            }
            let mut records = Vec::new();
            for (index, old) in ledger.records[ledger.receipts.len()..].iter().enumerate() {
                let record_id = if index == 0 {
                    id.clone()
                } else {
                    Uuid::new_v4().to_string().into()
                };
                let previous = records
                    .last()
                    .map(|v: &Value| v["digest"].clone())
                    .unwrap_or_else(|| original["previousDigest"].clone());
                let tail_body = if index == 0 {
                    body.clone()
                } else {
                    JsString::from(this.open_body(old)?.as_str())
                };
                records.push(this.new_record(sequence(old), &record_id, &previous, &tail_body)?);
            }
            this.assert_scope()?;
            this.append_mutation(
                &ledger,
                &object([
                    ("kind", json!("replace")),
                    ("rejection", rejection),
                    ("records", Value::Array(records.clone())),
                ]),
            )?;
            this.assert_scope()?;
            Ok(records)
        })
    }
    pub fn replacement(&self, id: &JsString) -> impl Future<Output = Result<Value>> + Send + use<> {
        let (this, id) = (self.clone(), id.clone());
        self.0.queue.run(move || {
            this.assert_scope()?;
            let result = this
                .read_ledger()?
                .superseded
                .get(&id)
                .cloned()
                .unwrap_or(Value::Null);
            files::flush_directory(this.directory())?;
            Ok(result)
        })
    }
}
