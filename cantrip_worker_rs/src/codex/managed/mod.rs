//! Owns each managed Codex child, its RPC session and native inference router.
mod history;
mod launch;
mod resources;
mod worker;

use super::{
    admission::{Adapter, OnRevoked},
    private_inference::{Hooks, Router, Routing},
    process_transport::{RetirementError, retirement_failed},
    rpc_requests::{Response, Settlement},
    session::{Event, EventKind, Session},
};
use crate::{
    history::live::observation::RuntimeHub,
    inference::admission::{Manager, Promise},
    logging::Logs,
};
use anyhow::{Result, anyhow, bail};
use cantrip_history::projection::Work;
use cantrip_transport::lifecycle::owned;
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};
use tokio::{sync::mpsc, task::JoinSet};

pub use launch::{GrokAccount, Host, Profile};
pub use worker::{Binding, Worker};

const RPC_TIMEOUT: Duration = Duration::from_secs(120);
pub type PrepareHome = Arc<dyn Fn(PathBuf) -> Work<()> + Send + Sync>;
pub type Observe = Arc<dyn Fn(Event) -> Result<()> + Send + Sync>;

pub trait ExternalAuth: Send + Sync {
    fn login(&self) -> Work<Option<Value>>;
    fn refresh(&self, params: Value) -> Work<Value>;
    fn reauthenticate(&self, session: Session) -> Work<()>;
}

pub struct Launch {
    pub profile: Profile,
    pub private_inference: Hooks,
    pub on_revoked: Option<OnRevoked>,
    pub prepare_home: Option<PrepareHome>,
    pub external_auth: Option<Arc<dyn ExternalAuth>>,
    pub observe: Observe,
}

struct Inner {
    id: JsString,
    codex_home: PathBuf,
    generation: String,
    session: Session,
    history: Arc<RuntimeHub>,
    adapter: Adapter,
    router: Router,
    resources: Arc<resources::Resources>,
    retirement: Promise<()>,
    external_auth: Option<Arc<dyn ExternalAuth>>,
    closing: Mutex<Option<Promise<()>>>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        if self.closing.get_mut().unwrap().is_none()
            && tokio::runtime::Handle::try_current().is_ok()
        {
            // The event task holds the router, but never holds this command
            // handle. Dropping the last one still stops the owned child.
            drop(self.router.close());
        }
    }
}

#[derive(Clone)]
pub struct Runtime(Arc<Inner>);

pub(in crate::codex) struct WeakRuntime(Weak<Inner>);

impl WeakRuntime {
    pub(in crate::codex) fn upgrade(&self) -> Option<Runtime> {
        self.0.upgrade().map(Runtime)
    }
}

impl Runtime {
    pub(in crate::codex) fn downgrade(&self) -> WeakRuntime {
        WeakRuntime(Arc::downgrade(&self.0))
    }

    pub fn launch(host: Host, manager: Manager, launch: Launch) -> Work<Self> {
        Self::launch_protected(host, manager, launch, None)
    }

    fn launch_protected(
        host: Host,
        manager: Manager,
        launch: Launch,
        protection: Option<resources::Grant>,
    ) -> Work<Self> {
        owned(async move {
            let started = Instant::now();
            let id = launch.profile.id.clone();
            event(
                &host.logs,
                "info",
                "Codex app-server startup started",
                &id,
                "start",
                "started",
                started,
            );
            let result = Self::start(host.clone(), manager, launch, protection).await;
            if result.is_ok() {
                event(
                    &host.logs,
                    "info",
                    "Codex app-server ready",
                    &id,
                    "start",
                    "ready",
                    started,
                );
            } else {
                event(
                    &host.logs,
                    "error",
                    "Codex app-server startup failed",
                    &id,
                    "start",
                    "failed",
                    started,
                );
            }
            result
        })
    }

    async fn start(
        host: Host,
        manager: Manager,
        launch: Launch,
        protection: Option<resources::Grant>,
    ) -> Result<Self> {
        let Launch {
            mut profile,
            private_inference,
            on_revoked,
            prepare_home,
            external_auth,
            observe,
        } = launch;
        if profile.grok.is_some() {
            bail!("Managed Grok account launch requires the worker runtime registry.");
        }
        let home = cantrip_config::resolve(&host.cwd, &profile.codex_home);
        cantrip_host::files::private_directory(&home)?;
        if let Some(prepare) = prepare_home {
            prepare(home.clone()).await?;
        }

        if let Some(auth) = &external_auth {
            profile.external_login = auth.login().await?;
        }
        let adapter = Adapter::new(manager, on_revoked)?;
        let resources = async {
            let environment = adapter.prepare_native_launch().await?;
            let (arguments, options) = host.process(&profile, environment)?;
            Session::launch(host.binary.clone(), arguments, options).await
        }
        .await;
        let (session, events) = match resources {
            Ok(resources) => resources,
            Err(error) if retirement_failed(&error) => return Err(error),
            Err(error) => {
                // Launch has not returned a usable session. Retire the
                // prepared generation through the keeper before replacement.
                return failed_start(error, adapter.process_exited().await);
            }
        };
        let router = match Router::new(session.clone(), adapter.clone(), private_inference) {
            Ok(router) => router,
            Err(error) => {
                let cleanup = async {
                    session.close().await?;
                    adapter.process_exited().await
                }
                .await;
                return failed_start(error, cleanup);
            }
        };
        let generation = router.generation().to_owned();
        let resources = Arc::new(resources::Resources::new(
            protection,
            adapter.generation().clone(),
        ));
        let retirement = Promise::spawn(pump(
            router.clone(),
            events,
            observe,
            host.logs.clone(),
            profile.id.clone(),
            NativeCallbacks {
                session: session.clone(),
                external_auth: external_auth.clone(),
                resources: resources.clone(),
            },
        ));
        let runtime = Self(Arc::new_cyclic(|inner| Inner {
            id: profile.id.clone(),
            codex_home: home,
            generation,
            history: history::source(session.history(), inner.clone()),
            session,
            adapter,
            router,
            resources,
            retirement,
            external_auth,
            closing: Mutex::new(None),
        }));
        if let Err(error) = host
            .initialize(&runtime.0.session, &profile)
            .await
            .and_then(|()| runtime.assert_live())
        {
            return failed_start(error, runtime.close().await);
        }
        Ok(runtime)
    }

    pub fn id(&self) -> &JsString {
        &self.0.id
    }

    pub(in crate::codex) fn codex_home(&self) -> &Path {
        &self.0.codex_home
    }

    pub fn generation(&self) -> &str {
        &self.0.generation
    }

    pub fn is_live(&self) -> bool {
        self.0.closing.lock().unwrap().is_none()
            && self.0.session.generation() == Some(self.generation())
    }

    pub(in crate::codex) fn bind_native_resources(
        &self,
        thread: &JsString,
        runner: &JsString,
        task: bool,
    ) {
        self.0.resources.bind(&self.0.session, thread, runner, task);
    }

    pub(super) fn thread_version(&self, thread: &JsString) -> u64 {
        self.0.session.thread_version(thread)
    }

    pub fn admission(&self) -> &Adapter {
        &self.0.adapter
    }

    pub fn inference_router(&self) -> &Router {
        &self.0.router
    }

    pub fn request(
        &self,
        method: JsString,
        params: Option<Value>,
        timeout: Option<Duration>,
        settlement: Option<Arc<dyn Settlement>>,
    ) -> Work<Response> {
        if let Err(error) = self.assert_live() {
            if let Some(settlement) = settlement {
                let _ = settlement.not_sent();
            }
            return Box::pin(async { Err(error) });
        }
        let this = self.clone();
        let request = self.0.session.request(method, params, timeout, settlement);
        owned(async move {
            let reply = request.await?;
            this.assert_live()?;
            Ok(reply)
        })
    }

    pub fn reauthenticate_external(&self) -> Work<()> {
        match self.assert_live().and_then(|()| {
            self.0
                .external_auth
                .as_ref()
                .ok_or_else(|| anyhow!("Portable ChatGPT authentication is not active."))
        }) {
            Ok(auth) => auth.reauthenticate(self.0.session.clone()),
            Err(error) => Box::pin(async { Err(error) }),
        }
    }

    pub fn send(&self, message: Value) -> Result<()> {
        self.assert_live()?;
        self.0.session.send(message)
    }

    pub fn retired(&self) -> Work<()> {
        self.0.retirement.work()
    }

    pub fn close(&self) -> Work<()> {
        let mut closing = self.0.closing.lock().unwrap();
        if let Some(pending) = closing.as_ref() {
            return pending.work();
        }
        let router = self.0.router.clone();
        let retired = self.0.retirement.clone();
        let pending = Promise::spawn(async move {
            router.close().await?;
            retired.work().await
        });
        *closing = Some(pending.clone());
        pending.work()
    }

    fn assert_live(&self) -> Result<()> {
        if !self.is_live() {
            bail!("The managed execution runner belongs to a replaced native transport.");
        }
        Ok(())
    }
}

struct NativeCallbacks {
    session: Session,
    external_auth: Option<Arc<dyn ExternalAuth>>,
    resources: Arc<resources::Resources>,
}

async fn pump(
    router: Router,
    mut events: mpsc::UnboundedReceiver<Event>,
    observe: Observe,
    logs: Option<Arc<Logs>>,
    id: JsString,
    native: NativeCallbacks,
) -> Result<()> {
    let NativeCallbacks {
        session,
        external_auth,
        resources,
    } = native;
    let mut callbacks = JoinSet::new();
    let started = Instant::now();
    loop {
        tokio::select! {
            Some(_) = callbacks.join_next(), if !callbacks.is_empty() => {},
            next = events.recv() => {
                let Some(event_data) = next else { return router.close().await; };
                if let EventKind::Message(message) = &event_data.kind
                    && message["method"] == "account/chatgptAuthTokens/refresh"
                    && let Some(request) = message.get("id") {
                    let request = request.clone();
                    let params = message["params"].clone();
                    let session = session.clone();
                    let auth = external_auth.clone();
                    callbacks.spawn(async move { refresh(auth, session, request, params).await });
                    continue;
                }
                if let EventKind::Message(message) = &event_data.kind
                    && message["method"] == super::rpc_protocol::RESOURCE_REQUESTED {
                    let session = session.clone();
                    let resources = resources.clone();
                    let logs = logs.clone();
                    let id = id.clone();
                    let generation = event_data.generation;
                    let params = message["params"].clone();
                    callbacks.spawn(async move {
                        if resources.resolve(&generation, &session, &params).await.is_err() {
                            event(&logs, "warn", "Native resource protection failed", &id, "native-resources", "failed", started);
                        }
                    });
                    continue;
                }
                let exited = matches!(event_data.kind, EventKind::ProcessExited(_));
                if matches!(event_data.kind, EventKind::TransportLost(_)) {
                    event(&logs, "warn", "Codex app-server transport closed", &id, "connect-websocket", "disconnected", started);
                }
                match router.route(&event_data) {
                    Routing::Private(work) => {
                        let logs = logs.clone();
                        let id = id.clone();
                        callbacks.spawn(async move {
                            if work.await.is_err() {
                                event(&logs, "warn", "Native inference admission failed", &id, "native-inference", "failed", started);
                            }
                        });
                    }
                    routing => {
                        // Wake owners of accepted work before joining their
                        // teardown through admission retirement.
                        if observe(event_data).is_err() {
                            event(&logs, "warn", "Codex runtime observation failed", &id, "observe", "failed", started);
                        }
                        let outcome = match routing {
                            Routing::Observe(work) => work.await,
                            _ => Ok(()),
                        };
                        if exited {
                            outcome?;
                            return router.close().await;
                        }
                        if outcome.is_err() {
                            event(&logs, "warn", "Codex admission observation failed", &id, "observe", "failed", started);
                        }
                    }
                }
            }
        }
    }
}

async fn refresh(auth: Option<Arc<dyn ExternalAuth>>, session: Session, id: Value, params: Value) {
    let result = match auth {
        Some(auth) => auth.refresh(params).await,
        None => Err(anyhow!("Portable ChatGPT authentication is not active.")),
    };
    let reply = match result {
        Ok(result) => {
            if let Some(secret) = result["accessToken"].as_js_string() {
                session.remember_secret(secret.clone());
            }
            json!({"id":id,"result":result})
        }
        Err(error) => {
            json!({"id":id,"error":json!({"code":-32602,"message":crate::error::message(&error)})})
        }
    };
    let _ = session.send(reply);
}

fn failed_start<T>(error: anyhow::Error, cleanup: Result<()>) -> Result<T> {
    match cleanup {
        Ok(()) => Err(error),
        Err(cleanup) => Err(RetirementError(cleanup.context(error.to_string())).into()),
    }
}

fn event(
    logs: &Option<Arc<Logs>>,
    level: &str,
    message: &str,
    runtime: &JsString,
    operation: &str,
    status: &str,
    started: Instant,
) {
    if let Some(logs) = logs {
        logs.event(level, message, json!({
            "event":"codex.runtime.lifecycle", "subsystem":"codex", "runtimeId":runtime,
            "operation":operation, "status":status, "durationMs":started.elapsed().as_millis() as u64
        }));
    }
}
