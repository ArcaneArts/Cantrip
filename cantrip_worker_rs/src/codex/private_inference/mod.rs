//! The private inference protocol over one owned Codex app-server session.
//! A delivered control is distinct from its observable RPC result and settlement.
mod goal_cycle;
mod pending;
mod producer;
mod resources;
pub(in crate::codex) use producer::Attempt as GoalAttempt;
mod wire;

use super::{
    admission::{Adapter, NativeRequest, TaskDispatch, TaskQueued},
    revocation::Resource,
    rpc_protocol::is_private_inference,
    session::{Event, EventKind, Session},
    task_pause::Root as TaskRoot,
    turn::task::cycle::GoalCycle,
};
use crate::{
    inference::{
        admission::{Complete, Promise},
        withdrawal::Withdrawal,
    },
    metadata::{Abort, Signal},
};
use anyhow::{Result, anyhow, bail};
use cantrip_history::projection::Work;
use cantrip_transport::lifecycle::owned;
use cantrip_wire::{JsString, Value};
use indexmap::IndexMap;
use pending::FirstInputDispatch;
pub use pending::{FirstInput, Pending};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;
use wire::Control;
pub use wire::{Gate, Key, Phase};

/// The managed runtime supplies the existing overlay and canonical Task ports.
/// The router owns the actual native permission requests and their receipts.
#[derive(Default)]
pub struct Context {
    pub chat_id: Option<Value>,
    pub project_id: Option<Value>,
    pub resource_signal: Option<Signal>,
    pub task_goal_cycle: Option<Value>,
    pub first_input: Option<FirstInput>,
    pub is_paused: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    pub on_task_goal_queued: Option<TaskQueued>,
    pub on_task_goal_dispatch: Option<TaskDispatch>,
}

pub type Overlay = Arc<dyn Fn(&Gate) -> Context + Send + Sync>;
pub type Provider = Arc<dyn Fn() -> Option<Value> + Send + Sync>;
pub type BeforeInference = Arc<dyn Fn(Gate, Signal) -> Work<()> + Send + Sync>;

pub struct Hooks {
    pub overlay: Overlay,
    pub provider: Provider,
    /// Prepare the native boundary and await any canonical private Task resume.
    pub before_inference: Option<BeforeInference>,
}

pub enum Routing {
    Pass,
    Observe(Work<()>),
    Private(Work<()>),
}

#[derive(Default)]
struct PendingState {
    entries: IndexMap<JsString, Pending>,
    stopped: bool,
}

struct Inner {
    session: Session,
    generation: String,
    adapter: Adapter,
    hooks: Hooks,
    timeout: Duration,
    pending: Mutex<PendingState>,
    task_goals: Mutex<HashMap<JsString, TaskGoalRoot>>,
    task_roots: Mutex<HashMap<JsString, TaskRoot>>,
    producers: Mutex<producer::Producers>,
    resources: Mutex<HashMap<JsString, Arc<Resource>>>,
    version: watch::Sender<u64>,
}

struct TaskGoalRoot {
    runner: JsString,
    message: Option<JsString>,
    input: FirstInput,
    cycle: Option<Arc<GoalCycle>>,
}

#[derive(Clone)]
pub struct Router(Arc<Inner>);

impl Router {
    pub fn new(session: Session, adapter: Adapter, hooks: Hooks) -> Result<Self> {
        let generation = session
            .generation()
            .ok_or_else(|| anyhow!("Native inference owner disconnected."))?
            .to_owned();
        Ok(Self(Arc::new(Inner {
            session,
            generation,
            adapter,
            hooks,
            timeout: Duration::from_secs(120),
            pending: Mutex::new(PendingState::default()),
            task_goals: Mutex::new(HashMap::new()),
            task_roots: Mutex::new(HashMap::new()),
            producers: Mutex::default(),
            resources: Mutex::default(),
            version: watch::channel(0).0,
        })))
    }

    pub fn generation(&self) -> &str {
        &self.0.generation
    }

    /// Start routing synchronously, leaving the event consumer free to receive
    /// cancel and finish while a grant, producer hold or reply is pending.
    pub fn route(&self, event: &Event) -> Routing {
        if event.generation != self.0.generation {
            return Routing::Private(done(Ok(())));
        }
        match &event.kind {
            EventKind::Message(message) => {
                if is_private_inference(message) {
                    let this = self.clone();
                    let params = message["params"].clone();
                    return Routing::Private(owned(async move { this.handle(params).await }));
                }
                if message["method"] == "thread/managedExecution/requested" {
                    let this = self.clone();
                    let request = message["params"].clone();
                    return Routing::Private(owned(async move { this.producer(request).await }));
                }
                if message["method"] == "thread/managedExecution/declined" {
                    return Routing::Private(done(self.producer_declined(&message["params"])));
                }
                if matches!(
                    message["method"].as_str(),
                    Some("turn/started" | "turn/completed")
                ) {
                    return Routing::Observe(done(
                        self.0
                            .adapter
                            .observe(message["method"].as_str().unwrap(), &message["params"]),
                    ));
                }
                Routing::Pass
            }
            EventKind::TransportLost(_) => Routing::Observe(done(self.observation_lost())),
            EventKind::ProcessExited(_) => {
                // Only the owned Session may establish that the native process
                // is gone. Its observer can never turn socket loss into exit.
                if !self.0.session.process_exited() {
                    return Routing::Observe(done(Err(anyhow!(
                        "Native process exit has not been confirmed."
                    ))));
                }
                let lost = self.observation_lost();
                let fenced = self.0.adapter.process_exited();
                Routing::Observe(owned(async {
                    fenced.await?;
                    lost
                }))
            }
        }
    }

    /// Join the same retirement when explicit Session.close reaped the process
    /// before the observation loop saw the native exit event.
    pub fn close(&self) -> Work<()> {
        let this = self.clone();
        owned(async move {
            let lost = this.observation_lost();
            this.0.session.close().await?;
            if !this.0.session.process_exited() {
                bail!("Native process exit has not been confirmed.");
            }
            this.0.adapter.process_exited().await?;
            lost
        })
    }

    pub fn pending(&self) -> Vec<Pending> {
        self.0
            .pending
            .lock()
            .unwrap()
            .entries
            .values()
            .cloned()
            .collect()
    }

    pub(super) fn set_task_root(&self, thread: &JsString, root: Option<TaskRoot>) {
        let mut roots = self.0.task_roots.lock().unwrap();
        if let Some(root) = root {
            roots.insert(thread.clone(), root);
        } else {
            roots.remove(thread);
        }
    }

    fn task_root(&self, gate: &Gate) -> Option<TaskRoot> {
        self.0
            .task_roots
            .lock()
            .unwrap()
            .get(gate.root_thread())
            .filter(|root| {
                gate.root_thread() != &gate.key.thread_id
                    || root.runner == gate.key.runner_generation
            })
            .cloned()
    }

    pub(crate) fn reserve_task_first_input(
        &self,
        thread: JsString,
        runner: JsString,
        message: JsString,
    ) {
        let mut inputs = self.0.task_goals.lock().unwrap();
        if inputs
            .get(&thread)
            .is_some_and(|input| input.runner == runner && input.message.as_ref() == Some(&message))
        {
            return;
        }
        inputs.insert(
            thread,
            TaskGoalRoot {
                runner,
                message: Some(message),
                input: FirstInput::default(),
                cycle: None,
            },
        );
    }

    pub(crate) fn task_first_input(
        &self,
        thread: &JsString,
        runner: &JsString,
        message: &JsString,
    ) -> Result<FirstInput> {
        self.assert_transport()?;
        self.0
            .task_goals
            .lock()
            .unwrap()
            .get(thread)
            .filter(|input| {
                &input.runner == runner
                    && input.message.as_ref() == Some(message)
                    && input.cycle.is_none()
            })
            .map(|input| input.input.clone())
            .ok_or_else(|| anyhow!("The native Goal first input was superseded."))
    }

    pub(in crate::codex) fn activate_task_goal_cycle(
        &self,
        thread: &JsString,
        first: &FirstInput,
        cycle: Arc<GoalCycle>,
    ) {
        if let Some(input) = self.0.task_goals.lock().unwrap().get_mut(thread)
            && input.input.same(first)
            && input.cycle.is_none()
        {
            input.cycle = Some(cycle);
        }
    }

    pub fn changes(&self) -> watch::Receiver<u64> {
        self.0.version.subscribe()
    }

    pub fn is_current(&self, pending: &Pending) -> bool {
        self.0.session.generation() == Some(self.generation())
            && self
                .0
                .pending
                .lock()
                .unwrap()
                .entries
                .get(&pending.gate().key.attempt_id)
                .is_some_and(|entry| entry.same(pending))
    }

    /// Read Core's exact pending claim. A caller still has to check ownership of
    /// its server-authorized Task context before applying a producer or Pause.
    pub fn claim(&self, pending: &Pending) -> Work<Value> {
        let this = self.clone();
        let pending = pending.clone();
        owned(async move {
            if !this.is_current(&pending) {
                bail!("The actual native inference request is no longer pending.");
            }
            let receipt = this.request_claim(pending.gate()).await?;
            if !this.is_current(&pending) {
                bail!("The actual native inference request is no longer pending.");
            }
            Ok(receipt)
        })
    }

    /// Re-read the actual pending claim after taking the root producer hold.
    /// The caller verifies its canonical root and confirmed hold after the RPC.
    pub fn deny_for_first_input(
        &self,
        pending: &Pending,
        assert_hold: impl FnOnce() -> Result<()> + Send + 'static,
    ) -> Work<bool> {
        let this = self.clone();
        let pending = pending.clone();
        owned(async move {
            let gate = pending.gate();
            if gate.phase != Phase::Begin
                || gate.goal_epoch.is_none()
                || gate.root_thread() != &gate.key.thread_id
                || pending.signal().check().is_err()
            {
                return Ok(false);
            }
            let claim = this.claim(&pending).await?;
            assert_hold()?;
            if claim["claimed"] != true
                || claim["inferenceOnly"] != true
                || claim["goalEpoch"].as_js_string() != gate.goal_epoch.as_ref()
                || !this.is_current(&pending)
                || pending.signal().check().is_err()
            {
                return Ok(false);
            }
            pending.abort(FirstInputDispatch.into());
            pending.denied().await?;
            Ok(true)
        })
    }

    pub fn pause_pending_root(&self, thread: JsString) -> Work<Option<JsString>> {
        let this = self.clone();
        owned(async move {
            for pending in this.pending() {
                let gate = pending.gate();
                if gate.root_thread() != &thread
                    || gate.key.thread_id != thread
                    || matches!(gate.phase, Phase::BeginIndependent | Phase::Suspend)
                    || pending.signal().check().is_err()
                {
                    continue;
                }
                let proof = this.0.adapter.pause_native_wait(
                    &gate.key.thread_id,
                    &gate.key.turn_id,
                    &gate.scope_id,
                )?;
                if proof.parked && !proof.independent {
                    return Ok(Some(gate.key.turn_id.clone()));
                }
                if gate.phase != Phase::Begin || proof.independent {
                    continue;
                }
                let receipt = this.claim(&pending).await?;
                if receipt["claimed"] == true
                    && receipt["inferenceOnly"] == true
                    && pending.signal().check().is_ok()
                    && this.is_current(&pending)
                    && this
                        .0
                        .adapter
                        .pause_initial_native_boundary(&thread, &gate.key.turn_id)?
                {
                    return Ok(Some(gate.key.turn_id.clone()));
                }
            }
            Ok(None)
        })
    }

    async fn handle(&self, raw: Value) -> Result<()> {
        let key = Key::parse(&raw)?;
        let control = match Control::parse(&key, &raw) {
            Ok(control) => control,
            Err(_) => return self.resolve(&key, None).await,
        };
        match control {
            Control::Cancel { scope, request } => {
                if let Some(request) = request.filter(|request| !request.is_empty()) {
                    let pending = self
                        .0
                        .pending
                        .lock()
                        .unwrap()
                        .entries
                        .get(&request)
                        .cloned();
                    if let Some(pending) = pending.filter(|pending| pending.matches(&key, &scope)) {
                        pending.abort(anyhow!(
                            "The actual native inference request was cancelled."
                        ));
                        self.0
                            .adapter
                            .cancel_native_wait(&key.thread_id, &key.turn_id, &scope)?;
                        pending.deny(Ok(()));
                    }
                    self.0.adapter.reject_native_begin(
                        &key.thread_id,
                        &key.turn_id,
                        &scope,
                        &request,
                        Some(&key.runner_generation),
                    )?;
                }
                Ok(())
            }
            Control::Finish {
                scope,
                failed_before_output,
            } => {
                for pending in self
                    .pending()
                    .iter()
                    .filter(|pending| pending.matches(&key, &scope))
                {
                    pending.abort(anyhow!("The actual native inference scope completed."));
                }
                self.0.adapter.finish_native(
                    &key.thread_id,
                    &key.turn_id,
                    &scope,
                    failed_before_output,
                )
            }
            Control::Gate(gate) => {
                self.assert_transport()?;
                self.handle_gate(gate).await
            }
        }
    }

    async fn handle_gate(&self, gate: Gate) -> Result<()> {
        if self
            .0
            .pending
            .lock()
            .unwrap()
            .entries
            .contains_key(&gate.key.attempt_id)
        {
            return Ok(());
        }
        let context = (self.0.hooks.overlay)(&gate);
        let first_input = if gate.phase == Phase::Begin
            && gate.root_thread() == &gate.key.thread_id
            && gate.goal_epoch.is_some()
        {
            self.0
                .task_goals
                .lock()
                .unwrap()
                .get(&gate.key.thread_id)
                .filter(|input| input.runner == gate.key.runner_generation && input.cycle.is_none())
                .map(|input| input.input.clone())
                .or_else(|| context.first_input.clone())
        } else {
            None
        };
        let pending = Pending::new(gate.clone(), first_input);
        {
            let mut state = self.0.pending.lock().unwrap();
            if state.stopped {
                bail!("Native inference owner disconnected.");
            }
            let entries = &mut state.entries;
            if entries.contains_key(&gate.key.attempt_id) {
                return Ok(());
            }
            entries.insert(gate.key.attempt_id.clone(), pending.clone());
        }
        self.changed();
        let resource = self.resource(gate.root_thread());
        let signal = Signal::any(
            [
                Some(pending.signal()),
                context.resource_signal,
                resource.as_ref().map(|resource| resource.signal.clone()),
            ]
            .into_iter()
            .flatten()
            .collect(),
        );
        let result = self
            .allow_gate(&gate, &pending, &signal, resource.as_deref())
            .await;
        let result = match result {
            Ok(()) => Ok(()),
            Err(error) => {
                if let Some(withdrawal) = Withdrawal::in_error(&error) {
                    let _ = withdrawal.wait(Some(signal.clone())).await;
                }
                match self.resolve(&gate.key, None).await {
                    Ok(()) => {
                        let settled = if gate.phase.is_begin() {
                            self.0.adapter.reject_native_begin(
                                &gate.key.thread_id,
                                &gate.key.turn_id,
                                &gate.scope_id,
                                &gate.key.attempt_id,
                                Some(&gate.key.runner_generation),
                            )
                        } else {
                            Ok(())
                        };
                        let denied = settled.is_ok();
                        pending.deny(settled);
                        if denied && error.chain().any(|cause| cause.is::<FirstInputDispatch>()) {
                            Ok(())
                        } else {
                            Err(error)
                        }
                    }
                    Err(denial) => {
                        pending.deny(Err(denial));
                        Err(error)
                    }
                }
            }
        };
        pending.deny(Err(anyhow!(
            "The native begin ended without a negative resolve receipt."
        )));
        let removed = {
            let mut state = self.0.pending.lock().unwrap();
            let entries = &mut state.entries;
            if entries
                .get(&gate.key.attempt_id)
                .is_some_and(|entry| entry.same(&pending))
            {
                entries.shift_remove(&gate.key.attempt_id);
                true
            } else {
                false
            }
        };
        if removed {
            self.changed();
        }
        result
    }

    async fn allow_gate(
        &self,
        gate: &Gate,
        pending: &Pending,
        signal: &Signal,
        resource: Option<&Resource>,
    ) -> Result<()> {
        signal.check()?;
        if let Some(first_input) = pending.first_input() {
            if !first_input.dispatching() {
                return Err(signal.cancelled().await.into());
            }
            return Err(FirstInputDispatch.into());
        }
        let task = self.task_root(gate);
        if gate.phase != Phase::Suspend {
            if let Some(task) = &task {
                task.latch.wait(signal).await?;
            }
            if let Some(before) = &self.0.hooks.before_inference {
                before(gate.clone(), signal.clone()).await?;
            }
        }
        signal.check()?;
        match gate.phase {
            Phase::Begin | Phase::BeginIndependent => {
                let context = (self.0.hooks.overlay)(gate);
                let provider = (self.0.hooks.provider)()
                    .ok_or_else(|| anyhow!("Native inference has no configured provider."))?;
                let cycle = self.task_goal_cycle(gate);
                if task.is_some()
                    && gate.phase == Phase::Begin
                    && gate.root_thread() == &gate.key.thread_id
                    && gate.goal_epoch.is_some()
                    && cycle.is_none()
                    && context.task_goal_cycle.is_none()
                {
                    bail!("The native Task Goal has no canonical dispatch owner.");
                }
                let dispatch = cycle.as_ref().map(|cycle| {
                    self.goal_dispatch(
                        cycle.clone(),
                        pending.clone(),
                        signal.clone(),
                        provider.clone(),
                    )
                });
                let placement = cycle.as_ref().map(|cycle| {
                    let mut placement = cycle.placement();
                    if let Some(task) = &task {
                        let epoch = task.latch.order_epoch(&task.binding, &placement["cycleId"]);
                        if epoch > placement["orderEpoch"].as_u64().unwrap_or(0) {
                            placement["orderEpoch"] = cantrip_wire::value::json!(epoch);
                        }
                    }
                    placement
                });
                let paused = task.as_ref().map(|root| {
                    let latch = root.latch.clone();
                    Arc::new(move || latch.current().blocked) as Arc<dyn Fn() -> bool + Send + Sync>
                });
                let this = self.clone();
                let pending = pending.clone();
                self.0
                    .adapter
                    .enter_native(NativeRequest {
                        gate_attempt_id: gate.key.attempt_id.clone(),
                        confirm_ownership: Arc::new(move || this.claim(&pending)),
                        goal_epoch: gate.goal_epoch.clone(),
                        runner_generation: Some(gate.key.runner_generation.clone()),
                        task_goal_cycle: placement.or_else(|| {
                            (gate.root_thread_id.as_ref() == Some(&gate.key.thread_id))
                                .then_some(context.task_goal_cycle)
                                .flatten()
                        }),
                        on_task_goal_queued: cycle
                            .as_ref()
                            .map(|cycle| self.goal_enqueue(cycle.clone()))
                            .or(context.on_task_goal_queued),
                        on_task_goal_dispatch: dispatch.or(context.on_task_goal_dispatch),
                        thread_id: gate.key.thread_id.clone(),
                        turn_id: gate.key.turn_id.clone(),
                        scope_id: gate.scope_id.clone(),
                        provider,
                        signal: signal.clone(),
                        is_paused: paused.or(context.is_paused),
                        root_thread_id: gate.root_thread_id.clone(),
                        chat_id: cycle
                            .as_ref()
                            .map(|cycle| cantrip_wire::value::json!(cycle.key.2))
                            .or_else(|| task.as_ref().map(|root| root.binding["chatId"].clone()))
                            .or_else(|| {
                                resource.map(|resource| cantrip_wire::value::json!(resource.chat))
                            })
                            .or(context.chat_id),
                        project_id: cycle
                            .as_ref()
                            .map(|cycle| cycle.project.clone())
                            .or_else(|| task.as_ref().map(|root| root.binding["projectId"].clone()))
                            .or_else(|| {
                                resource.and_then(|resource| {
                                    resource
                                        .project
                                        .as_ref()
                                        .map(|id| cantrip_wire::value::json!(id))
                                })
                            })
                            .or(context.project_id),
                        independent: gate.phase == Phase::BeginIndependent,
                    })
                    .await?;
            }
            Phase::Suspend => self.0.adapter.suspend_native(
                &gate.key.thread_id,
                &gate.key.turn_id,
                &gate.scope_id,
            )?,
            Phase::Resume => {
                self.0
                    .adapter
                    .resume_native(&gate.key.thread_id, &gate.key.turn_id, &gate.scope_id)
                    .await?
            }
        }
        signal.check()?;
        self.resolve(&gate.key, Some(&gate.scope_id)).await
    }

    async fn request_claim(&self, gate: &Gate) -> Result<Value> {
        let receipt = self
            .request(
                "thread/managedExecution/inferenceClaim",
                gate.claim_params(),
            )
            .await?;
        wire::verify_claim(receipt)
    }

    async fn resolve(&self, key: &Key, scope: Option<&JsString>) -> Result<()> {
        let receipt = self
            .request("thread/managedExecution/resolve", key.resolve_params(scope))
            .await?;
        if receipt["accepted"] != true {
            bail!("Core returned an invalid managed execution resolution.");
        }
        Ok(())
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.assert_transport()?;
        let receipt = self
            .0
            .session
            .request(method.into(), Some(params), Some(self.0.timeout), None)
            .await?;
        self.assert_transport()?;
        Ok(receipt.unwrap_or(Value::Null))
    }

    fn assert_transport(&self) -> Result<()> {
        if self.0.session.generation() != Some(self.generation()) {
            bail!("The managed execution runner belongs to a replaced native transport.");
        }
        Ok(())
    }

    fn observation_lost(&self) -> Result<()> {
        let pending = {
            let mut state = self.0.pending.lock().unwrap();
            state.stopped = true;
            std::mem::take(&mut state.entries)
        };
        if !pending.is_empty() {
            self.changed();
        }
        for (_, entry) in pending {
            entry.abort(anyhow!("Native inference owner disconnected."));
            entry.deny(Err(anyhow!("Native inference owner disconnected.")));
        }
        self.0.adapter.observation_lost()
    }

    fn changed(&self) {
        self.0
            .version
            .send_modify(|version| *version = version.wrapping_add(1));
    }
}

fn done<T: Send + 'static>(result: Result<T>) -> Work<T> {
    Box::pin(async move { result })
}
