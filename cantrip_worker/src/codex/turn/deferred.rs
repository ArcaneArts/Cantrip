//! Persist the exact native no-consumption settlement before attempting delivery.
//! The files use the Node worker format so an upgrade can finish pending work.
use super::{Scope, receipt::Client};
use crate::{encryption::Service, http::checked, logging::Logs, metadata::Guard};
use anyhow::{Result, bail, ensure};
use cantrip_history::{
    content::Encryption,
    files::{ensure_directory, flush_directory, read_json, write_immutable},
};
use cantrip_wire::{JsString, Value, payload_digest, value::json};
use futures::{StreamExt, stream};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, Notify, OwnedMutexGuard, watch};

type Locks = Mutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>;

pub(super) struct Delivery {
    root: PathBuf,
    worker: JsString,
    locks: Locks,
    changed: Notify,
}

impl Delivery {
    pub(super) fn new(data: &Path, worker: JsString) -> Self {
        Self {
            root: data.join("native-deferred-settlements"),
            worker,
            locks: Locks::default(),
            changed: Notify::new(),
        }
    }

    pub(super) fn wake(&self) {
        self.changed.notify_one();
    }

    fn scope(&self, bound: &Scope) -> Result<Value> {
        bound.identity()?;
        Ok(json!({"serverId":bound.server,"ownerId":bound.owner,"workerId":self.worker}))
    }

    fn directory(&self, scope: &Value) -> PathBuf {
        self.root.join(digest(scope))
    }

    async fn lock(&self, pending: &Path) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.locks.lock().unwrap();
            locks.retain(|_, lock| lock.strong_count() != 0);
            if let Some(lock) = locks.get(pending).and_then(Weak::upgrade) {
                lock
            } else {
                let lock = Arc::new(AsyncMutex::new(()));
                locks.insert(pending.to_owned(), Arc::downgrade(&lock));
                lock
            }
        };
        lock.lock_owned().await
    }

    pub(super) async fn submit(
        &self,
        client: &Client,
        bound: &Scope,
        body: Value,
    ) -> Result<Option<Value>> {
        let scope = self.scope(bound)?;
        let record = Record::new(&scope, &body)?;
        let directory = self.directory(&scope);
        let pending = directory.join(record.filename());
        let _lock = self.lock(&pending).await;
        if let Some(result) = record.acknowledged(&pending)? {
            return Ok(Some(result));
        }
        ensure_directory(&directory)?;
        bound.identity()?;
        if !write_immutable(&pending, &record.value.stringify())? {
            let existing = Record::read(&pending, &scope)?;
            ensure!(
                existing.digest == record.digest,
                "Deferred settlement identity was reused with different content."
            );
        }
        match self.deliver(client, bound, &pending, &record).await {
            Ok(result) => Ok(Some(result)),
            Err(_) => {
                self.wake();
                Ok(None)
            }
        }
    }

    async fn deliver(
        &self,
        client: &Client,
        bound: &Scope,
        pending: &Path,
        record: &Record,
    ) -> Result<Value> {
        let result = match record.acknowledged(pending)? {
            Some(existing) => existing,
            None => {
                bound.identity()?;
                let guard = Guard::metadata_timeout(None, None, Duration::from_secs(15));
                let reply = client
                    .post("receipt", &record.value["settlement"], &guard)
                    .await?;
                bound.identity()?;
                record.correlate(&reply)?;
                let ack = json!({"digest":record.digest,"result":reply});
                if !write_immutable(&record.ack_path(pending), &ack.stringify())? {
                    record.acknowledged(pending)?.ok_or_else(|| {
                        anyhow::anyhow!("Missing deferred settlement acknowledgment.")
                    })?
                } else {
                    reply
                }
            }
        };
        match fs::remove_file(pending) {
            Ok(()) => flush_directory(&self.directory(&record.value["scope"]))?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(result)
    }

    pub(super) async fn run(
        &self,
        client: &Client,
        encryption: Arc<Service>,
        mut stop: watch::Receiver<bool>,
        logs: Arc<Logs>,
    ) {
        let mut retry = Duration::from_secs(1);
        while !*stop.borrow() {
            let delay = match Scope::new(encryption.clone()) {
                Ok(bound) => {
                    let flushed = tokio::select! {
                        _ = stop.changed() => break,
                        result = self.flush(client, &bound) => result,
                    };
                    if let Err(error) = flushed {
                        self.report(&logs, &error);
                        let delay = retry;
                        retry = (retry * 2).min(Duration::from_secs(30));
                        Some(delay)
                    } else {
                        retry = Duration::from_secs(1);
                        None
                    }
                }
                // Account binding can arrive after the control socket connects.
                Err(_) => Some(Duration::from_secs(10)),
            };
            tokio::select! {
                _ = stop.changed() => break,
                _ = self.changed.notified() => {},
                _ = async {
                    if let Some(delay) = delay { tokio::time::sleep(delay).await; }
                    else { std::future::pending::<()>().await; }
                } => {}
            }
        }
    }

    async fn flush(&self, client: &Client, bound: &Scope) -> Result<()> {
        let scope = self.scope(bound)?;
        let directory = self.directory(&scope);
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        let mut deliveries = stream::iter(entries.filter_map(|entry| match entry {
            Ok(entry) if pending_name(&entry.file_name().to_string_lossy()) => {
                Some(Ok(entry.path()))
            }
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        }))
        .map(|path| async {
            let path = path?;
            let _lock = self.lock(&path).await;
            let record = match Record::read(&path, &scope) {
                Ok(record) => record,
                Err(error) if missing(&error) => return Ok(()),
                Err(error) => return Err(error),
            };
            self.deliver(client, bound, &path, &record).await?;
            Ok::<_, anyhow::Error>(())
        })
        .buffer_unordered(8);
        let mut failure = None;
        while let Some(outcome) = deliveries.next().await {
            if let Err(error) = outcome {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    fn report(&self, logs: &Logs, error: &anyhow::Error) {
        logs.repeated(
            format!("native-deferred-settlement:{}", self.worker.lossy()),
            "warn",
            "Deferred native input receipt remains pending",
            json!({"event":"codex.input.deferred-settlement-pending","workerId":self.worker,"error":crate::logging::error(error)}),
        );
    }
}

struct Record {
    value: Value,
    digest: String,
}

impl Record {
    fn new(scope: &Value, settlement: &Value) -> Result<Self> {
        let body = checked("nativeCommandSettlementSchema", settlement)?;
        ensure!(
            body["workerId"] == scope["workerId"]
                && body["status"] == "rejected"
                && body["rejectionCode"] == "native-settings-pending"
                && body["executionComplete"] == true
                && body["executionStatus"] == "idle"
                && body["deferred"].is_object()
                && !body["protectedResult"].is_null()
                && !body["resultDigest"].is_null()
                && ["decline", "reconciliation", "terminalResult"]
                    .iter()
                    .all(|key| body[*key].is_null()),
            "Invalid retained native no-consumption settlement."
        );
        let value = json!({"scope":scope,"settlement":body});
        Ok(Self {
            digest: digest(&value),
            value,
        })
    }

    fn filename(&self) -> String {
        let body = &self.value["settlement"];
        format!(
            "{}.pending.json",
            payload_digest(&json!([&body["operationId"], &body["operationGeneration"]]))
        )
    }

    fn read(path: &Path, scope: &Value) -> Result<Self> {
        let raw = read_json(path)?;
        ensure!(
            raw["scope"] == *scope,
            "Deferred settlement record scope mismatch."
        );
        let record = Self::new(scope, &raw["settlement"])?;
        ensure!(
            record.value == raw
                && path.file_name().and_then(|name| name.to_str())
                    == Some(record.filename().as_str()),
            "Deferred settlement record identity mismatch."
        );
        Ok(record)
    }

    fn ack_path(&self, pending: &Path) -> PathBuf {
        pending.with_file_name(self.filename().replace(".pending.json", ".ack.json"))
    }

    fn acknowledged(&self, pending: &Path) -> Result<Option<Value>> {
        match read_json(&self.ack_path(pending)) {
            Ok(ack) => {
                ensure!(
                    ack["digest"] == self.digest,
                    "Deferred settlement acknowledgment digest mismatch."
                );
                let result = checked("nativeCommandSettlementResultSchema", &ack["result"])?;
                self.correlate(&result)?;
                Ok(Some(result))
            }
            Err(error) if missing(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn correlate(&self, result: &Value) -> Result<()> {
        let body = &self.value["settlement"];
        let receipt = &result["receipt"];
        if [
            "operationId",
            "operationGeneration",
            "status",
            "rejectionCode",
        ]
        .iter()
        .any(|key| receipt[*key] != body[*key])
            || receipt["method"] != "turn/start"
            || receipt["threadId"] != body["deferred"]["threadId"]
        {
            bail!("Deferred settlement acknowledgment identity mismatch.");
        }
        Ok(())
    }
}

fn digest(value: &Value) -> String {
    Sha256::digest(value.stringify().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn pending_name(name: &str) -> bool {
    name.strip_suffix(".pending.json").is_some_and(|stem| {
        stem.len() == 64
            && stem
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn missing(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<io::Error>()
        .is_some_and(|error| error.kind() == io::ErrorKind::NotFound)
}
