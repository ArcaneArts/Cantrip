//! Chat outcomes follow the command response over the reconnecting socket.
//! Pending Task files use the existing commit protocol independently.
use crate::{config::Config, encryption::Service, http::checked, logging::Logs};
use anyhow::{Context, Result, bail};
use cantrip_history::files::{ensure_directory, flush_directory, read_json, write_immutable};
use cantrip_wire::{JsString, Value, parse_json_text, value::json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    ffi::OsStr,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    fs,
    io::AsyncReadExt,
    sync::{Notify, oneshot, watch},
};

pub(crate) fn chat(command: &Value, response: &Value) -> Result<Option<Value>> {
    if command["type"] != "chat.turn"
        || command.get("taskInferenceInput").is_some()
        || !matches!(
            command["resultMode"]["kind"].as_str(),
            Some("visible" | "chat-message-encrypted")
        )
    {
        return Ok(None);
    }
    let outcome = if response["ok"] == true {
        json!({"ok":true, "result":checked("agentTurnResultSchema", &response["result"])?})
    } else {
        json!({"ok":false, "error":response["error"]["message"]})
    };
    notification(command, outcome).map(Some)
}

fn notification(command: &Value, outcome: Value) -> Result<Value> {
    let mut note = json!({"type":"chat.turn.outcome"});
    for field in [
        "chatId",
        "clientMessageId",
        "executionLaneId",
        "contextKind",
        "worktreeId",
        "scratchRootId",
    ] {
        note[field] = command[field].clone();
    }
    let receipt = &command["nativeCommandReceipt"];
    if !receipt.is_null() {
        note["nativeLogicalRoot"] = json!({
            "operationId": receipt["operationId"],
            "operationGeneration": receipt["operationGeneration"],
        });
    }
    let task = &command["taskInferenceInput"];
    if !task.is_null() {
        note["taskInferenceInputOperationId"] = task["operationId"].clone();
        note["taskDispatchFence"] = task["dispatch"].clone();
    }
    note["outcome"] = outcome;
    checked("workerChatTurnOutcomeNotificationSchema", &note)
}

const MAX_RECORD_BYTES: u64 = 32 * 1024 * 1024;

pub(crate) struct TaskDelivery {
    config: Arc<Mutex<Config>>,
    encryption: Arc<Service>,
    directory: PathBuf,
    worker: JsString,
    http: reqwest::Client,
    wake: Notify,
    commits: Mutex<HashMap<String, oneshot::Sender<()>>>,
    stop: watch::Receiver<bool>,
    logs: Arc<Logs>,
}

#[derive(PartialEq)]
struct Scope {
    owner: JsString,
    server: JsString,
}

impl TaskDelivery {
    pub(crate) fn new(
        config: Arc<Mutex<Config>>,
        encryption: Arc<Service>,
        stop: watch::Receiver<bool>,
        logs: Arc<Logs>,
    ) -> Result<Self> {
        let (directory, worker) = {
            let config = config.lock().unwrap();
            (
                config.data_directory.join("task-goal-outcomes"),
                config.worker_id.clone(),
            )
        };
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(15))
            .build()?;
        Ok(Self {
            config,
            encryption,
            directory,
            worker,
            http,
            wake: Notify::new(),
            commits: Mutex::default(),
            stop,
            logs,
        })
    }

    fn scope(&self) -> Result<Scope> {
        let (owner, server) = self.encryption.bound_identity()?;
        let server = server
            .as_js_string()
            .context("Missing Task outcome server identity")?;
        Ok(Scope {
            owner,
            server: server.clone(),
        })
    }

    pub(crate) fn wake(&self) {
        self.wake.notify_one();
    }

    pub(crate) async fn task(
        &self,
        owner: &JsString,
        server: &JsString,
        command: &Value,
        result: &Result<Value>,
    ) -> Option<Value> {
        let append = async {
            let outcome = match result {
                Ok(result) => json!({"ok":true,"result":result}),
                Err(error) => json!({"ok":false,"error":error.to_string()}),
            };
            let note = notification(command, outcome)?;
            let scope = Scope { owner: owner.clone(), server: server.clone() };
            let delivery = uuid::Uuid::new_v4().to_string();
            let goal = command["taskInferenceInput"]["kind"] == "goal";
            let record = checked("taskGoalOutcomeDeliverySchema", &json!({
                "version": 1, "deliveryId": delivery, "inputKind": if goal { "goal" } else { "round" },
                "ownerId": owner, "serverId": server, "workerId": self.worker, "notification": note,
            }))?;
            if goal {
                self.append_and_commit(&scope, &delivery, record.stringify()).await?;
            } else {
                self.append(&scope, &delivery, record.stringify()).await?;
            }
            Ok::<_, anyhow::Error>(note)
        }.await;
        match append {
            Ok(note) => Some(note),
            Err(error) => {
                // Shutdown must not replace an already terminal model result.
                self.report("Task outcome persistence was interrupted", &error);
                None
            }
        }
    }

    async fn append_and_commit(&self, scope: &Scope, delivery: &str, body: String) -> Result<()> {
        let (committed, receipt) = oneshot::channel();
        self.commits
            .lock()
            .unwrap()
            .insert(delivery.to_owned(), committed);
        let mut stop = self.stop.clone();
        let result = async {
            self.append(scope, delivery, body).await?;
            if *stop.borrow() {
                bail!("Task outcome delivery stopped before commit acknowledgment.");
            }
            tokio::select! {
                result = receipt => result.context("Task outcome commit waiter was closed."),
                _ = stop.changed() => bail!("Task outcome delivery stopped before commit acknowledgment."),
            }
        }.await;
        self.commits.lock().unwrap().remove(delivery);
        result
    }

    async fn append(&self, scope: &Scope, delivery: &str, body: String) -> Result<()> {
        if body.len() as u64 > MAX_RECORD_BYTES {
            bail!("Task outcome file exceeds the delivery limit.");
        }
        let directory = self.directory(scope);
        let filename = directory.join(format!("{delivery}.json"));
        let mut stop = self.stop.clone();
        let mut backoff = Duration::from_secs(1);
        loop {
            // Finish any write already in progress even if shutdown arrives.
            let attempt = tokio::task::spawn_blocking({
                let directory = directory.clone();
                let filename = filename.clone();
                let body = body.clone();
                move || -> Result<()> {
                    ensure_directory(&directory)?;
                    if !write_immutable(&filename, &body)?
                        && read_json(&filename)?.stringify() != body
                    {
                        bail!("Task outcome delivery identity has another body.");
                    }
                    Ok(())
                }
            })
            .await?;
            match attempt {
                Ok(()) => {
                    self.wake();
                    return Ok(());
                }
                Err(error) => self.report("Task outcome remains unsaved", &error),
            }
            if *stop.borrow() {
                bail!("Task outcome delivery stopped before persistence.");
            }
            tokio::select! {
                _ = stop.changed() => bail!("Task outcome delivery stopped before persistence."),
                _ = tokio::time::sleep(backoff) => {}
            }
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    }

    pub(crate) async fn run(self: Arc<Self>) {
        let mut stop = self.stop.clone();
        let mut next = None;
        let mut backoff = Duration::from_secs(1);
        loop {
            tokio::select! {
                _ = stop.changed() => break,
                _ = self.wake.notified() => {},
                _ = async {
                    if let Some(at) = next {
                        tokio::time::sleep_until(at).await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                } => {},
            }
            if *stop.borrow() {
                break;
            }
            match self.drain(&mut stop).await {
                Ok(()) => {
                    next = None;
                    backoff = Duration::from_secs(1);
                }
                Err(error) => {
                    self.report("Task outcome durable delivery remains pending", &error);
                    next = Some(tokio::time::Instant::now() + backoff);
                    backoff = (backoff * 2).min(Duration::from_secs(30));
                }
            }
        }
    }

    fn report(&self, message: &str, error: &anyhow::Error) {
        self.logs.repeated(
            format!("task-outcome-delivery:{}:{message}", self.worker.lossy()),
            "warn",
            message,
            json!({"event":"task.outcome-delivery-pending","workerId":self.worker,"error":crate::logging::error(error)}),
        );
    }

    fn directory(&self, scope: &Scope) -> PathBuf {
        let key = Sha256::digest(
            json!([
                scope.server.clone(),
                scope.owner.clone(),
                self.worker.clone()
            ])
            .stringify()
            .as_bytes(),
        );
        let key: String = key.iter().map(|byte| format!("{byte:02x}")).collect();
        self.directory.join(key)
    }

    async fn drain(&self, stop: &mut watch::Receiver<bool>) -> Result<()> {
        // Use the existing scope even when there are no component key grants.
        let scope = self.scope()?;
        let directory = self.directory(&scope);
        let mut entries = match fs::read_dir(&directory).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        let mut failure = None;
        while !*stop.borrow() {
            let Some(entry) = entries.next_entry().await? else {
                break;
            };
            let path = entry.path();
            if path.extension() != Some(OsStr::new("json"))
                || !path
                    .file_stem()
                    .and_then(OsStr::to_str)
                    .is_some_and(|name| {
                        name.len() == 36
                            && name
                                .bytes()
                                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f' | b'-'))
                    })
                || !entry.file_type().await?.is_file()
            {
                continue;
            }
            let result = tokio::select! {
                _ = stop.changed() => return Ok(()),
                result = self.commit(&scope, &path) => result,
            };
            if let Err(error) = result {
                failure.get_or_insert(error);
                continue;
            }
            // A matching receipt owns this cleanup even during shutdown.
            let cleanup = async {
                fs::remove_file(&path).await?;
                let directory = directory.clone();
                tokio::task::spawn_blocking(move || flush_directory(&directory)).await?
            }
            .await;
            if let Err(error) = cleanup {
                failure.get_or_insert(error);
            }
            // The authoritative server receipt has committed even if local
            // unlink or directory sync failed. An uncleared file retries the
            // same durable delivery identity.
            let delivery = path.file_stem().and_then(OsStr::to_str).unwrap();
            if let Some(committed) = self.commits.lock().unwrap().remove(delivery) {
                let _ = committed.send(());
            }
        }
        failure.map_or(Ok(()), Err)
    }

    async fn commit(&self, scope: &Scope, filename: &Path) -> Result<()> {
        let mut bytes = Vec::new();
        fs::File::open(filename)
            .await?
            .take(MAX_RECORD_BYTES + 1)
            .read_to_end(&mut bytes)
            .await?;
        if bytes.len() as u64 > MAX_RECORD_BYTES {
            bail!("Task outcome file exceeds the delivery limit.");
        }
        let parsed = parse_json_text(&String::from_utf8_lossy(&bytes))
            .map_err(|_| anyhow::anyhow!("Invalid Task outcome JSON."))?;
        let record = checked("taskGoalOutcomeDeliverySchema", &parsed)?;
        let filename_id = filename
            .file_stem()
            .and_then(OsStr::to_str)
            .unwrap_or_default();
        if record["serverId"].as_js_string() != Some(&scope.server)
            || record["ownerId"].as_js_string() != Some(&scope.owner)
            || record["workerId"].as_js_string() != Some(&self.worker)
            || record["deliveryId"] != filename_id
            || &self.scope()? != scope
        {
            bail!("Task outcome file belongs to another scope or identity.");
        }
        let (url, token) = {
            let config = self.config.lock().unwrap();
            (
                url::Url::parse(&config.server_url)?
                    .join("/api/internal/native-commands/task-goal-outcome")?,
                config.token.clone(),
            )
        };
        let response = self
            .http
            .post(url)
            .bearer_auth(token)
            .header("content-type", "application/json")
            .body(record.stringify())
            .send()
            .await?
            .error_for_status()?;
        let receipt = parse_json_text(&String::from_utf8_lossy(&response.bytes().await?))
            .map_err(|_| anyhow::anyhow!("Invalid Task outcome receipt JSON."))?;
        let receipt = checked("taskGoalOutcomeCommitSchema", &receipt)?;
        if (receipt["committed"] != true && receipt["retiredReason"].is_null())
            || receipt["deliveryId"] != record["deliveryId"]
            || receipt["goalCycleSourceKey"] != record["goalCycleSource"]["sourceKey"]
            || receipt["taskInferenceInputOperationId"]
                != record["notification"]["taskInferenceInputOperationId"]
        {
            bail!("Task outcome has no matching canonical commit or retirement receipt.");
        }
        Ok(())
    }
}
