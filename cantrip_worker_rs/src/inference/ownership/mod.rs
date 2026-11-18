//! Worker client for the existing Codex native lifetime keeper. The keeper's
//! OS locks remain authoritative; this client does not replace them with PIDs.
mod helper;
mod ipc;
mod lifetime;
use anyhow::{Result, anyhow, bail};
use cantrip_history::projection::Work;
use cantrip_wire::{JsString, Value, value::json};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use helper::Helper;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
#[derive(Clone)]
pub struct Scope {
    pub server_id: JsString,
    pub owner_id: JsString,
    pub worker_id: JsString,
    pub worker_generation: JsString,
}
#[derive(Clone)]
pub struct Options {
    pub cwd: PathBuf,
    pub environment: HashMap<String, String>,
    pub report: Arc<dyn Fn(JsString) -> Result<()> + Send + Sync>,
    pub ack_timeout: Duration,
    pub journal_timeout: Duration,
}
impl Options {
    fn report_error(&self, message: JsString) {
        let _ = (self.report)(message);
    }
    pub fn local(cwd: PathBuf, environment: HashMap<String, String>) -> Self {
        Self {
            cwd,
            environment,
            report: Arc::new(|_| Ok(())),
            ack_timeout: Duration::from_secs(120),
            journal_timeout: Duration::from_secs(30),
        }
    }
}
pub type Response = Option<Value>;
pub type LostListener = Arc<dyn Fn() -> Result<()> + Send + Sync>;
type Claim = Shared<BoxFuture<'static, std::result::Result<(), Arc<JsString>>>>;
struct Keeper {
    id: String,
    helper: Helper,
    activated: bool,
}
#[derive(Default)]
struct State {
    keeper: Option<Keeper>,
    owner: Option<(String, Claim)>,
    listeners: Vec<LostListener>,
    journal: std::collections::VecDeque<(Value, tokio::sync::oneshot::Sender<Result<Response>>)>,
    sending: bool,
}
struct Inner {
    binary: PathBuf,
    directory: PathBuf,
    scope: Scope,
    options: Options,
    state: Mutex<State>,
    owned: AtomicBool,
    closed: AtomicBool,
}
#[derive(Clone)]
pub struct Owner(Arc<Inner>);
impl Owner {
    pub fn new(binary: PathBuf, data: &Path, scope: Scope, mut options: Options) -> Self {
        options.environment.retain(|key, _| {
            ![
                "CANTRIP_INFERENCE_SCOPE",
                "CANTRIP_INFERENCE_GENERATION",
                "CANTRIP_INFERENCE_RUNTIME",
            ]
            .iter()
            .any(|name| {
                if cfg!(windows) {
                    key.eq_ignore_ascii_case(name)
                } else {
                    key == name
                }
            })
        });
        let key = super::identity::digest(&json!([
            scope.server_id.clone(),
            scope.owner_id.clone(),
            scope.worker_id.clone()
        ]));
        let directory =
            cantrip_config::resolve(&options.cwd, &data.join("inference-ownership").join(key));
        Self(Arc::new(Inner {
            binary,
            directory,
            scope,
            options,
            state: Mutex::new(State::default()),
            owned: AtomicBool::new(false),
            closed: AtomicBool::new(false),
        }))
    }
    pub fn directory(&self) -> &Path {
        &self.0.directory
    }
    pub fn available(&self) -> bool {
        !self.0.closed.load(Ordering::Acquire) && self.0.owned.load(Ordering::Acquire)
    }
    pub fn on_lost(&self, listener: LostListener) {
        let mut state = self.0.state.lock().unwrap();
        if !state
            .listeners
            .iter()
            .any(|existing| Arc::ptr_eq(existing, &listener))
        {
            state.listeners.push(listener);
        }
    }
    fn arguments(&self, extra: Vec<String>) -> Vec<String> {
        let mut arguments = vec![
            "cantrip-runtime-owner".into(),
            "--scope".into(),
            self.0.directory.to_string_lossy().into_owned(),
            "--generation".into(),
            self.0.scope.worker_generation.lossy().into_owned(),
        ];
        arguments.extend(extra);
        arguments
    }
    async fn ensure_owner(&self) -> Result<()> {
        if self.0.closed.load(Ordering::Acquire) {
            bail!("Native inference ownership is closed.");
        }
        let (id, claim) = {
            let mut state = self.0.state.lock().unwrap();
            if let Some(owner) = &state.owner {
                owner.clone()
            } else {
                let id = uuid::Uuid::new_v4().to_string();
                let this = self.clone();
                // `owned` polls its synchronous prefix immediately. Claim also
                // takes this state lock, so start it on the executor instead.
                // The task retains the accepted claim if a waiter disappears.
                let work = tokio::spawn(async move { this.claim().await });
                let shared = async move {
                    work.await
                        .map_err(|_| Arc::new(JsString::from("Native ownership claim stopped.")))?
                        .map_err(|error| Arc::new(crate::error::message(&error)))
                }
                .boxed()
                .shared();
                state.owner = Some((id.clone(), shared.clone()));
                (id, shared)
            }
        };
        if let Err(error) = claim.await {
            let mut state = self.0.state.lock().unwrap();
            if !self.0.closed.load(Ordering::Acquire)
                && state.keeper.is_none()
                && state.owner.as_ref().is_some_and(|v| v.0 == id)
            {
                state.owner = None;
            }
            return Err(crate::error::WireError((*error).clone()).into());
        }
        Ok(())
    }
    async fn claim(&self) -> Result<()> {
        let helper = {
            let mut state = self.0.state.lock().unwrap();
            if self.0.closed.load(Ordering::Acquire) {
                bail!("Native inference ownership is closed.");
            }
            let weak = Arc::downgrade(&self.0);
            let id = uuid::Uuid::new_v4().to_string();
            let observed = id.clone();
            let on_closed = Arc::new(move || {
                let Some(owner) = weak.upgrade() else {
                    return;
                };
                let listeners = {
                    let mut state = owner.state.lock().unwrap();
                    if state
                        .keeper
                        .as_ref()
                        .is_none_or(|keeper| keeper.id != observed)
                    {
                        return;
                    }
                    let keeper = state.keeper.take().unwrap();
                    owner.owned.store(false, Ordering::Release);
                    if !keeper.activated {
                        return;
                    }
                    state.listeners.clone()
                };
                for listener in listeners {
                    if let Err(error) = listener() {
                        owner.options.report_error(crate::error::message(&error));
                    }
                }
                if !owner.closed.load(Ordering::Acquire) {
                    owner
                        .options
                        .report_error("Native inference ownership keeper exited.".into());
                }
            });
            let helper = Helper::spawn(
                &self.0.binary,
                self.arguments(vec![]),
                &self.0.options,
                self.0.scope.worker_generation.clone(),
                false,
                on_closed,
            )?;
            state.keeper = Some(Keeper {
                id,
                helper: helper.clone(),
                activated: false,
            });
            helper
        };
        if let Err(error) = helper.acknowledged().await {
            let _ = helper.close().await;
            return Err(error);
        }
        let mut state = self.0.state.lock().unwrap();
        if helper.has_exited() {
            bail!("Native inference ownership keeper exited during claim.");
        }
        if self.0.closed.load(Ordering::Acquire) {
            bail!("Native inference ownership closed during claim.");
        }
        if let Some(keeper) = state.keeper.as_mut() {
            keeper.activated = true;
        }
        self.0.owned.store(true, Ordering::Release);
        Ok(())
    }
}
