use super::*;
use crate::{
    encryption::Service,
    inference::{admission::Options as AdmissionOptions, ownership},
};
use futures::future::join_all;

pub type Binding = Arc<dyn Fn() -> Result<(JsString, JsString)> + Send + Sync>;

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
}

#[derive(Clone)]
struct Slot {
    ready: Promise<Runtime>,
    home: Home,
}

#[derive(Default)]
struct State {
    managers: HashMap<Scope, Manager>,
    runtimes: HashMap<Key, Slot>,
    closing: Option<Promise<()>>,
}

struct Inner {
    host: Host,
    data: PathBuf,
    worker_id: JsString,
    worker_generation: JsString,
    binding: Binding,
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

    pub fn launch(&self, launch: Launch) -> Work<Runtime> {
        let this = self.clone();
        owned(async move {
            let scope = this.scope()?;
            let key = Key {
                scope,
                profile: launch.profile.id.clone(),
            };
            let home = Home {
                runtime: cantrip_config::resolve(&this.0.host.cwd, &launch.profile.codex_home),
                configuration: launch
                    .profile
                    .configuration_home
                    .as_ref()
                    .map(|home| cantrip_config::resolve(&this.0.host.cwd, home)),
            };
            loop {
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
                        };
                        state.runtimes.insert(key.clone(), slot.clone());
                        (slot, Some((complete, manager)))
                    }
                };
                if let Some((complete, manager)) = start {
                    let runtime = Runtime::launch(this.0.host.clone(), manager, launch).await;
                    if runtime.is_err() {
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
                this.remove(&key, &slot);
            }
        })
    }

    async fn ready_runtime(&self, key: &Key, slot: &Slot, runtime: Runtime) -> Result<Runtime> {
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
