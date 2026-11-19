//! Publish the settings of the already selected native thread. A refresh is
//! an actual read through Core; notifications never acquire execution authority.
use crate::{
    chat_content::Scope,
    codex::{
        managed::{Runtime, WeakRuntime},
        preparation::native::LoadedThread,
        turn::{
            Turns, id,
            receipt::{Client, MetadataHttpError},
        },
    },
    encryption::Service,
    history::live::observation::{Observer, Runtime as _},
    http::checked,
    logging::Logs,
    metadata::{Abort, Guard, Signal},
};
use anyhow::{Context, Result, anyhow, bail, ensure};
use cantrip_crypto::content::protect_native_settings_snapshot;
use cantrip_history::content::Encryption;
use cantrip_wire::{JsString, Value, value::json};
use std::{sync::Arc, time::Duration};
use tokio::sync::watch;

pub(crate) const READ: &str = "chat.settings.read";

#[derive(Clone)]
pub(in crate::codex) struct Factory {
    client: Client,
    encryption: Arc<Service>,
    logs: Arc<Logs>,
}

impl Turns {
    pub(crate) fn configure_settings_publisher(&self, logs: Arc<Logs>) -> Result<()> {
        self.preparation.configure_settings_publisher(Factory {
            client: self.receipts.clone(),
            encryption: self.encryption.clone(),
            logs,
        })
    }
}

pub(in crate::codex) struct Publisher {
    pub source: Arc<Source>,
    refresh: watch::Sender<()>,
    stop: Abort,
}

impl Drop for Publisher {
    fn drop(&mut self) {
        self.stop
            .abort(anyhow!("The managed settings source retired."));
    }
}

impl Publisher {
    pub fn wake(&self) {
        self.refresh.send_replace(());
    }
}

pub(in crate::codex) struct Source {
    scope: Value,
    bound: (JsString, Value),
    native: LoadedThread,
    runtime: WeakRuntime,
    generation: String,
    model_name: Value,
    attribution: Value,
    signal: Signal,
    encryption: Arc<Service>,
}

impl Source {
    fn runtime(&self) -> Result<Runtime> {
        self.signal.check()?;
        let runtime = self
            .runtime
            .upgrade()
            .context("The managed settings runtime closed.")?;
        self.native.assert_current(&runtime)?;
        Ok(runtime)
    }

    fn binding_matches(&self, binding: &Value) -> bool {
        binding["runtimeGeneration"] == self.generation
            && self.scope.as_object().unwrap().iter().all(|(key, value)| {
                binding.as_object().and_then(|fields| fields.get(key)) == Some(value)
            })
    }

    pub fn matches_read(&self, requested: &Value) -> bool {
        self.scope.as_object().unwrap().iter().all(|(key, value)| {
            key.as_str() == Some("modelRouteId")
                || requested.as_object().and_then(|fields| fields.get(key)) == Some(value)
        })
    }

    pub async fn read(&self, signal: Signal) -> Result<Value> {
        let runtime = self.runtime()?;
        let scope = self.encryption_scope()?;
        let guard = Guard::metadata(Some(signal), Some(self.signal.clone()));
        let reply = guard
            .run(runtime.request(
                "thread/settings/read".into(),
                Some(json!({"threadId":self.native.id()})),
                Some(Duration::from_secs(30)),
                None,
            ))
            .await?
            .context("Codex did not return native settings.")?;
        ensure!(
            reply["threadId"].as_js_string() == Some(self.native.id()),
            "Codex returned another thread's settings."
        );
        guard.check()?;
        self.runtime()?;
        self.seal(&scope, &reply["threadSettings"])
    }

    fn encryption_scope(&self) -> Result<Scope> {
        let scope = Scope::new(self.encryption.clone())?;
        ensure!(
            scope.owner == self.bound.0 && self.bound.1.as_js_string() == Some(&scope.server),
            "The managed settings source's account changed."
        );
        Ok(scope)
    }

    fn seal(&self, scope: &Scope, settings: &Value) -> Result<Value> {
        let grant = scope.material(None)?;
        let selection = if settings["model"] == self.model_name {
            self.attribution.clone()
        } else {
            json!({"status":"unavailable"})
        };
        let snapshot = protect_native_settings_snapshot(
            &grant.key,
            &json!({"ownerId":grant.owner_id,"serverId":grant.server_id,"keyRevision":grant.key_revision}),
            &json!({
                "chatId":self.scope["chatId"],"workerId":self.scope["workerId"],
                "threadId":self.native.id(),"runtimeGeneration":self.generation,
                "settingsVersion":settings["settingsVersion"],
            }),
            settings,
            &selection,
        )?;
        self.runtime()?;
        scope.identity()?;
        Ok(snapshot)
    }
}

impl Factory {
    pub(in crate::codex) fn bind(
        &self,
        worker: &JsString,
        prepared: &crate::codex::preparation::command::Prepared,
        session: &Value,
        command: &Value,
        previous: Option<&Arc<Publisher>>,
    ) -> Result<Arc<Publisher>> {
        let scope = checked(
            "nativeSettingsReadScopeSchema",
            &json!({
                "chatId":session["chatId"],"workerId":worker,"threadId":session["threadId"],
                "contextKind":session["contextKind"],"projectId":session["projectId"],
                "placementId":session["placementId"],"modelRouteId":session["modelRouteId"],
                "providerAccountId":session["providerAccountId"],
            }),
        )?;
        let model = &command["model"];
        let attribution = checked("nativeModelAttributionSchema", &json!({
            "status":"resolved","workerId":worker,"providerId":command["provider"]["id"],
            "providerAccountId":scope["providerAccountId"],"modelId":model["id"],"routeId":model["routeId"],
        })).unwrap_or_else(|_| json!({"status":"unavailable"}));
        if let Some(previous) = previous
            && previous.source.scope == scope
            && previous.source.bound == prepared.bound
            && previous.source.native == prepared.thread
            && previous.source.model_name == model["name"]
            && previous.source.attribution == attribution
        {
            return Ok(previous.clone());
        }
        let (stop, signal) = Abort::new();
        let source = Arc::new(Source {
            scope,
            bound: prepared.bound.clone(),
            native: prepared.thread.clone(),
            runtime: prepared.runtime.downgrade(),
            generation: prepared.runtime.generation().into(),
            model_name: model["name"].clone(),
            attribution,
            signal,
            encryption: self.encryption.clone(),
        });

        let (send, updates) = watch::channel(None::<Value>);
        let subscription = prepared.runtime.history().observe(
            prepared.thread.id().clone(),
            Observer {
                capture: Arc::new(move |frame| {
                    match frame["method"].as_str() {
                        Some("thread/settings/updated") => {
                            let settings = &frame["params"]["threadSettings"];
                            if version(&settings["settingsVersion"]).is_some() {
                                send.send_if_modified(|last| {
                                    if last.as_ref().is_some_and(|last| {
                                        version(&last["settingsVersion"])
                                            .zip(version(&settings["settingsVersion"]))
                                            .is_some_and(|(old, new)| {
                                                old.0 == new.0 && old.1 > new.1
                                            })
                                    }) {
                                        return false;
                                    }
                                    *last = Some(settings.clone());
                                    true
                                });
                            } else {
                                send.send_replace(None);
                            }
                        }
                        Some("thread/closed") => {
                            send.send_replace(None);
                        }
                        _ => {}
                    }
                    Ok(None)
                }),
                on_error: Arc::new(|_, _| Ok(())),
            },
        )?;
        let (refresh, wakes) = watch::channel(());
        let publication = Publication {
            source: source.clone(),
            client: self.client.clone(),
            logs: self.logs.clone(),
            transport: subscription.signal(),
            updates,
            wakes,
            binding: None,
            pending: None,
            published: Value::Null,
        };
        tokio::spawn(async move {
            publication.run().await;
            subscription.close();
        });
        Ok(Arc::new(Publisher {
            source,
            refresh,
            stop,
        }))
    }
}

struct Publication {
    source: Arc<Source>,
    client: Client,
    logs: Arc<Logs>,
    transport: Signal,
    updates: watch::Receiver<Option<Value>>,
    wakes: watch::Receiver<()>,
    binding: Option<Value>,
    pending: Option<Value>,
    published: Value,
}

impl Publication {
    async fn run(mut self) {
        let mut failures = 0;
        while self.source.runtime().is_ok() && self.transport.check().is_ok() {
            if self.wakes.has_changed().unwrap_or(false) {
                self.wakes.borrow_and_update();
                self.binding = None;
            }
            let update = self.updates.has_changed().unwrap_or(false);
            let latest = self.updates.borrow_and_update().clone();
            if update && latest.is_none() {
                self.binding = None;
            }
            let outcome = self.publish(latest.as_ref()).await;
            let delay = match outcome {
                Ok(true) => {
                    failures = 0;
                    continue;
                }
                Ok(false) => None,
                Err(error) => {
                    if matches!(error.downcast_ref::<MetadataHttpError>(), Some(http) if http.code == "settings-binding-replaced")
                    {
                        self.binding = None;
                    }
                    if self.source.runtime().is_err() || self.transport.check().is_err() {
                        break;
                    }
                    self.logs.repeated(
                        format!("native-settings-publication:{}",self.source.scope["chatId"].stringify()),
                        "warn", "Native settings publication remains pending.",
                        json!({"event":"codex.settings.observation-pending","chatId":self.source.scope["chatId"]}),
                    );
                    let delay = Duration::from_millis((500u64 << failures).min(10_000));
                    failures = (failures + 1).min(5);
                    Some(delay)
                }
            };
            tokio::select! {
                _ = self.source.signal.cancelled() => break,
                _ = self.transport.cancelled() => break,
                changed = self.wakes.changed() => {
                    if changed.is_err() { break; }
                    self.binding = None;
                }
                changed = self.updates.changed() => {
                    if changed.is_err() { break; }
                    if self.updates.borrow().is_none() { self.binding = None; }
                }
                _ = async {
                    if let Some(delay) = delay { tokio::time::sleep(delay).await; }
                    else { std::future::pending::<()>().await; }
                } => {}
            }
        }
    }

    async fn publish(&mut self, latest: Option<&Value>) -> Result<bool> {
        let scope = self.source.encryption_scope()?;
        let guard = Guard::metadata(
            Some(self.source.signal.clone()),
            Some(self.transport.clone()),
        );
        let Some(binding) = self.binding.as_ref() else {
            let chat = id(&self.source.scope["chatId"], "settings chat")?;
            let state = self.client.refresh_settings(&chat, &guard).await?;
            self.source.runtime()?;
            scope.identity()?;
            if !self.source.binding_matches(&state["binding"]) || state["effective"].is_null() {
                bail!("Core returned another managed settings source.");
            }
            self.published = state["effective"]["context"]["settingsVersion"].clone();
            self.binding = Some(state["binding"].clone());
            self.pending = None;
            if !self.updates.has_changed().unwrap_or(false)
                && latest.is_some_and(|settings| {
                    settings["settingsVersion"]["epoch"] != state["binding"]["nativeEpoch"]
                })
            {
                // The actual read superseded the buffered epoch. Do not
                // repeatedly publish an observation from the retired epoch.
                self.published = latest.unwrap()["settingsVersion"].clone();
            }
            return Ok(true);
        };
        let Some(latest) = latest else {
            return Ok(false);
        };
        let current = &latest["settingsVersion"];
        if !newer(current, &self.published) {
            return Ok(false);
        }
        if current["epoch"] != binding["nativeEpoch"] {
            self.binding = None;
            return Ok(true);
        }
        if self
            .pending
            .as_ref()
            .is_none_or(|pending| pending["context"]["settingsVersion"] != *current)
        {
            self.pending = Some(self.source.seal(&scope, latest)?);
        }
        let confirmed = self
            .client
            .observe_settings(
                &binding["bindingId"],
                self.pending.as_ref().unwrap(),
                &guard,
            )
            .await?;
        self.source.runtime()?;
        scope.identity()?;
        let observed = &confirmed["settingsVersion"];
        ensure!(
            observed["epoch"] == current["epoch"] && !newer(current, observed),
            "Core did not confirm the observed native settings version."
        );
        self.published = observed.clone();
        self.pending = None;
        Ok(true)
    }
}

fn version(value: &Value) -> Option<(&JsString, u64)> {
    Some((
        value["epoch"].as_js_string()?,
        value["revision"].as_str()?.parse().ok()?,
    ))
}

fn newer(candidate: &Value, current: &Value) -> bool {
    version(candidate)
        .zip(version(current))
        .is_some_and(|(left, right)| left.0 != right.0 || left.1 > right.1)
}
