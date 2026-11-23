//! Project Goal observations use the existing encrypted on-disk outbox.
use super::read::protect_chat_goal;
use crate::{
    chat_content::Scope, config::Config, encryption::Service, http::checked, logging::Logs,
};
use anyhow::{Context, Result, bail};
use cantrip_history::{
    content::Encryption,
    files::{ensure_directory, flush_directory, read_json},
};
use cantrip_wire::{JsString, Value, parse_json_text, payload_digest, value::json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Notify, watch};

#[derive(Clone, PartialEq, Eq, Hash)]
struct Thread {
    owner: JsString,
    server: JsString,
    id: JsString,
}

struct Watch {
    generation: String,
    chat: JsString,
    signature: Option<String>,
}

#[derive(Default)]
struct State {
    // A Task thread stays excluded even if it later uses a metadata-only RPC.
    watches: HashMap<Thread, Option<Watch>>,
    captured: HashMap<Thread, Vec<Fact>>,
}

struct Fact {
    chat: JsString,
    goal: Value,
}

pub(crate) struct Delivery {
    config: Arc<Mutex<Config>>,
    encryption: Arc<Service>,
    root: PathBuf,
    worker: JsString,
    generation: String,
    client: reqwest::Client,
    state: Mutex<State>,
    logs: Arc<Logs>,
    changed: Notify,
}

impl Delivery {
    pub(crate) fn new(
        config: Arc<Mutex<Config>>,
        encryption: Arc<Service>,
        generation: String,
        logs: Arc<Logs>,
    ) -> Result<Self> {
        let (root, worker) = {
            let config = config.lock().unwrap();
            (
                config.data_directory.join("goal-observations"),
                config.worker_id.clone(),
            )
        };
        Ok(Self {
            config,
            encryption,
            generation,
            root,
            worker,
            logs,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .timeout(Duration::from_secs(15))
                .build()?,
            state: Mutex::default(),
            changed: Notify::new(),
        })
    }

    pub(crate) fn wake(&self) {
        self.changed.notify_one();
    }

    pub(in crate::codex) fn select(
        &self,
        bound: &(JsString, Value),
        thread: &JsString,
        generation: &str,
        chat: &JsString,
        task: bool,
    ) {
        let Some(server) = bound.1.as_js_string() else {
            return;
        };
        let key = Thread {
            owner: bound.0.clone(),
            server: server.clone(),
            id: thread.clone(),
        };
        let mut state = self.state.lock().unwrap();
        if task {
            state.captured.remove(&key);
            state.watches.insert(key, None);
            return;
        }
        let watch = state.watches.entry(key).or_insert_with(|| {
            Some(Watch {
                generation: generation.to_owned(),
                chat: chat.clone(),
                signature: None,
            })
        });
        if let Some(watch) = watch {
            watch.generation = generation.to_owned();
            if &watch.chat != chat {
                watch.chat = chat.clone();
                watch.signature = None;
            }
        }
    }

    pub(in crate::codex) fn native(
        &self,
        server: &JsString,
        owner: &JsString,
        event: &crate::codex::session::Event,
    ) -> Result<()> {
        use crate::codex::session::EventKind;
        let EventKind::Message(message) = &event.kind else {
            return Ok(());
        };
        if message.get("id").is_some() {
            return Ok(());
        }
        let params = &message["params"];
        let goal = match message["method"].as_str() {
            Some("thread/goal/updated") => params
                .get("goal")
                .filter(|goal| goal.is_object())
                .context("Native Goal update has no Goal.")?,
            Some("thread/goal/cleared") => &Value::Null,
            _ => return Ok(()),
        };
        let thread = params["threadId"]
            .as_js_string()
            .context("Native Goal event thread")?;
        self.capture(server, owner, thread, &event.generation, goal)
    }

    pub(super) fn capture(
        &self,
        server: &JsString,
        owner: &JsString,
        thread: &JsString,
        generation: &str,
        goal: &Value,
    ) -> Result<()> {
        let key = Thread {
            owner: owner.clone(),
            server: server.clone(),
            id: thread.clone(),
        };
        let mut state = self.state.lock().unwrap();
        let Some(Some(watch)) = state.watches.get_mut(&key) else {
            return Ok(());
        };
        if watch.generation != generation {
            return Ok(());
        }
        let goal = super::verify_goal(thread, &json!({"goal":goal}))?;
        let signature = payload_digest(&goal);
        if watch.signature.as_ref() == Some(&signature) {
            return Ok(());
        }
        watch.signature = Some(signature);
        let chat = watch.chat.clone();
        state
            .captured
            .entry(key)
            .or_default()
            .push(Fact { chat, goal });
        drop(state);
        self.wake();
        Ok(())
    }

    fn directory(&self, scope: &Scope) -> PathBuf {
        self.root.join(payload_digest(&json!([
            &scope.server,
            &scope.owner,
            &self.worker
        ])))
    }

    pub(crate) async fn flush(self: &Arc<Self>) -> Result<()> {
        let this = self.clone();
        if this.state.lock().unwrap().captured.is_empty() {
            return Ok(());
        }
        tokio::task::spawn_blocking(move || {
            let scope = Scope::new(this.encryption.clone())?;
            this.persist(&scope)
        })
        .await?
    }

    fn persist(&self, scope: &Scope) -> Result<()> {
        let captured = {
            let mut state = self.state.lock().unwrap();
            let keys = state
                .captured
                .keys()
                .filter(|key| key.owner == scope.owner && key.server == scope.server)
                .cloned()
                .collect::<Vec<_>>();
            keys.into_iter()
                .filter_map(|key| state.captured.remove(&key).map(|facts| (key, facts)))
                .collect::<Vec<_>>()
        };
        let directory = self.directory(scope);
        let mut failure = None;
        for (thread, facts) in captured {
            let filename = directory.join(filename(&thread.id));
            let saved = (|| -> Result<()> {
                ensure_directory(&directory)?;
                let previous = record(&filename)?;
                let mut revision =
                    if previous["observation"]["generation"] == self.generation.as_str() {
                        previous["observation"]["revision"]
                            .as_u64()
                            .context("Goal observation revision")?
                    } else {
                        0
                    };
                let mut pending = previous["pending"].as_array().cloned().unwrap_or_default();
                for fact in &facts {
                    revision += 1;
                    pending.push(checked(
                        "projectGoalObservationSchema",
                        &json!({
                            "chatId":fact.chat, "workerId":self.worker, "threadId":thread.id,
                            "generation":self.generation, "revision":revision,
                            "snapshot":protect_chat_goal(scope, fact.goal.clone())?,
                        }),
                    )?);
                }
                scope.identity()?;
                save(
                    &filename,
                    &json!({
                        "formatVersion":1, "observation":pending.last(), "pending":pending, "delivered":false,
                    }),
                )
            })();
            if let Err(error) = saved {
                failure.get_or_insert(error);
                let mut state = self.state.lock().unwrap();
                if state.watches.get(&thread).is_some_and(Option::is_some) {
                    let later = state.captured.entry(thread).or_default();
                    later.splice(..0, facts);
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }

    pub(crate) async fn run(self: Arc<Self>, mut stop: watch::Receiver<bool>) {
        let mut backoff: Option<Duration> = None;
        while !*stop.borrow() {
            let report = self.drain(&mut stop).await;
            let delay = match report {
                Ok(()) => {
                    backoff = None;
                    None
                }
                Err(error) => {
                    self.report(&error);
                    let delay = backoff.map_or(Duration::from_secs(2), |delay| {
                        (delay * 2).min(Duration::from_secs(30))
                    });
                    backoff = Some(delay);
                    Some(delay)
                }
            };
            if *stop.borrow() {
                break;
            }
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

    pub(crate) fn report(&self, error: &anyhow::Error) {
        self.logs.repeated(
            format!("goal-observation-delivery:{}", self.worker.lossy()),
            "warn",
            "Project Goal observation remains pending",
            json!({"event":"codex.goal.delivery-pending","workerId":self.worker,"error":crate::logging::error(error)}),
        );
    }

    async fn drain(self: &Arc<Self>, stop: &mut watch::Receiver<bool>) -> Result<()> {
        let scope = Scope::new(self.encryption.clone())?;
        let mut failure = self.flush().await.err();
        let directory = self.directory(&scope);
        let mut entries = match tokio::fs::read_dir(&directory).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return failure.map_or(Ok(()), Err);
            }
            Err(error) => return Err(error.into()),
        };
        while !*stop.borrow() {
            let Some(entry) = entries.next_entry().await? else {
                break;
            };
            let path = entry.path();
            if !path
                .file_stem()
                .and_then(|name| name.to_str())
                .is_some_and(is_digest)
                || path.extension().is_none_or(|extension| extension != "json")
                || !entry.file_type().await?.is_file()
            {
                continue;
            }
            if let Err(error) = self.deliver(&scope, path, stop).await {
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    async fn deliver(
        &self,
        scope: &Scope,
        path: PathBuf,
        stop: &mut watch::Receiver<bool>,
    ) -> Result<()> {
        let mut saved = tokio::task::spawn_blocking({
            let path = path.clone();
            move || record(&path)
        })
        .await??;
        while !*stop.borrow() {
            let Some(fact) = saved["pending"]
                .as_array()
                .and_then(|pending| pending.first())
            else {
                return Ok(());
            };
            let thread = fact["threadId"]
                .as_js_string()
                .context("Goal observation thread")?;
            if path
                .file_name()
                .is_none_or(|name| name != filename(thread).as_str())
                || fact["workerId"].as_js_string() != Some(&self.worker)
            {
                bail!("A retained Goal observation belongs to a different source.");
            }
            let result = tokio::select! {
                _ = stop.changed() => return Ok(()),
                result = self.send(scope, fact) => result?,
            };
            if result["accepted"] != true
                && (result["reason"] == "unbound-thread"
                    || (result["reason"] == "retired-worker"
                        && fact["generation"] == self.generation.as_str()))
            {
                bail!("The Project Goal source is not registered yet.");
            }
            let Value::Array(pending) = &mut saved["pending"] else {
                unreachable!()
            };
            pending.remove(0);
            saved["delivered"] = json!(pending.is_empty());
            tokio::task::spawn_blocking({
                let (path, saved) = (path.clone(), saved.clone());
                move || save(&path, &saved)
            })
            .await??;
        }
        Ok(())
    }

    async fn send(&self, scope: &Scope, fact: &Value) -> Result<Value> {
        scope.identity()?;
        let (url, token) = {
            let config = self.config.lock().unwrap();
            (
                url::Url::parse(&config.server_url)?.join("/api/internal/project-alerts/goals")?,
                config.token.clone(),
            )
        };
        let response = self
            .client
            .post(url)
            .bearer_auth(token)
            .header("content-type", "application/json")
            .body(fact.stringify())
            .send()
            .await?;
        if !response.status().is_success() {
            bail!(
                "Project Goal delivery returned HTTP {}.",
                response.status().as_u16()
            );
        }
        let raw = response.text().await?;
        scope.identity()?;
        checked(
            "projectGoalObservationResultSchema",
            &parse_json_text(&raw)
                .map_err(|_| anyhow::anyhow!("Invalid Project Goal receipt JSON."))?,
        )
    }
}

fn filename(thread: &JsString) -> String {
    let digest: String = Sha256::digest(thread.lossy().as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{digest}.json")
}

fn is_digest(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn record(path: &Path) -> Result<Value> {
    let value = match read_json(path) {
        Ok(value) => value,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == ErrorKind::NotFound) =>
        {
            return Ok(Value::Null);
        }
        Err(error) => return Err(error),
    };
    if value.as_object().is_none_or(|fields| fields.len() != 4) || value["formatVersion"] != 1 {
        bail!("Invalid Project Goal observation record.");
    }
    let pending = value["pending"]
        .as_array()
        .context("Project Goal observation queue")?;
    if value["delivered"] != pending.is_empty() {
        bail!("Invalid Project Goal observation delivery state.");
    }
    checked("projectGoalObservationSchema", &value["observation"])?;
    for fact in pending {
        checked("projectGoalObservationSchema", fact)?;
    }
    Ok(value)
}

fn save(path: &Path, value: &Value) -> Result<()> {
    let directory = path.parent().context("Project Goal outbox directory")?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(value.stringify().as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary.persist(path)?;
    flush_directory(directory)?;
    Ok(())
}
