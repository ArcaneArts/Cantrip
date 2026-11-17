use crate::{
    checked,
    content::{self, Encryption, Field},
    files::{self, Queue},
    native, parse, source_digest,
};
use anyhow::{Result, bail};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::HashMap,
    fs,
    future::Future,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use uuid::Uuid;

#[derive(Default)]
struct Index {
    headers: Vec<Value>,
    by_source: HashMap<String, usize>,
}
struct Inner {
    directory: PathBuf,
    manifest: Value,
    service: Arc<dyn Encryption>,
    queue: Arc<Queue>,
    index: Mutex<Index>,
}
#[derive(Clone)]
pub struct Journal(Arc<Inner>);
pub struct Recovered {
    pub key: String,
    pub journal: Result<Journal>,
}
pub type Known = Arc<dyn Fn(&Value, &Value) -> bool + Send + Sync>;
pub fn scope(
    service: &dyn Encryption,
    worker: &JsString,
    chat: &JsString,
    binding: &JsString,
    thread: &JsString,
) -> Result<Value> {
    let (owner, server) = service.identity()?;
    checked(
        "nativeHistorySourceScopeSchema",
        &json!({"ownerId":owner,"serverId":server,"workerId":worker,"chatId":chat,"bindingId":binding,"threadId":thread}),
    )
}
fn filename(sequence: u64) -> String {
    format!("{sequence:016}.source.json")
}
fn source_key(frame: &Value) -> String {
    source_digest(&json!([
        frame["generation"].clone(),
        frame["kind"].clone(),
        if frame["kind"] == "notification" {
            frame["sequence"].clone()
        } else {
            frame["id"].clone()
        }
    ]))
}
fn header(record: &Value) -> Value {
    json!({"sequence":record["sequence"],"recordId":record["recordId"],"sourceKey":record["sourceKey"],"previousDigest":record["previousDigest"],"digest":record["digest"]})
}
impl Journal {
    pub async fn open(
        directory: PathBuf,
        scope: Value,
        service: Arc<dyn Encryption>,
    ) -> Result<Self> {
        let scope = checked("nativeHistorySourceScopeSchema", &scope)?;
        let requested = directory.join(source_digest(&scope));
        let directory = tokio::task::spawn_blocking(move || -> Result<PathBuf> {
            cantrip_host::files::private_directory(&requested)?;
            Ok(fs::canonicalize(requested)?)
        })
        .await??;
        let queue = files::queue(&directory);
        queue
            .run(move || {
                let names = fs::read_dir(&directory)?.collect::<std::io::Result<Vec<_>>>()?;
                if !names.iter().any(|v| v.file_name() == "source.json") {
                    if names
                        .iter()
                        .any(|v| v.file_name().to_string_lossy().ends_with(".source.json"))
                    {
                        bail!("Native history source journal lost its identity.");
                    }
                    files::write_immutable(
                        &directory.join("source.json"),
                        &json!({"version":1,"scope":scope,"journalId":Uuid::new_v4().to_string()})
                            .stringify(),
                    )?;
                }
                let manifest = checked(
                    "nativeHistorySourceManifestSchema",
                    &files::read_json(&directory.join("source.json"))?,
                )?;
                if source_digest(&manifest["scope"]) != source_digest(&scope) {
                    bail!("Native history source journal belongs to another scope.");
                }
                let journal = Self::from_manifest(directory, manifest, service);
                journal.refresh(&mut journal.0.index.lock().unwrap())?;
                files::flush_directory(journal.directory())?;
                Ok(journal)
            })
            .await
    }
    fn from_manifest(directory: PathBuf, manifest: Value, service: Arc<dyn Encryption>) -> Self {
        let queue = files::queue(&directory);
        Self(Arc::new(Inner {
            directory,
            manifest,
            service,
            queue,
            index: Mutex::new(Index::default()),
        }))
    }
    pub fn directory(&self) -> &Path {
        &self.0.directory
    }
    pub fn journal_id(&self) -> &Value {
        &self.0.manifest["journalId"]
    }
    pub fn scope(&self) -> Value {
        self.0.manifest["scope"].clone()
    }
    fn assert_scope(&self) -> Result<()> {
        let (owner, server) = self.0.service.identity()?;
        let scope = &self.0.manifest["scope"];
        if scope["ownerId"].as_js_string() != Some(&owner)
            || scope["serverId"].as_js_string() != Some(&server)
        {
            bail!("Native history source encryption identity changed.");
        }
        Ok(())
    }
    fn context(&self, header: &Value) -> Value {
        let mut context = self.scope();
        for (key, value) in [
            ("streamId", self.journal_id()),
            ("sequence", &header["sequence"]),
            ("recordId", &header["recordId"]),
            ("previousDigest", &header["previousDigest"]),
        ] {
            context[key] = value.clone();
        }
        context
    }
    fn record(&self, sequence: u64) -> Result<Value> {
        let saved = checked(
            "nativeHistorySourceRecordSchema",
            &files::read_json(&self.directory().join(filename(sequence)))?,
        )?;
        let mut unsigned = saved.clone();
        if let Value::Object(object) = &mut unsigned {
            object.shift_remove("digest");
        }
        if saved["sequence"].as_u64() != Some(sequence)
            || saved["digest"] != source_digest(&unsigned)
        {
            bail!("Native history source record is corrupt.");
        }
        Ok(saved)
    }
    fn refresh(&self, index: &mut Index) -> Result<()> {
        self.assert_scope()?;
        let mut sequences = Vec::new();
        for entry in fs::read_dir(self.directory())? {
            let name = entry?.file_name();
            let name = name.to_string_lossy();
            if !name.ends_with(".source.json") {
                continue;
            }
            let bytes = name.as_bytes();
            if bytes.len() != 28 || !bytes[..16].iter().all(u8::is_ascii_digit) {
                bail!("Invalid native history source record filename.");
            }
            let sequence = bytes[..16]
                .iter()
                .fold(0u64, |n, b| n * 10 + u64::from(*b - b'0'));
            checked("historySourcePositiveSchema", &json!(sequence))?;
            sequences.push(sequence);
        }
        sequences.sort_unstable();
        if sequences.len() < index.headers.len()
            || sequences
                .iter()
                .enumerate()
                .any(|(i, n)| *n != i as u64 + 1)
        {
            bail!("Native history source journal has missing records.");
        }
        for sequence in index.headers.len() as u64 + 1..=sequences.len() as u64 {
            let saved = self.record(sequence)?;
            let previous = index
                .headers
                .last()
                .map(|h| h["digest"].clone())
                .unwrap_or(Value::Null);
            let key = saved["sourceKey"].as_str().unwrap().to_owned();
            if saved["previousDigest"] != previous || index.by_source.contains_key(&key) {
                bail!("Native history source journal has conflicting records.");
            }
            index.by_source.insert(key, index.headers.len());
            index.headers.push(header(&saved));
        }
        Ok(())
    }
    /// Snapshot and validate *before* asynchronous IO. Accepted operations retain
    /// the exact frame even if the caller mutates input or abandons its response.
    pub fn append(&self, raw: &Value) -> impl Future<Output = Result<Value>> + Send + use<> {
        let frame = native::source(
            raw,
            self.0.manifest["scope"]["threadId"].as_js_string().unwrap(),
        );
        let this = self.clone();
        self.0.queue.run(move || {
            let frame=frame?; let body=frame.stringify(); let key=source_key(&frame);
            let mut index=this.0.index.lock().unwrap(); this.refresh(&mut index)?;
            if let Some(at)=index.by_source.get(&key) {
                let existing=&index.headers[*at];
                if this.open_record(existing)?.stringify()!=body { bail!("Native history source identity was reused with different content."); }
                files::flush_directory(this.directory())?;
                return Ok(existing.clone());
            }
            let previous=index.headers.last();
            let sequence=previous.and_then(|v|v["sequence"].as_u64()).unwrap_or(0)+1;
            checked("historySourcePositiveSchema", &json!(sequence))?;
            let h=json!({"sequence":sequence,"recordId":Uuid::new_v4().to_string(),"sourceKey":key,"previousDigest":previous.map(|v|v["digest"].clone()).unwrap_or(Value::Null)});
            let envelope=content::protect(this.0.service.as_ref(), &this.context(&h), &body.into(), Field::SourceRecord)?;
            let mut saved=json!({"version":1,"sequence":h["sequence"],"recordId":h["recordId"],"sourceKey":h["sourceKey"],"previousDigest":h["previousDigest"],"envelope":envelope});
            saved["digest"]=json!(source_digest(&saved));
            let saved=checked("nativeHistorySourceRecordSchema",&saved)?;
            if !files::write_immutable(&this.directory().join(filename(sequence)),&saved.stringify())? { bail!("Native history source advanced concurrently; retry the same frame."); }
            let result=header(&saved); let at=index.headers.len(); index.by_source.insert(key,at); index.headers.push(result.clone());
            Ok(result)
        })
    }
    fn open_record(&self, header: &Value) -> Result<Value> {
        self.assert_scope()?;
        let saved = self.record(header["sequence"].as_u64().unwrap())?;
        if saved["digest"] != header["digest"] {
            bail!("Native history source record changed after indexing.");
        }
        let body = content::open(
            self.0.service.as_ref(),
            &self.context(header),
            &saved["envelope"],
            Field::SourceRecord,
        )?;
        let frame = native::source(
            &parse(&body)?,
            self.0.manifest["scope"]["threadId"].as_js_string().unwrap(),
        )?;
        if source_key(&frame) != header["sourceKey"].as_str().unwrap() {
            bail!("Native history source record identity does not match its content.");
        }
        Ok(frame)
    }
    pub fn head(&self) -> impl Future<Output = Result<Value>> + Send + use<> {
        let this = self.clone();
        self.0.queue.run(move || {
            let mut index = this.0.index.lock().unwrap();
            this.refresh(&mut index)?;
            files::flush_directory(this.directory())?;
            Ok(index
                .headers
                .last()
                .map(|h| json!({"sequence":h["sequence"],"recordId":h["recordId"]}))
                .unwrap_or_else(|| json!({"sequence":0,"recordId":Value::Null})))
        })
    }
    pub fn read(
        &self,
        after: u64,
        limit: u64,
    ) -> impl Future<Output = Result<Vec<Value>>> + Send + use<> {
        let this = self.clone();
        self.0.queue.run(move || {
            checked("historySourceOrdinalSchema",&json!(after))?; checked("historySourcePageLimitSchema",&json!(limit))?;
            let mut index=this.0.index.lock().unwrap(); this.refresh(&mut index)?;
            if after>index.headers.len() as u64 { bail!("Native history source checkpoint is ahead of its journal."); }
            files::flush_directory(this.directory())?;
            index.headers.iter().skip(after as usize).take(limit as usize).map(|h| Ok(json!({"sequence":h["sequence"],"recordId":h["recordId"],"frame":this.open_record(h)?}))).collect()
        })
    }
    /// Discovery never creates missing profiles or replaces identities.
    pub async fn recover(
        directory: PathBuf,
        worker: JsString,
        service: Arc<dyn Encryption>,
        cancelled: Arc<AtomicBool>,
        known: Option<Known>,
    ) -> Result<Recovery> {
        check_cancelled(&cancelled)?;
        let entries = tokio::task::spawn_blocking(move || -> Result<Vec<fs::DirEntry>> {
            match fs::read_dir(directory) {
                Ok(entries) => Ok(entries.collect::<std::io::Result<Vec<_>>>()?),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
                Err(error) => Err(error.into()),
            }
        })
        .await??;
        Ok(Recovery {
            entries: entries.into_iter(),
            worker,
            service,
            cancelled,
            known,
        })
    }
}
/// Only one journal is loaded per next() call, matching source async discovery.
/// Dropping discovery does not touch a profile or attach a native runtime.
pub struct Recovery {
    entries: std::vec::IntoIter<fs::DirEntry>,
    worker: JsString,
    service: Arc<dyn Encryption>,
    cancelled: Arc<AtomicBool>,
    known: Option<Known>,
}
fn check_cancelled(token: &AtomicBool) -> Result<()> {
    if token.load(Ordering::Acquire) {
        bail!("Native history recovery was cancelled.");
    }
    Ok(())
}
impl Recovery {
    pub async fn next(&mut self) -> Result<Option<Recovered>> {
        loop {
            check_cancelled(&self.cancelled)?;
            let Some(entry) = self.entries.next() else {
                return Ok(None);
            };
            let name = entry.file_name();
            let Some(key) = name.to_str().filter(|s| {
                s.len() == 64
                    && s.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            }) else {
                continue;
            };
            let key = key.to_owned();
            let name_key = key.clone();
            let service = self.service.clone();
            let worker = self.worker.clone();
            let known = self.known.clone();
            let token = self.cancelled.clone();
            let prepare = tokio::task::spawn_blocking(move || -> Result<PathBuf> {
                if !entry.file_type()?.is_dir() {
                    bail!("Native history recovery found a non-directory journal.");
                }
                Ok(fs::canonicalize(entry.path())?)
            })
            .await?;
            let outcome =
                match prepare {
                    Err(error) => Err(error),
                    Ok(directory) => files::queue(&directory)
                        .run(move || {
                            check_cancelled(&token)?;
                            let manifest = checked(
                                "nativeHistorySourceManifestSchema",
                                &files::read_json(&directory.join("source.json"))?,
                            )?;
                            let scope = &manifest["scope"];
                            let (owner, server) = service.identity()?;
                            if scope["ownerId"].as_js_string() != Some(&owner)
                                || scope["serverId"].as_js_string() != Some(&server)
                                || scope["workerId"].as_js_string() != Some(&worker)
                            {
                                return Ok(None);
                            }
                            if source_digest(scope) != name_key {
                                bail!(
                                    "Native history recovery directory disagrees with its scope."
                                );
                            }
                            if known
                                .as_ref()
                                .is_some_and(|f| f(scope, &manifest["journalId"]))
                            {
                                return Ok(None);
                            }
                            let journal = Journal::from_manifest(directory, manifest, service);
                            journal.refresh(&mut journal.0.index.lock().unwrap())?;
                            check_cancelled(&token)?;
                            files::flush_directory(journal.directory())?;
                            Ok(Some(journal))
                        })
                        .await,
                };
            check_cancelled(&self.cancelled)?;
            match outcome {
                Ok(None) => continue,
                Ok(Some(journal)) => {
                    return Ok(Some(Recovered {
                        key,
                        journal: Ok(journal),
                    }));
                }
                Err(error) => {
                    return Ok(Some(Recovered {
                        key,
                        journal: Err(error),
                    }));
                }
            }
        }
    }
}
