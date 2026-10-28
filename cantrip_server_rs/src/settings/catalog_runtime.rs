//! Composition of provider catalogs with request-owned identity and lifetime.
use super::{
    account_catalog::AccountCatalogRequest,
    grok::{CatalogDiagnostics, CatalogWarning},
    openrouter::{self, RuntimeHydrator},
    repository::SettingsRepository,
};
use crate::{
    wire::{JsString, Value},
    workers::{command_bus::LimitedCommandBus, repository::WorkerRepository},
};
use anyhow::{Context, Result};
use futures::{FutureExt, future::BoxFuture};
use serde_json::Value as Json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Notify;

#[derive(Clone, Copy, Debug)]
pub enum Family {
    Zai,
    Public,
    ChatGpt,
    Grok,
    Ollama,
}
#[derive(Clone)]
pub struct CatalogRequest {
    pub owner: String,
    pub provider: String,
    /// Legacy HTTP query objects can contain repeated-key arrays. Database text
    /// conversion must not turn an array into a connected bridge Map key.
    pub worker: Option<Value>,
    pub force: bool,
    pub account: Option<String>,
    pub quota_trigger: Option<String>,
}
pub trait CatalogBackend: Send + Sync {
    fn load(
        &self,
        family: Family,
        request: CatalogRequest,
    ) -> BoxFuture<'static, Result<Option<Json>>>;
    fn drain(&self) -> BoxFuture<'_, Vec<Arc<anyhow::Error>>> {
        async { vec![] }.boxed()
    }
}
struct Services {
    repository: SettingsRepository,
    commands: Arc<LimitedCommandBus>,
    public: Arc<openrouter::CatalogService>,
    grok: Arc<super::grok::CatalogService>,
}
impl CatalogBackend for Services {
    fn load(
        &self,
        family: Family,
        request: CatalogRequest,
    ) -> BoxFuture<'static, Result<Option<Json>>> {
        let repository = self.repository.clone();
        let commands = self.commands.clone();
        let public = self.public.clone();
        let grok = self.grok.clone();
        async move {
            let worker_text = if matches!(family, Family::Ollama | Family::ChatGpt | Family::Grok) {
                request
                    .worker
                    .as_ref()
                    .map(super::raw_identifiers::text)
                    .transpose()?
            } else {
                None
            };
            let worker_key_is_string = request.worker.as_ref().is_some_and(Value::is_string);
            match family {
                Family::Zai => {
                    repository
                        .get_zai_provider_catalog(&request.owner, &request.provider)
                        .await
                }
                Family::Public => {
                    public
                        .get_provider_catalog(&request.owner, &request.provider, request.force)
                        .await
                }
                Family::Ollama => {
                    repository
                        .get_ollama_provider_catalog_for_key(
                            &request.owner,
                            &request.provider,
                            worker_text.as_deref().context("selected catalog worker")?,
                            request.force,
                            &commands,
                            worker_key_is_string,
                        )
                        .await
                }
                Family::ChatGpt | Family::Grok => {
                    let request = AccountCatalogRequest {
                        owner: &request.owner,
                        provider: &request.provider,
                        worker: worker_text
                            .as_deref()
                            .context("selected account catalog worker")?,
                        worker_key_is_string,
                        force: request.force,
                        requested_account: request.account.as_deref(),
                        quota_trigger: request.quota_trigger.as_deref(),
                    };
                    match family {
                        Family::Grok => grok.get_provider_catalog(&request).await,
                        _ => {
                            repository
                                .get_chatgpt_provider_catalog(&request, &commands)
                                .await
                        }
                    }
                }
            }
        }
        .boxed()
    }
    fn drain(&self) -> BoxFuture<'_, Vec<Arc<anyhow::Error>>> {
        async move {
            let errors = self.public.drain().await;
            self.grok.drain().await;
            errors
        }
        .boxed()
    }
}

/// Operational output is intentionally separate from the pending shared native
/// logger's redaction, rate-limit summaries, buffering and archive integration.
struct OperationalDiagnostics;
impl CatalogDiagnostics for OperationalDiagnostics {
    fn event(&self, level: &'static str, context: Value, message: &'static str) -> Result<()> {
        eprintln!(
            "{}",
            Value::object([
                ("level", Value::String(level.into())),
                ("message", Value::String(message.into())),
                ("context", context)
            ])
            .stringify()
        );
        Ok(())
    }
    fn rate_limited(&self, warning: CatalogWarning) -> Result<()> {
        self.event(warning.level, warning.context, warning.message)
    }
}
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub struct CatalogRuntime {
    repository: SettingsRepository,
    commands: Arc<LimitedCommandBus>,
    backend: Arc<dyn CatalogBackend>,
    diagnostics: Arc<dyn CatalogDiagnostics>,
    clock: Clock,
    pub hydrator: Arc<RuntimeHydrator>,
    active: AtomicUsize,
    drained: Notify,
}
struct Task(Arc<CatalogRuntime>);
impl Drop for Task {
    fn drop(&mut self) {
        if self.0.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.drained.notify_waiters();
        }
    }
}
impl CatalogRuntime {
    pub fn new(
        repository: SettingsRepository,
        commands: Arc<LimitedCommandBus>,
    ) -> Result<Arc<Self>> {
        let diagnostics = Arc::new(OperationalDiagnostics);
        let backend = Arc::new(Services {
            repository: repository.clone(),
            commands: commands.clone(),
            public: openrouter::CatalogService::new(repository.clone())?,
            grok: super::grok::CatalogService::new(
                repository.clone(),
                commands.clone(),
                diagnostics.clone(),
            )?,
        });
        Ok(Self::with_backend(
            repository,
            commands,
            backend,
            diagnostics,
            Arc::new(|| crate::auth::now().timestamp_millis()),
        ))
    }
    pub fn with_backend(
        repository: SettingsRepository,
        commands: Arc<LimitedCommandBus>,
        backend: Arc<dyn CatalogBackend>,
        diagnostics: Arc<dyn CatalogDiagnostics>,
        clock: Clock,
    ) -> Arc<Self> {
        Arc::new(Self {
            repository,
            commands,
            backend,
            diagnostics,
            clock,
            hydrator: RuntimeHydrator::new(),
            active: AtomicUsize::new(0),
            drained: Notify::new(),
        })
    }
    pub fn load(
        self: &Arc<Self>,
        request: CatalogRequest,
    ) -> BoxFuture<'static, Result<Option<Json>>> {
        self.active.fetch_add(1, Ordering::AcqRel);
        let task = Task(self.clone());
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let result = task.0.run(request).await;
            let _ = send.send(result);
        });
        async move {
            receive
                .await
                .context("Provider catalog operation failed.")?
        }
        .boxed()
    }
    async fn run(&self, request: CatalogRequest) -> Result<Option<Json>> {
        let started = (self.clock)();
        let context = |event: &str, status: &str, elapsed: bool| {
            let mut context = Value::object([
                ("event", Value::String(event.into())),
                ("subsystem", Value::String("provider-catalog".into())),
                ("operation", Value::String("refresh".into())),
                ("status", Value::String(status.into())),
                ("providerId", Value::String(request.provider.clone().into())),
            ]);
            if let Some(worker) = &request.worker {
                context["workerId"] = worker.clone();
            }
            if elapsed {
                context["durationMs"] = Value::Number(((self.clock)() - started) as f64);
            }
            context
        };
        self.diagnostics.event(
            "debug",
            context("provider.catalog.refresh-started", "refreshing", false),
            "Provider catalog refresh began",
        )?;
        let result = async {
            let catalog = self.load_unchecked(&request).await?;
            self.diagnostics.event(
                "info",
                context(
                    "provider.catalog.refresh-completed",
                    if catalog.is_some() {
                        "completed"
                    } else {
                        "not-applicable"
                    },
                    true,
                ),
                "Provider catalog refresh completed",
            )?;
            Ok(catalog)
        }
        .await;
        match result {
            Ok(catalog) => Ok(catalog),
            Err(error) => {
                let mut context = context("provider.catalog.refresh-failed", "failed", true);
                context["reasonCode"] = Value::String("catalog-unavailable".into());
                self.diagnostics.rate_limited(CatalogWarning {
                    key: format!(
                        "provider-catalog-refresh-failed:{}:{}",
                        request.provider,
                        request
                            .worker
                            .as_ref()
                            .filter(|value| !value.is_null())
                            .map(super::raw_identifiers::text)
                            .transpose()?
                            .as_deref()
                            .unwrap_or("automatic")
                    ),
                    level: "warn",
                    message: "Provider catalog refresh failed",
                    context,
                    summary_every: 10,
                    window_ms: 300_000,
                })?;
                Err(error)
            }
        }
    }
    async fn load_unchecked(&self, request: &CatalogRequest) -> Result<Option<Json>> {
        let Some(provider) = self
            .repository
            .get_provider_catalog_runtime(&request.owner, &request.provider)
            .await?
        else {
            return Ok(None);
        };
        if super::zai::is_coding_plan_provider(&provider) {
            return self.backend.load(Family::Zai, request.clone()).await;
        }
        let family = match provider["kind"].as_str() {
            Some("chatgpt") => Family::ChatGpt,
            Some("grok") => Family::Grok,
            Some("ollama") => Family::Ollama,
            _ => Family::Public,
        };
        if matches!(family, Family::Public) {
            let catalog = self.backend.load(family, request.clone()).await?;
            if catalog.is_some() {
                self.hydrator.mark_hydrated(request.provider.clone().into());
            }
            return Ok(catalog);
        }
        let mut request = request.clone();
        if !crate::wire::coercion::truthy(request.worker.as_ref()) {
            let workers = WorkerRepository::new(self.repository.database.clone());
            let (preferences, workers) = tokio::try_join!(
                self.repository.get_user_settings(&request.owner),
                workers.list_workers(&request.owner)
            )?;
            let default = preferences["defaultWorkerId"].as_str();
            let selected = default
                .filter(|id| !id.is_empty() && self.commands.is_connected(id))
                .or_else(|| {
                    workers
                        .iter()
                        .filter_map(|worker| worker["workerId"].as_str())
                        .find(|id| self.commands.is_connected(id))
                })
                .or(default);
            request.worker = selected.map(|value| Value::String(value.into()));
        }
        if !crate::wire::coercion::truthy(request.worker.as_ref()) {
            let label = match family {
                Family::ChatGpt => "ChatGPT",
                Family::Grok => "Grok",
                _ => "Ollama",
            };
            anyhow::bail!("No worker is available for {label} discovery.")
        }
        self.backend.load(family, request).await
    }
    pub fn hydrate(
        self: &Arc<Self>,
        owner: &str,
        runtimes: &[Value],
    ) -> BoxFuture<'static, openrouter::HydrationResult> {
        let owner = owner.to_owned();
        let backend = self.backend.clone();
        let diagnostics = self.diagnostics.clone();
        self.hydrator.hydrate(
            runtimes,
            Arc::new(move |provider: JsString| {
                let request = CatalogRequest {
                    owner: owner.clone(),
                    provider: provider.lossy().into_owned(),
                    worker: None,
                    force: false,
                    account: None,
                    quota_trigger: None,
                };
                let pending = backend.load(Family::Public, request);
                let diagnostics = diagnostics.clone();
                async move {
                    match pending.await {
                        Ok(catalog) => Ok(catalog.is_some()),
                        Err(error) => {
                            diagnostics.event(
                                "warn",
                                Value::object([
                                    ("providerId", Value::String(provider)),
                                    ("error", Value::String(error.to_string().into())),
                                ]),
                                "Unable to hydrate OpenRouter model metadata",
                            )?;
                            Ok(false)
                        }
                    }
                }
                .boxed()
            }),
        )
    }
    pub async fn drain(&self) -> Vec<Arc<anyhow::Error>> {
        self.hydrator.drain().await;
        loop {
            let notified = self.drained.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.active.load(Ordering::Acquire) == 0 {
                break;
            }
            notified.await;
        }
        self.backend.drain().await
    }
}
