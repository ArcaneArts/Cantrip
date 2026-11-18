use super::*;
use crate::{
    codex::{goals::delivery::Delivery as ProjectGoals, task_inputs},
    encryption::Service,
    inference::{admission::Options as AdmissionOptions, ownership},
};
use futures::future::join_all;
use std::sync::{
    OnceLock, Weak,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

pub type Binding = Arc<dyn Fn() -> Result<(JsString, JsString)> + Send + Sync>;
type GrokResolver = Arc<dyn Fn(GrokAccount) -> Work<String> + Send + Sync>;

#[derive(Clone, PartialEq, Eq, Hash)]
struct Scope {
    server: JsString,
    owner: JsString,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct Key {
    scope: Scope,
    profile: JsString,
}

#[derive(Clone, PartialEq, Eq)]
struct Home {
    runtime: PathBuf,
    configuration: Option<PathBuf>,
    credential: Option<PathBuf>,
    account_scope: Option<(JsString, JsString)>,
}

#[derive(Clone)]
struct Slot {
    ready: Promise<Runtime>,
    home: Home,
    retiring: Arc<AtomicBool>,
}

#[derive(Default)]
struct State {
    managers: HashMap<Scope, Manager>,
    runtimes: HashMap<Key, Slot>,
    homes: HashMap<PathBuf, Weak<AsyncMutex<()>>>,
    closing: Option<Promise<()>>,
}

struct Inner {
    host: Host,
    data: PathBuf,
    worker_id: JsString,
    worker_generation: JsString,
    binding: Binding,
    grok: OnceLock<GrokResolver>,
    task_inputs: OnceLock<task_inputs::Client>,
    project_goals: OnceLock<Arc<ProjectGoals>>,
    state: Mutex<State>,
}

/// Holds the authenticated worker generation's Codex children and shared
/// provider pools. Construction does not open a keeper or launch a child.
#[derive(Clone)]
pub struct Worker(Arc<Inner>);

impl Worker {
    pub fn new(
        host: Host,
        data: PathBuf,
        worker_id: JsString,
        worker_generation: JsString,
        binding: Binding,
    ) -> Self {
        Self(Arc::new(Inner {
            host,
            data,
            worker_id,
            worker_generation,
            binding,
            grok: OnceLock::new(),
            task_inputs: OnceLock::new(),
            project_goals: OnceLock::new(),
            state: Mutex::new(State::default()),
        }))
    }

    pub fn bound_to_encryption(
        host: Host,
        data: PathBuf,
        worker_id: JsString,
        worker_generation: JsString,
        encryption: Arc<Service>,
    ) -> Self {
        Self::new(
            host,
            data,
            worker_id,
            worker_generation,
            Arc::new(move || {
                let (owner, server) = encryption.bound_identity()?;
                let server = server.as_js_string().cloned().ok_or_else(|| {
                    anyhow!("Worker encryption has not verified the logical server identity.")
                })?;
                Ok((server, owner))
            }),
        )
    }

    pub(crate) fn configure_grok(&self, resolve: GrokResolver) -> Result<()> {
        self.0
            .grok
            .set(resolve)
            .map_err(|_| anyhow!("Grok proxy is already configured."))
    }

    pub(crate) fn configure_task_inputs(&self, client: task_inputs::Client) -> Result<()> {
        self.0
            .task_inputs
            .set(client)
            .map_err(|_| anyhow!("Task input ownership is already configured."))
    }

    pub(crate) fn configure_project_goals(&self, delivery: Arc<ProjectGoals>) -> Result<()> {
        self.0
            .project_goals
            .set(delivery)
            .map_err(|_| anyhow!("Project Goal observations are already configured."))
    }

    pub(in crate::codex) fn project_goals(&self) -> Option<&ProjectGoals> {
        self.0.project_goals.get().map(Arc::as_ref)
    }

    pub(in crate::codex) fn wake_recovery(
        &self,
        owner: &JsString,
        server: &JsString,
        chat: &JsString,
    ) {
        let scope = Scope {
            owner: owner.clone(),
            server: server.clone(),
        };
        let manager = self.0.state.lock().unwrap().managers.get(&scope).cloned();
        if let Some(manager) = manager {
            manager.wake_recovery(Some(chat.clone()));
        }
    }

    pub fn launch(&self, launch: Launch) -> Work<Runtime> {
        self.launch_in_scope(launch, None)
    }

    pub(in crate::codex) fn launch_in_scope(
        &self,
        mut launch: Launch,
        binding: Option<(JsString, JsString)>,
    ) -> Work<Runtime> {
        let this = self.clone();
        owned(async move {
            let scope = this.scope()?;
            if binding.is_some_and(|(server, owner)| scope.server != server || scope.owner != owner)
            {
                bail!("The worker binding changed before native runtime launch.");
            }
            let key = Key {
                scope,
                profile: launch.profile.id.clone(),
            };
            let credential = launch.profile.grok.as_ref().map(|grok| {
                crate::codex::catalog::account_home(&this.0.data, &grok.credential_home_key)
            });
            if let Some(grok) = &launch.profile.grok {
                let scope = (grok.account.provider.clone(), grok.account.id.clone());
                if launch
                    .profile
                    .account_scope
                    .as_ref()
                    .is_some_and(|account| account != &scope)
                {
                    bail!("Managed Grok launch received a different account identity.");
                }
                launch.profile.account_scope = Some(scope);
            }
            let home = Home {
                account_scope: launch.profile.account_scope.clone(),
                runtime: cantrip_config::resolve(&this.0.host.cwd, &launch.profile.codex_home),
                configuration: launch
                    .profile
                    .configuration_home
                    .as_ref()
                    .map(|home| cantrip_config::resolve(&this.0.host.cwd, home)),
                credential,
            };
            let mut previous: Option<Slot> = None;
            loop {
                let homes = this.lock_homes(&home).await;
                if let Some(slot) = previous.take() {
                    if slot.retiring.load(Ordering::Acquire) {
                        bail!("The Codex account runtime was retired.");
                    }
                    this.remove(&key, &slot);
                }
                this.publish(&key)?;
                let (slot, start) = {
                    let mut state = this.0.state.lock().unwrap();
                    if state.closing.is_some() {
                        bail!("Worker Codex runtimes are closing.");
                    }
                    if let Some(slot) = state.runtimes.get(&key) {
                        if slot.home != home {
                            bail!("A Codex runtime received a different account home.");
                        }
                        (slot.clone(), None)
                    } else {
                        let manager = state
                            .managers
                            .entry(key.scope.clone())
                            .or_insert_with(|| this.create_manager(&key.scope))
                            .clone();
                        let (complete, ready) = Promise::pair();
                        let slot = Slot {
                            ready,
                            home: home.clone(),
                            retiring: Arc::new(AtomicBool::new(false)),
                        };
                        state.runtimes.insert(key.clone(), slot.clone());
                        (slot, Some((complete, manager)))
                    }
                };
                drop(homes);
                if let Some((complete, manager)) = start {
                    let runtime = async {
                        if let Some(grok) = launch.profile.grok.take() {
                            let resolver = this.0.grok.get().ok_or_else(|| {
                                anyhow!("Grok subscription proxy is unavailable.")
                            })?;
                            let name = grok.provider_name.clone();
                            let proxy = resolver(grok).await?;
                            launch.profile.configure_grok(&name, &proxy);
                        }
                        if let Some(delivery) = this.0.project_goals.get().cloned() {
                            let scope = key.scope.clone();
                            let observe = launch.observe;
                            launch.observe = Arc::new(move |event| {
                                let captured = delivery.native(&scope.server, &scope.owner, &event);
                                observe(event)?;
                                captured
                            });
                        }
                        Runtime::launch(this.0.host.clone(), manager, launch).await
                    }
                    .await;
                    if runtime
                        .as_ref()
                        .is_err_and(|error| !retirement_failed(error))
                    {
                        this.remove(&key, &slot);
                    }
                    complete.finish(runtime);
                    let runtime = slot.ready.work().await?;
                    return this.ready_runtime(&key, &slot, runtime).await;
                }

                let runtime = slot.ready.work().await?;
                if runtime.is_live() {
                    return this.ready_runtime(&key, &slot, runtime).await;
                }
                runtime.close().await?;
                previous = Some(slot);
            }
        })
    }

    async fn ready_runtime(&self, key: &Key, slot: &Slot, runtime: Runtime) -> Result<Runtime> {
        if slot.retiring.load(Ordering::Acquire) {
            bail!("The Codex account runtime was retired.");
        }
        match self.publish(key) {
            Ok(()) => Ok(runtime),
            Err(error) => {
                // An old binding or shutdown won while launch was in flight.
                // Nobody may use this child under the replaced authority.
                let cleanup = runtime.close().await;
                if cleanup.is_ok() {
                    self.remove(key, slot);
                }
                failed_start(error, cleanup)
            }
        }
    }

    fn home_lock(&self, home: &Path) -> Arc<AsyncMutex<()>> {
        let mut state = self.0.state.lock().unwrap();
        state.homes.retain(|_, lock| lock.strong_count() != 0);
        let entry = state.homes.entry(home.to_path_buf()).or_default();
        if let Some(lock) = entry.upgrade() {
            return lock;
        }
        let lock = Arc::new(AsyncMutex::new(()));
        *entry = Arc::downgrade(&lock);
        lock
    }

    pub(crate) async fn lock_account_home(&self, home: &Path) -> OwnedMutexGuard<()> {
        self.home_lock(&cantrip_config::resolve(&self.0.host.cwd, home))
            .lock_owned()
            .await
    }

    async fn lock_homes(&self, home: &Home) -> Vec<OwnedMutexGuard<()>> {
        let mut paths = vec![home.runtime.as_path()];
        paths.extend(home.configuration.as_deref());
        paths.extend(home.credential.as_deref());
        paths.sort_unstable();
        paths.dedup();
        let mut locks = Vec::with_capacity(paths.len());
        for path in paths {
            locks.push(self.home_lock(path).lock_owned().await);
        }
        locks
    }

    /// Keep accepted launches and credential mutation mutually exclusive for
    /// both runtime and configuration homes. The operation owns its cleanup
    /// even if the control connection abandons the command response.
    pub(crate) fn with_retired_account<T: Send + 'static>(
        &self,
        home: PathBuf,
        account: (JsString, JsString),
        operation: impl FnOnce(Work<()>) -> Work<T> + Send + 'static,
    ) -> Work<T> {
        let this = self.clone();
        owned(async move {
            let home = cantrip_config::resolve(&this.0.host.cwd, &home);
            let _guard = this.home_lock(&home).lock_owned().await;
            let slots = {
                let state = this.0.state.lock().unwrap();
                if state.closing.is_some() {
                    bail!("Worker Codex runtimes are closing.");
                }
                let slots = state
                    .runtimes
                    .iter()
                    .filter(|(_, slot)| {
                        slot.home.runtime == home
                            || slot.home.configuration.as_ref() == Some(&home)
                            || slot.home.credential.as_ref() == Some(&home)
                    })
                    .map(|(key, slot)| (key.clone(), slot.clone()))
                    .collect::<Vec<_>>();
                if slots
                    .iter()
                    .any(|(_, slot)| slot.home.account_scope.as_ref() != Some(&account))
                {
                    bail!("A Codex runtime uses this home for a different account.");
                }
                for (_, slot) in &slots {
                    slot.retiring.store(true, Ordering::Release);
                }
                slots
            };
            let retired = Box::pin(async move {
                let results = join_all(slots.into_iter().map(|(key, slot)| {
                    let this = &this;
                    async move {
                        match slot.ready.work().await {
                            Ok(runtime) => runtime.close().await?,
                            Err(error) if retirement_failed(&error) => return Err(error),
                            Err(_) => {}
                        }
                        this.remove(&key, &slot);
                        Ok(())
                    }
                }))
                .await;
                results.into_iter().collect::<Result<()>>()
            });
            operation(retired).await
        })
    }

    /// Check the current authenticated scope before handing out a ready child.
    fn publish(&self, key: &Key) -> Result<()> {
        if self.scope()? != key.scope {
            bail!("The Codex runtime's account binding changed.");
        }
        if self.0.state.lock().unwrap().closing.is_some() {
            bail!("Worker Codex runtimes are closing.");
        }
        Ok(())
    }

    fn scope(&self) -> Result<Scope> {
        let (server, owner) = (self.0.binding)()?;
        if server.is_empty() || owner.is_empty() {
            bail!("The worker has no verified Codex account binding.");
        }
        Ok(Scope { server, owner })
    }

    fn remove(&self, key: &Key, slot: &Slot) {
        let mut state = self.0.state.lock().unwrap();
        if state
            .runtimes
            .get(key)
            .is_some_and(|current| current.ready.same(&slot.ready))
        {
            state.runtimes.remove(key);
        }
    }

    fn create_manager(&self, scope: &Scope) -> Manager {
        let scope = ownership::Scope {
            server_id: scope.server.clone(),
            owner_id: scope.owner.clone(),
            worker_id: self.0.worker_id.clone(),
            worker_generation: self.0.worker_generation.clone(),
        };
        let logs = self.0.host.logs.clone();
        let mut options =
            ownership::Options::local(self.0.host.cwd.clone(), self.0.host.environment.clone());
        options.report = Arc::new(move |_| {
            warn(
                &logs,
                "Native inference ownership recovery is pending",
                "inference.runtime.recovery-pending",
            );
            Ok(())
        });
        let owner = ownership::Owner::new(
            self.0.host.binary.clone(),
            &self.0.data,
            scope.clone(),
            options,
        );
        let mut admission = AdmissionOptions::local(scope);
        if let Some(client) = self.0.task_inputs.get().cloned() {
            let owner = admission.scope.owner_id.clone();
            let server = admission.scope.server_id.clone();
            admission.task_bound = Some(Arc::new(move |receipt, execution, generation, signal| {
                let (client, owner, server) = (client.clone(), owner.clone(), server.clone());
                Box::pin(async move {
                    client
                        .authorize(
                            &owner,
                            &server,
                            &receipt,
                            "native",
                            Some((execution, generation)),
                            signal,
                        )
                        .await
                })
            }));
        }
        admission.ownership = Some(Arc::new(owner));
        let logs = self.0.host.logs.clone();
        admission.journal_error = Arc::new(move |_| {
            warn(
                &logs,
                "Inference admission metadata operation failed",
                "inference.journal.failed",
            );
            Ok(())
        });
        Manager::new(admission)
    }

    /// Close admission to new launches synchronously, then join all accepted
    /// launches, child teardowns and keeper fences before releasing the worker.
    pub fn close(&self) -> Work<()> {
        let mut state = self.0.state.lock().unwrap();
        if let Some(pending) = &state.closing {
            return pending.work();
        }
        let runtimes = std::mem::take(&mut state.runtimes);
        let managers = std::mem::take(&mut state.managers);
        let pending = Promise::spawn(async move {
            let closed = join_all(runtimes.into_values().map(|slot| async move {
                match slot.ready.work().await {
                    Ok(runtime) => runtime.close().await,
                    // Startup owns its own cleanup. The keeper is still joined below.
                    Err(_) => Ok(()),
                }
            }))
            .await;
            let fenced = join_all(managers.into_values().map(|manager| manager.close())).await;
            closed.into_iter().chain(fenced).collect::<Result<()>>()
        });
        state.closing = Some(pending.clone());
        pending.work()
    }
}

fn warn(logs: &Option<Arc<Logs>>, message: &str, event: &str) {
    if let Some(logs) = logs {
        logs.repeated(
            event.into(),
            "warn",
            message,
            json!({"event":event,"subsystem":"codex"}),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex::private_inference::{Context, Hooks};
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn account_mutation_joins_accepted_startup_and_fences_new_launches() -> Result<()> {
        tokio::time::timeout(Duration::from_secs(4), async {
            let root = tempfile::tempdir()?;
            let home = root.path().join("account");
            let worker = Worker::new(
                Host {
                    binary: root.path().join("fixture"),
                    cwd: root.path().into(),
                    environment: HashMap::new(),
                    compatibility: Value::Null,
                    logs: None,
                },
                root.path().into(),
                "worker".into(),
                "generation".into(),
                Arc::new(|| Ok(("server".into(), "owner".into()))),
            );
            let account = ("provider".into(), "account".into());
            let launch = |prepare| {
                let mut profile = Profile::new("profile".into(), home.clone());
                profile.account_scope = Some(account.clone());
                Launch {
                    profile,
                    private_inference: Hooks {
                        overlay: Arc::new(|_| Context::default()),
                        provider: Arc::new(|| None),
                        before_inference: None,
                    },
                    on_revoked: None,
                    prepare_home: Some(prepare),
                    external_auth: None,
                    observe: Arc::new(|_| Ok(())),
                }
            };
            let (resume, blocked) = oneshot::channel();
            let blocked = Mutex::new(Some(blocked));
            let first = worker.launch(launch(Arc::new(move |_| {
                let blocked = blocked.lock().unwrap().take().unwrap();
                Box::pin(async move {
                    blocked.await?;
                    bail!("Fixture stopped the accepted startup.")
                })
            })));
            let (entered, retiring) = oneshot::channel();
            let (stopped, retired) = oneshot::channel();
            let (finish, writing) = oneshot::channel();
            let mut operation =
                worker.with_retired_account(home.clone(), account.clone(), |stop| {
                    Box::pin(async move {
                        entered.send(()).unwrap();
                        stop.await?;
                        stopped.send(()).unwrap();
                        writing.await?;
                        Ok(())
                    })
                });
            retiring.await?;
            assert!(futures::poll!(&mut operation).is_pending());
            let (started, replacement) = oneshot::channel();
            let started = Mutex::new(Some(started));
            let queued = worker.launch(launch(Arc::new(move |_| {
                started.lock().unwrap().take().unwrap().send(()).unwrap();
                Box::pin(async {
                    Err(RetirementError(anyhow!("Fixture did not confirm process exit.")).into())
                })
            })));
            resume.send(()).unwrap();
            assert!(first.await.is_err());
            retired.await?;
            let mut replacement = replacement;
            assert!(futures::poll!(&mut replacement).is_pending());
            finish.send(()).unwrap();
            operation.await?;
            replacement.await?;
            assert!(queued.await.is_err_and(|error| retirement_failed(&error)));
            let rejected: Result<()> = worker
                .with_retired_account(home, account, |stop| {
                    Box::pin(async move {
                        stop.await?;
                        panic!("Credential mutation must wait for confirmed process exit.");
                    })
                })
                .await;
            assert!(rejected.is_err_and(|error| retirement_failed(&error)));
            worker.close().await
        })
        .await?
    }
}
