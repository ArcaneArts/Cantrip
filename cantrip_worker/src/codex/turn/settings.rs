//! Native settings application is a separate fact from the RPC acknowledgment.
//! Use the existing worker outbox so captured facts survive a worker upgrade.
mod account_defaults;
pub(super) mod permission;
pub(in crate::codex) mod snapshot;
mod update;
pub(crate) use account_defaults::COMMAND as ACCOUNT_DEFAULTS;
pub(super) use account_defaults::WRITE as WRITE_DEFAULTS;
pub(crate) use permission::COMMAND as PERMISSION_UPDATE;
pub(crate) use update::COMMAND;

use super::{
    RPC_TIMEOUT, Runtime, Scope, Turns, id,
    receipt::{Client, Receipt},
};
use crate::{
    codex::rpc_requests::{Failure, Response},
    encryption::Service,
    history::live::observation::{Observer, Runtime as _, Subscription},
    http::checked,
    logging::Logs,
};
use anyhow::{Context, Result, bail, ensure};
use cantrip_crypto::content::protect_native_settings_evidence;
use cantrip_history::{
    content::Encryption,
    files::{ensure_directory, flush_directory, read_json, write_immutable},
};
use cantrip_wire::{JsString, Value, payload_digest, value::json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};
use tokio::{
    sync::{Notify, mpsc, watch},
    task::JoinSet,
};

pub(in crate::codex) const UPDATE: &str = "thread/settings/update";

pub(super) fn assert_ordinary_settings(params: &Value) -> Result<()> {
    ensure!(
        !permission::has_update(params),
        "Changing native permissions requires the managed permission transition."
    );
    Ok(())
}

impl Turns {
    fn settings_activation(&self, scope: &Scope, chat: JsString) -> Value {
        let key = (scope.owner.clone(), scope.server.clone(), chat);
        self.active
            .lock()
            .unwrap()
            .active
            .get(&key)
            .and_then(|active| active.root.as_ref())
            .map_or(Value::Null, |root| root.activation.clone())
    }

    pub(super) async fn dispatch_settings(
        &self,
        runtime: &Runtime,
        receipt: &Receipt<'_>,
        params: Value,
        permission: Option<permission::Change>,
        assert_current: impl Fn() -> Result<()>,
    ) -> Result<(Value, &'static str)> {
        let observation = async {
            assert_current()?;
            receipt.dispatch().await?;
            assert_current()?;
            let scope = Scope::new(self.encryption.clone())?;
            ensure!(
                scope.owner == receipt.scope().owner && scope.server == receipt.scope().server,
                "The managed settings owner changed."
            );
            self.settings.observe(
                runtime,
                receipt,
                scope,
                params["operationId"]
                    .as_js_string()
                    .context("Missing native settings operation ID.")?,
                permission,
            )
        }
        .await;
        let observation = match observation {
            Ok(observation) => observation,
            Err(error) => {
                receipt
                    .rejected(
                        &json!({"code":-32000,"message":"Native settings were not dispatched."}),
                    )
                    .await?;
                return Err(error);
            }
        };
        let reply = runtime
            .request(UPDATE.into(), Some(params), Some(RPC_TIMEOUT), None)
            .await;
        observation.settle_with_status(receipt, reply).await
    }
}

pub(crate) struct Delivery {
    client: Client,
    encryption: Arc<Service>,
    worker: JsString,
    root: PathBuf,
    live: Mutex<HashSet<PathBuf>>,
    pending_writes: Mutex<Vec<Capture>>,
    observations: Mutex<JoinSet<Result<()>>>,
    sources: Mutex<HashMap<(PathBuf, JsString), Weak<snapshot::Source>>>,
    changed: Notify,
}

impl Delivery {
    pub(super) fn new(
        client: Client,
        encryption: Arc<Service>,
        worker: JsString,
        data: &Path,
    ) -> Self {
        Self {
            client,
            encryption,
            worker,
            root: data.join("native-settings-evidence"),
            live: Mutex::default(),
            pending_writes: Mutex::default(),
            observations: Mutex::default(),
            sources: Mutex::default(),
            changed: Notify::new(),
        }
    }

    pub(crate) fn wake(&self) {
        self.changed.notify_one();
    }

    fn directory(&self, bound: &Scope) -> PathBuf {
        self.root.join(payload_digest(&json!([
            json!(bound.server),
            json!(bound.owner),
            json!(self.worker)
        ])))
    }

    pub(super) fn observe(
        self: &Arc<Self>,
        runtime: &Runtime,
        receipt: &Receipt<'_>,
        bound: Scope,
        native_operation: &JsString,
        permission: Option<permission::Change>,
    ) -> Result<Observation> {
        let operation = receipt.operation();
        let session = receipt.session();
        let thread = id(&session["threadId"], "settings thread")?;
        let identity = json!({
            "chatId":session["chatId"],"operationId":operation.operation,
            "operationGeneration":operation.generation,"threadId":thread,
            "runtimeGeneration":session["runtimeGeneration"],"nativeOperationId":native_operation,
        });
        let (send, events) = mpsc::unbounded_channel();
        let subscription = runtime.history().observe(
            thread.clone(),
            Observer {
                capture: Arc::new({
                    let operation = native_operation.clone();
                    move |frame| {
                        if frame["params"]["threadId"].as_js_string() == Some(&thread)
                            && observation_kind(&frame, &operation).is_some()
                        {
                            let _ = send.send(frame);
                        }
                        Ok(None)
                    }
                }),
                on_error: Arc::new(|_, _| Ok(())),
            },
        )?;
        if subscription.generation()
            != session["runtimeGeneration"]
                .as_js_string()
                .cloned()
                .context("Missing settings runtime generation.")?
        {
            subscription.close();
            bail!("The settings observation belongs to a replaced native runtime.");
        }
        let directory = self.directory(&bound);
        let marker = directory.join(marker_name(&identity));
        if !self.live.lock().unwrap().insert(marker.clone()) {
            subscription.close();
            bail!("The native settings operation is already being observed.");
        }
        let registration = Registration {
            delivery: self.clone(),
            bound,
            identity,
            marker,
            directory,
            permission,
            reconcile: false,
        };
        let observation = Observation {
            subscription,
            events,
            registration,
        };
        observation.registration.track()?;
        Ok(observation)
    }

    pub(crate) async fn run(self: Arc<Self>, mut stop: watch::Receiver<bool>, logs: Arc<Logs>) {
        let mut retry = Duration::from_secs(1);
        while !*stop.borrow() {
            let result = self.flush().await;
            let delay = if let Err(error) = result {
                self.report(&logs, &error);
                let delay = retry;
                retry = (retry * 2).min(Duration::from_secs(30));
                Some(delay)
            } else {
                retry = Duration::from_secs(1);
                None
            };
            tokio::select! {
                _ = stop.changed() => break,
                _ = self.changed.notified() => {},
                _ = async {
                    if let Some(delay) = delay { tokio::time::sleep(delay).await; }
                    else { std::future::pending::<()>().await; }
                } => {},
            }
        }
    }

    pub(crate) async fn finish(&self, logs: &Logs) {
        let mut observers = std::mem::take(&mut *self.observations.lock().unwrap());
        while let Some(result) = observers.join_next().await {
            match result {
                Ok(Err(error)) => self.report(logs, &error),
                Err(error) => self.report(logs, &error.into()),
                Ok(Ok(())) => {}
            }
        }
        if let Err(error) = self.flush().await {
            self.report(logs, &error);
        }
    }

    fn report(&self, logs: &Logs, error: &anyhow::Error) {
        logs.repeated(
            format!("native-settings-evidence:{}", self.worker.lossy()), "warn",
            "Native settings evidence remains pending",
            json!({"event":"codex.settings.evidence-pending","workerId":self.worker,"error":crate::logging::error(error)}),
        );
    }

    async fn flush(&self) -> Result<()> {
        let Ok(bound) = Scope::new(self.encryption.clone()) else {
            return Ok(());
        };
        let directory = self.directory(&bound);
        let mut failure = None;
        self.pending_writes.lock().unwrap().retain(|capture| {
            if capture.directory != directory {
                return true;
            }
            match capture.persist() {
                Ok(()) => false,
                Err(error) => {
                    failure.get_or_insert(error);
                    true
                }
            }
        });
        let mut entries = match tokio::fs::read_dir(&directory).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return failure.map_or(Ok(()), Err);
            }
            Err(error) => return Err(error.into()),
        };
        let mut events = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let path = entry.path();
            if name.ends_with(".event.json") {
                events.push(path);
            } else if name.ends_with(".pending.json")
                && !self.live.lock().unwrap().contains(&path)
                && !self
                    .pending_writes
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|capture| capture.marker.as_ref() == Some(&path))
            {
                match recover_marker(&path, &self.worker) {
                    Ok(Some(event)) => events.push(event),
                    Ok(None) => {}
                    Err(error) => {
                        failure.get_or_insert(error);
                    }
                }
            }
        }
        events.sort_unstable();
        events.dedup();
        for path in events {
            bound.identity()?;
            let result = async {
                let event = checked("nativeSettingsEvidenceSchema", &read_json(&path)?)?;
                if event["workerId"].as_js_string() != Some(&self.worker)
                    || path.file_name().and_then(|name| name.to_str()) != Some(&event_file(&event))
                {
                    bail!("Native settings evidence filename or worker identity changed.");
                }
                let result = self.client.publish_settings(&event).await?;
                bound.identity()?;
                self.permission_published(&path, &event, &result)?;
                remove(&path)
            }
            .await;
            if let Err(error) = result {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }
}

struct Registration {
    delivery: Arc<Delivery>,
    bound: Scope,
    identity: Value,
    marker: PathBuf,
    directory: PathBuf,
    permission: Option<permission::Change>,
    reconcile: bool,
}

struct Capture {
    directory: PathBuf,
    event: Value,
    marker: Option<PathBuf>,
}

impl Capture {
    fn persist(&self) -> Result<()> {
        persist(&self.directory, &self.event)?;
        if let Some(marker) = &self.marker {
            remove(marker)?;
        }
        Ok(())
    }
}

impl Registration {
    fn recover_permission(&mut self) -> bool {
        self.reconcile = self.permission.is_some();
        self.reconcile
    }
    fn track(&self) -> Result<()> {
        let recovery = self.event(
            "transport-lost",
            &Value::Null,
            &json!({"reason":"worker-recovered-before-settings-result"}),
            None,
            None,
        )?;
        ensure_directory(&self.directory)?;
        let mut record = json!({"scope":self.identity,"recovery":recovery});
        if let Some(change) = &self.permission {
            record["permission"] =
                json!({"transition":change.transition,"source":change.source.permission_source()});
        }
        if !write_immutable(&self.marker, &record.stringify())? {
            let existing = read_json(&self.marker)?;
            if existing["scope"] != self.identity
                || existing.get("permission") != record.get("permission")
            {
                bail!("Native settings registration identity was reused.");
            }
        }
        Ok(())
    }

    fn event(
        &self,
        kind: &str,
        submission: &Value,
        content: &Value,
        claim: Option<&Value>,
        recovery_binding: Option<&Value>,
    ) -> Result<Value> {
        let grant = self.bound.material(None)?;
        let event_id = uuid::Uuid::new_v4().to_string();
        let mut plaintext =
            json!({"scope":self.identity,"kind":kind,"submissionId":submission,"content":content});
        if let Some(claim) = claim {
            plaintext["permissionPolicy"] = claim.clone();
        }
        if let Some(binding) = recovery_binding {
            plaintext["recoveryBindingId"] = binding.clone();
        }
        let (envelope, digest) = protect_native_settings_evidence(
            &grant.key,
            &json!({"ownerId":grant.owner_id,"serverId":grant.server_id,"keyRevision":grant.key_revision,
                "chatId":self.identity["chatId"],"operationId":self.identity["operationId"],"eventId":event_id}),
            &plaintext,
        )?;
        let mut event = json!({
            "workerId":self.delivery.worker,"operationId":self.identity["operationId"],
            "operationGeneration":self.identity["operationGeneration"],"eventId":event_id,
            "threadId":self.identity["threadId"],"runtimeGeneration":self.identity["runtimeGeneration"],
            "nativeOperationId":self.identity["nativeOperationId"],"kind":kind,"submissionId":submission,
            "resultDigest":digest,"protectedResult":envelope,
        });
        if let Some(claim) = claim {
            event["permissionPolicy"] = claim.clone();
        }
        if let Some(binding) = recovery_binding {
            event["recoveryBindingId"] = binding.clone();
        }
        checked("nativeSettingsEvidenceSchema", &event)
    }

    fn record(&self, kind: &str, submission: &Value, content: &Value) -> Result<()> {
        self.record_evidence(kind, submission, content, None, None)
    }

    fn record_evidence(
        &self,
        kind: &str,
        submission: &Value,
        content: &Value,
        claim: Option<&Value>,
        recovery_binding: Option<&Value>,
    ) -> Result<()> {
        let capture = Capture {
            event: self.event(kind, submission, content, claim, recovery_binding)?,
            directory: self.directory.clone(),
            marker: (kind != "queued" && self.permission.is_none()).then(|| self.marker.clone()),
        };
        if capture.persist().is_err() {
            self.delivery.pending_writes.lock().unwrap().push(capture);
        }
        self.delivery.wake();
        Ok(())
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.delivery.live.lock().unwrap().remove(&self.marker);
        if self.reconcile
            && let Some(change) = &self.permission
        {
            change.source.wake();
        }
        self.delivery.wake();
    }
}

pub(super) struct Observation {
    subscription: Subscription,
    events: mpsc::UnboundedReceiver<Value>,
    registration: Registration,
}
impl Observation {
    pub(super) async fn settle(
        self,
        receipt: &Receipt<'_>,
        reply: Result<Response>,
    ) -> Result<Value> {
        self.settle_with_status(receipt, reply)
            .await
            .map(|(result, _)| result)
    }

    async fn settle_with_status(
        mut self,
        receipt: &Receipt<'_>,
        reply: Result<Response>,
    ) -> Result<(Value, &'static str)> {
        match reply {
            Ok(Some(result)) => {
                let status = match self.accepted(&result) {
                    Ok(status) => status,
                    Err(error) => {
                        receipt.uncertain().await?;
                        return Err(error);
                    }
                };
                receipt.applied(&json!({"result":result}), None).await?;
                let status = *status.borrow();
                Ok((result, status))
            }
            Ok(None) => {
                self.registration.recover_permission();
                receipt.uncertain().await?;
                bail!("Codex did not return a native settings result.")
            }
            Err(error) => {
                if let Some(native) = error
                    .downcast_ref::<Failure>()
                    .and_then(|failure| failure.native_error.as_ref())
                {
                    let recorded = self.rejected(native);
                    receipt.rejected(native).await?;
                    recorded?;
                } else {
                    self.registration.recover_permission();
                    receipt.uncertain().await?;
                }
                Err(error)
            }
        }
    }

    fn accepted(mut self, result: &Value) -> Result<watch::Receiver<&'static str>> {
        let operation = &self.registration.identity["nativeOperationId"];
        let reply = json!({"result":result});
        if &result["operationId"] != operation
            || result["submissionId"]
                .as_js_string()
                .is_none_or(JsString::is_empty)
        {
            self.registration
                .record("correlation-conflict", &Value::Null, &reply)?;
            bail!("Codex acknowledged another native settings operation.");
        }
        let submission = result["submissionId"].clone();
        self.registration.record("queued", &submission, &reply)?;
        if let Ok(frame) = self.events.try_recv() {
            return Ok(watch::channel(self.record_application(&frame, &submission)?).1);
        }
        let delivery = self.registration.delivery.clone();
        let mut observations = delivery.observations.lock().unwrap();
        // Completed captures have already persisted their facts. Failed writes
        // retain the registration for the delivery pump.
        while observations.try_join_next().is_some() {}
        let (send, status) = watch::channel("queued");
        observations.spawn(async move {
            let observed = self.wait(submission).await;
            send.send_replace(observed.as_ref().copied().unwrap_or("uncertain"));
            observed.map(|_| ())
        });
        Ok(status)
    }

    fn rejected(self, error: &Value) -> Result<()> {
        self.registration
            .record("rejected", &Value::Null, &json!({"error":error}))
    }

    async fn wait(mut self, submission: Value) -> Result<&'static str> {
        let cancellation = self.subscription.signal();
        let frame = tokio::select! {
            biased;
            frame = self.events.recv() => frame,
            _ = cancellation.cancelled() => None,
            _ = tokio::time::sleep(RPC_TIMEOUT) => None,
        };
        let Some(frame) = frame else {
            if self.registration.recover_permission() {
                return Ok("uncertain");
            }
            self.registration.record(
                "transport-lost",
                &submission,
                &json!({"reason":"native-settings-application-unobserved"}),
            )?;
            return Ok("uncertain");
        };
        self.record_application(&frame, &submission)
    }

    fn record_application(&self, frame: &Value, submission: &Value) -> Result<&'static str> {
        let operation = id(
            &self.registration.identity["nativeOperationId"],
            "native settings operation",
        )?;
        let (kind, observed) =
            observation_kind(frame, &operation).context("Unrelated settings observation.")?;
        if observed != submission {
            self.registration
                .record("correlation-conflict", observed, &frame["params"])?;
            return Ok("uncertain");
        }
        if kind == "applied"
            && let Some(change) = &self.registration.permission
        {
            let params = &frame["params"];
            match permission::claim(
                &change.transition,
                &params["threadSettings"],
                &params["resolvedSecurity"],
            ) {
                Ok(claim) if claim["settingsVersion"]["epoch"] == change.epoch => {
                    self.registration.record_evidence(
                        kind,
                        observed,
                        params,
                        Some(&claim),
                        None,
                    )?;
                    return Ok(kind);
                }
                _ => {
                    self.registration
                        .record("correlation-conflict", observed, params)?;
                    return Ok("uncertain");
                }
            }
        }
        self.registration.record(kind, observed, &frame["params"])?;
        Ok(kind)
    }
}
impl Drop for Observation {
    fn drop(&mut self) {
        self.subscription.close();
    }
}

fn observation_kind<'a>(
    frame: &'a Value,
    operation: &JsString,
) -> Option<(&'static str, &'a Value)> {
    let params = &frame["params"];
    let (kind, submission) = match frame["method"].as_str()? {
        "thread/settings/updated"
            if params["operationId"].as_js_string() == Some(operation)
                && params["threadSettings"].is_object() =>
        {
            ("applied", &params["submissionId"])
        }
        "error"
            if params["willRetry"] == false
                && params["error"]["codexErrorInfo"]["threadSettingsUpdateFailed"]["operationId"]
                    .as_js_string() == Some(operation) =>
        {
            ("rejected", &params["turnId"])
        }
        _ => return None,
    };
    (!submission.as_js_string()?.is_empty()).then_some((kind, submission))
}

fn marker_name(scope: &Value) -> String {
    format!(
        "{}.pending.json",
        payload_digest(&json!([
            scope["operationId"].clone(),
            scope["operationGeneration"].clone()
        ]))
    )
}

fn event_file(event: &Value) -> String {
    format!("{}.event.json", event["eventId"].as_str().unwrap())
}

fn persist(directory: &Path, event: &Value) -> Result<PathBuf> {
    let path = directory.join(event_file(event));
    let contents = event.stringify();
    if !write_immutable(&path, &contents)? && read_json(&path)?.stringify() != contents {
        bail!("Native settings evidence event identity was reused.");
    }
    Ok(path)
}

fn recover_marker(path: &Path, worker: &JsString) -> Result<Option<PathBuf>> {
    let record = read_json(path)?;
    if record.get("permission").is_some() {
        // Permission recovery uses the native operation journal and its binding.
        return Ok(None);
    }
    let scope = &record["scope"];
    let recovery = checked("nativeSettingsEvidenceSchema", &record["recovery"])?;
    if path.file_name().and_then(|name| name.to_str()) != Some(&marker_name(scope))
        || recovery["workerId"].as_js_string() != Some(worker)
        || recovery["kind"] != "transport-lost"
        || [
            "operationId",
            "operationGeneration",
            "threadId",
            "runtimeGeneration",
            "nativeOperationId",
        ]
        .iter()
        .any(|key| recovery[*key] != scope[*key])
    {
        bail!("Native settings registration scope mismatch.");
    }
    let event = persist(
        path.parent()
            .context("Missing settings evidence directory.")?,
        &recovery,
    )?;
    remove(path)?;
    Ok(Some(event))
}

fn remove(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => flush_directory(
            path.parent()
                .context("Missing settings evidence directory.")?,
        ),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}
