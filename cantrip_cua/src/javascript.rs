//! The JavaScript owner never runs native work. Host promises rendezvous with
//! the worker, which authorizes and sends ordinary native requests separately.
use crate::{
    cancellation::Cancellation,
    cursor::CursorAppearance,
    error::{CuaError, ErrorCode, Result},
    protocol::{Message, Outcome},
    runtime::{Pending, Work, emit, frame},
    service::SessionBinding,
    target::{MAX_SEQUENCE, Point, validate_id},
};
use rquickjs::{
    Context, Exception, Function, Persistent, Promise, Runtime, context::intrinsic,
    promise::PromiseState,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    io,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

const MAX_CONTEXTS: usize = 4;
const MAX_SOURCE: usize = 32 * 1024;
const MAX_OUTPUT: usize = 32 * 1024;
const MAX_HOST_CALLS: u64 = 64;
const MAX_HEAP: usize = 8 * 1024 * 1024;
const ACTIVE_LIMIT: Duration = Duration::from_secs(2);
#[cfg(test)]
const WALL_LIMIT: Duration = Duration::from_secs(45);
const MAX_WALL_TIMEOUT_MS: u64 = 345_000;
pub(crate) fn default_wall_timeout_ms() -> u64 {
    45_000
}
const JOB_BATCH: usize = 16;
const MAX_JOBS: u32 = 10_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetReference {
    target_id: String,
    target_generation: u64,
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
enum HostAction {
    State {},
    Targets {
        #[serde(default, deserialize_with = "crate::inventory::deserialize_cursor")]
        after: Option<String>,
    },
    Attach {
        target: TargetReference,
    },
    Snapshot {},
    Cursor {},
    ConfigureCursor {
        appearance: CursorAppearance,
    },
    MoveCursor {
        point: Point,
    },
    Detach {},
}

fn validate_action(source: &str) -> Result<Value> {
    if source.len() > MAX_SOURCE {
        return Err(capacity());
    }
    let action: HostAction = serde_json::from_str(source).map_err(|_| script_error())?;
    match action {
        HostAction::Targets { after: Some(after) } => validate_id(&after)?,
        HostAction::Attach { target } => {
            validate_id(&target.target_id)?;
            if !(1..=MAX_SEQUENCE).contains(&target.target_generation) {
                return Err(script_error());
            }
        }
        HostAction::ConfigureCursor { appearance } => appearance.validate()?,
        HostAction::MoveCursor { point }
            if !point.x.is_finite() || !point.y.is_finite() || point.x < 0.0 || point.y < 0.0 =>
        {
            return Err(script_error());
        }
        _ => {}
    }
    serde_json::from_str(source).map_err(|_| script_error())
}

fn script_error() -> CuaError {
    CuaError::invalid("JavaScript evaluation failed.")
}
fn capacity() -> CuaError {
    CuaError::new(ErrorCode::Capacity, "JavaScript execution limit exceeded.")
}
fn cancelled() -> CuaError {
    CuaError::new(ErrorCode::Cancelled, "JavaScript evaluation was cancelled.")
}

const BOOTSTRAP: &str = r#"
// TypedArrays also installs shared-memory intrinsics in QuickJS. They are not
// exposed: Atomics.wait can block C without the JavaScript interrupt handler.
for (const name of ['SharedArrayBuffer', 'Atomics', 'WeakRef', 'FinalizationRegistry']) {
  Object.defineProperty(globalThis, name, {value:undefined, writable:false, configurable:false});
}
((host, stringify) => {
  const call = action => host(stringify(action));
  Object.defineProperty(globalThis, 'cua', { value: Object.freeze({
    getState: () => call({operation:'state'}),
    targets: (options = {}) => {
      if (options === null || typeof options !== 'object' || Array.isArray(options) ||
          Object.keys(options).some(key => key !== 'after') ||
          ('after' in options && typeof options.after !== 'string')) throw new Error('Invalid target page options');
      return call({operation:'targets', ...options});
    },
    attach: target => call({operation:'attach', target}),
    snapshot: () => call({operation:'snapshot'}),
    cursor: () => call({operation:'cursor'}),
    configureCursor: appearance => call({operation:'configureCursor', appearance}),
    moveCursor: point => call({operation:'moveCursor', point}),
    detach: () => call({operation:'detach'})
  }), writable:false, configurable:false });
})(globalThis.__cuaHost, JSON.stringify);
delete globalThis.__cuaHost;
"#;

struct HostPending {
    call_id: u64,
    resolve: Persistent<Function<'static>>,
    reject: Persistent<Function<'static>>,
}
struct Bridge {
    evaluation_id: Option<u64>,
    calls: u64,
    pending: Option<HostPending>,
    fault: Rc<Cell<Option<ErrorCode>>>,
}
#[derive(Clone, Copy, Default)]
struct ActiveClock {
    elapsed: Duration,
    entered: Option<Instant>,
}
impl ActiveClock {
    fn elapsed(self) -> Duration {
        self.elapsed
            + self
                .entered
                .map(|instant| instant.elapsed())
                .unwrap_or_default()
    }
}
struct Evaluation {
    id: u64,
    cancellation: Cancellation,
    started: Instant,
    wall_limit: Duration,
    clock: Rc<Cell<ActiveClock>>,
    promise: Persistent<Promise<'static>>,
    jobs: Cell<u32>,
}

// Field order is deliberate: persistent roots/resolvers must be destroyed
// before Context and Runtime. dispose() also explicitly breaks pending roots.
struct Session {
    active: Option<Evaluation>,
    bridge: Rc<RefCell<Bridge>>,
    context: Context,
    runtime: Runtime,
    binding: SessionBinding,
}

impl Session {
    fn new(
        binding: SessionBinding,
        frames: crossbeam_channel::Sender<crate::protocol::Frame>,
    ) -> Result<Self> {
        let runtime = Runtime::new().map_err(|_| capacity())?;
        runtime.set_memory_limit(MAX_HEAP);
        runtime.set_max_stack_size(256 * 1024);
        // No WeakRef intrinsic: finalizers must not introduce automatic work
        // between evaluations. No module loader or native host I/O is installed.
        let context = Context::custom::<(
            intrinsic::Date,
            intrinsic::Eval,
            intrinsic::RegExpCompiler,
            intrinsic::RegExp,
            intrinsic::Json,
            intrinsic::Proxy,
            intrinsic::MapSet,
            intrinsic::TypedArrays,
            intrinsic::Promise,
        )>(&runtime)
        .map_err(|_| capacity())?;
        let bridge = Rc::new(RefCell::new(Bridge {
            evaluation_id: None,
            calls: 0,
            pending: None,
            fault: Rc::new(Cell::new(None)),
        }));
        let weak = Rc::downgrade(&bridge);
        context
            .with(|ctx| -> rquickjs::Result<()> {
                let host = Function::new(
                    ctx.clone(),
                    move |ctx: rquickjs::Ctx<'_>,
                          source: String|
                          -> rquickjs::Result<Persistent<Promise<'static>>> {
                        let Some(bridge) = weak.upgrade() else {
                            return Err(Exception::throw_type(&ctx, "CUA context is closed."));
                        };
                        let action = match validate_action(&source) {
                            Ok(action) => action,
                            Err(error) => {
                                bridge.borrow().fault.set(Some(error.code));
                                return Err(Exception::throw_type(&ctx, "Invalid CUA action."));
                            }
                        };
                        let (evaluation_id, call_id) = {
                            let mut state = bridge.borrow_mut();
                            let Some(id) = state.evaluation_id else {
                                return Err(Exception::throw_type(
                                    &ctx,
                                    "CUA evaluation is inactive.",
                                ));
                            };
                            if state.pending.is_some() || state.calls >= MAX_HOST_CALLS {
                                state.fault.set(Some(ErrorCode::Capacity));
                                return Err(Exception::throw_type(
                                    &ctx,
                                    "CUA action limit exceeded.",
                                ));
                            }
                            state.calls += 1;
                            (id, state.calls)
                        };
                        let (promise, resolve, reject) = Promise::new(&ctx)?;
                        bridge.borrow_mut().pending = Some(HostPending {
                            call_id,
                            resolve: Persistent::save(&ctx, resolve),
                            reject: Persistent::save(&ctx, reject),
                        });
                        if emit(
                            &frames,
                            frame(Message::HostCall {
                                evaluation_request_id: evaluation_id,
                                call_id,
                                action,
                            }),
                            false,
                        )
                        .is_err()
                        {
                            let mut state = bridge.borrow_mut();
                            state.pending.take();
                            state.fault.set(Some(ErrorCode::Capacity));
                            return Err(Exception::throw_type(
                                &ctx,
                                "CUA host transport is unavailable.",
                            ));
                        }
                        Ok(Persistent::save(&ctx, promise))
                    },
                )?;
                ctx.globals().set("__cuaHost", host)?;
                ctx.eval::<(), _>(BOOTSTRAP)
            })
            .map_err(|_| script_error())?;
        Ok(Self {
            active: None,
            bridge,
            context,
            runtime,
            binding,
        })
    }

    fn enter(clock: &Cell<ActiveClock>) {
        let mut value = clock.get();
        value.entered = Some(Instant::now());
        clock.set(value);
    }
    fn leave(clock: &Cell<ActiveClock>) {
        let mut value = clock.get();
        value.elapsed = value.elapsed();
        value.entered = None;
        clock.set(value);
    }
    fn start(
        &mut self,
        id: u64,
        source: String,
        wall_timeout_ms: u64,
        cancellation: Cancellation,
    ) -> Result<()> {
        cancellation.check()?;
        if source.len() > MAX_SOURCE || !(1..=MAX_WALL_TIMEOUT_MS).contains(&wall_timeout_ms) {
            return Err(capacity());
        }
        let wall_limit = Duration::from_millis(wall_timeout_ms);
        let started = Instant::now();
        let clock = Rc::new(Cell::new(ActiveClock::default()));
        let fault = {
            let mut bridge = self.bridge.borrow_mut();
            bridge.evaluation_id = Some(id);
            bridge.calls = 0;
            bridge.fault.set(None);
            bridge.fault.clone()
        };
        let interrupt_clock = clock.clone();
        let interrupt_cancel = cancellation.clone();
        self.runtime.set_interrupt_handler(Some(Box::new(move || {
            let reason = if interrupt_cancel.is_cancelled() {
                Some(ErrorCode::Cancelled)
            } else if started.elapsed() >= wall_limit
                || interrupt_clock.get().elapsed() >= ACTIVE_LIMIT
            {
                Some(ErrorCode::Capacity)
            } else {
                fault.get()
            };
            if reason.is_some() {
                fault.set(reason);
                true
            } else {
                false
            }
        })));
        Self::enter(&clock);
        let promise = self.context.with(|ctx| {
            ctx.eval_promise(source)
                .map(|promise| Persistent::save(&ctx, promise))
        });
        Self::leave(&clock);
        self.check_budget(&cancellation, started, wall_limit, &clock)?;
        let promise = promise.map_err(|_| script_error())?;
        self.active = Some(Evaluation {
            id,
            cancellation,
            started,
            wall_limit,
            clock,
            promise,
            jobs: Cell::new(0),
        });
        Ok(())
    }
    fn check_budget(
        &self,
        cancellation: &Cancellation,
        started: Instant,
        wall_limit: Duration,
        clock: &Cell<ActiveClock>,
    ) -> Result<()> {
        cancellation.check()?;
        if started.elapsed() >= wall_limit || clock.get().elapsed() >= ACTIVE_LIMIT {
            return Err(capacity());
        }
        match self.bridge.borrow().fault.get() {
            Some(ErrorCode::Cancelled) => Err(cancelled()),
            Some(ErrorCode::Capacity) => Err(capacity()),
            Some(_) => Err(script_error()),
            None => Ok(()),
        }
    }
    fn finish_value(&self, active: &Evaluation) -> Result<Value> {
        Self::enter(&active.clock);
        let value = self
            .context
            .with(|ctx| -> rquickjs::Result<Option<String>> {
                let promise = active.promise.clone().restore(&ctx)?;
                // QuickJS's JS_EVAL_FLAG_ASYNC resolves its completion envelope
                // { value: <last expression> }, not the expression directly.
                let completion = promise
                    .result::<rquickjs::Object>()
                    .ok_or(rquickjs::Error::WouldBlock)??;
                let value: rquickjs::Value = completion.get("value")?;
                if value.is_undefined() {
                    return Ok(None);
                }
                ctx.json_stringify(value)?
                    .map(|value| value.to_string())
                    .transpose()
            });
        Self::leave(&active.clock);
        self.check_budget(
            &active.cancellation,
            active.started,
            active.wall_limit,
            &active.clock,
        )?;
        // JSON serialization can execute user getters/toJSON and enqueue more
        // jobs or host calls. None may escape into the next evaluation.
        if self.bridge.borrow().pending.is_some() || self.runtime.is_job_pending() {
            return Err(CuaError::invalid(
                "JavaScript left unfinished background work.",
            ));
        }
        let value = value.map_err(|_| script_error())?;
        let Some(value) = value else {
            return Ok(Value::Null);
        };
        if value.len() + b"{\"value\":}".len() > MAX_OUTPUT {
            return Err(capacity());
        }
        serde_json::from_str(&value).map_err(|_| script_error())
    }
    fn step(&mut self) -> Option<Result<Value>> {
        let active = self.active.as_ref()?;
        for _ in 0..JOB_BATCH {
            if let Err(error) = self.check_budget(
                &active.cancellation,
                active.started,
                active.wall_limit,
                &active.clock,
            ) {
                return Some(Err(error));
            }
            let state = self.context.with(|ctx| {
                active
                    .promise
                    .clone()
                    .restore(&ctx)
                    .map(|promise| promise.state())
            });
            match state {
                Ok(PromiseState::Pending) => {}
                Ok(_) => {
                    if self.bridge.borrow().pending.is_some() || self.runtime.is_job_pending() {
                        return Some(Err(CuaError::invalid(
                            "JavaScript left unfinished background work.",
                        )));
                    }
                    return Some(self.finish_value(active));
                }
                Err(_) => return Some(Err(script_error())),
            }
            if self.runtime.is_job_pending() && active.jobs.get() >= MAX_JOBS {
                return Some(Err(capacity()));
            }
            Self::enter(&active.clock);
            let job = self.runtime.execute_pending_job();
            Self::leave(&active.clock);
            if let Err(error) = self.check_budget(
                &active.cancellation,
                active.started,
                active.wall_limit,
                &active.clock,
            ) {
                return Some(Err(error));
            }
            match job {
                Ok(true) => active.jobs.set(active.jobs.get() + 1),
                Ok(false) => return None,
                Err(error) => {
                    drop(error);
                    return Some(Err(script_error()));
                }
            }
        }
        None
    }
    fn reply(&mut self, id: u64, call_id: u64, result: Outcome) -> Result<()> {
        let Some(active) = self.active.as_ref().filter(|active| active.id == id) else {
            return Ok(());
        };
        self.check_budget(
            &active.cancellation,
            active.started,
            active.wall_limit,
            &active.clock,
        )?;
        let pending = {
            let mut bridge = self.bridge.borrow_mut();
            if bridge
                .pending
                .as_ref()
                .is_none_or(|pending| pending.call_id != call_id)
            {
                return Ok(());
            }
            bridge.pending.take().expect("matching pending host call")
        };
        Self::enter(&active.clock);
        let settled = self.context.with(|ctx| -> rquickjs::Result<()> {
            let (function, data) = match result {
                Outcome::Ok { data } => (pending.resolve.restore(&ctx)?, data),
                Outcome::Error { error } => (
                    pending.reject.restore(&ctx)?,
                    json!({"code":error.code,"message":"CUA host operation failed."}),
                ),
            };
            let bytes = serde_json::to_vec(&data).map_err(|_| rquickjs::Error::Unknown)?;
            let value: rquickjs::Value = ctx.json_parse(bytes)?;
            function.call((value,))
        });
        Self::leave(&active.clock);
        self.check_budget(
            &active.cancellation,
            active.started,
            active.wall_limit,
            &active.clock,
        )?;
        settled.map_err(|_| script_error())
    }
    fn clear_active(&mut self) -> Option<u64> {
        let id = self.active.take().map(|active| active.id);
        let mut bridge = self.bridge.borrow_mut();
        bridge.pending.take();
        bridge.evaluation_id = None;
        self.runtime.set_interrupt_handler(None);
        id
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.clear_active();
    }
}

enum Command {
    Evaluate {
        id: u64,
        binding: SessionBinding,
        source: String,
        wall_timeout_ms: u64,
        cancellation: Cancellation,
    },
    Reset {
        id: u64,
        binding: SessionBinding,
        cancellation: Cancellation,
    },
    Close {
        binding: SessionBinding,
    },
    Reply {
        id: u64,
        call_id: u64,
        result: Outcome,
    },
    Wake,
}
type Evaluations = Arc<Mutex<HashMap<u64, (SessionBinding, Cancellation)>>>;
#[derive(Clone)]
pub(crate) struct Router {
    sender: crossbeam_channel::Sender<Command>,
    stopped: Arc<AtomicBool>,
    evaluations: Evaluations,
}
impl Router {
    pub(crate) fn evaluate(
        &self,
        id: u64,
        binding: SessionBinding,
        source: String,
        wall_timeout_ms: u64,
        cancellation: Cancellation,
    ) -> io::Result<()> {
        self.evaluations
            .lock()
            .unwrap()
            .insert(id, (binding.clone(), cancellation.clone()));
        self.send(Command::Evaluate {
            id,
            binding,
            source,
            wall_timeout_ms,
            cancellation,
        })
    }
    pub(crate) fn reset(
        &self,
        id: u64,
        binding: SessionBinding,
        cancellation: Cancellation,
    ) -> io::Result<()> {
        self.interrupt(&binding);
        self.send(Command::Reset {
            id,
            binding,
            cancellation,
        })
    }
    pub(crate) fn close(&self, binding: SessionBinding) -> io::Result<()> {
        self.interrupt(&binding);
        self.send(Command::Close { binding })
    }
    fn interrupt(&self, binding: &SessionBinding) {
        for (scope, cancellation) in self.evaluations.lock().unwrap().values() {
            if scope == binding {
                cancellation.cancel();
            }
        }
    }
    pub(crate) fn reply(&self, id: u64, call_id: u64, result: Outcome) -> io::Result<()> {
        self.send(Command::Reply {
            id,
            call_id,
            result,
        })
    }
    fn send(&self, command: Command) -> io::Result<()> {
        self.sender
            .try_send(command)
            .map_err(|_| io::Error::other("CUA JavaScript queue unavailable."))
    }
    pub(crate) fn shutdown(&self) {
        self.stopped.store(true, Ordering::Release);
        for (_, cancellation) in self.evaluations.lock().unwrap().values() {
            cancellation.cancel();
        }
        let _ = self.sender.try_send(Command::Wake);
    }

    pub(crate) fn wake(&self) {
        // A full queue is already a wake-up; cancellation never blocks the reader.
        let _ = self.sender.try_send(Command::Wake);
    }
}

pub(crate) fn spawn(
    frames: crossbeam_channel::Sender<crate::protocol::Frame>,
    pending: Pending,
    native: mpsc::Sender<Work>,
) -> io::Result<(Router, mpsc::Receiver<()>)> {
    let (sender, receiver) = crossbeam_channel::bounded(64);
    let router = Router {
        sender,
        stopped: Arc::new(AtomicBool::new(false)),
        evaluations: Arc::new(Mutex::new(HashMap::new())),
    };
    let control = router.clone();
    let (done_tx, done_rx) = mpsc::sync_channel(1);
    std::thread::Builder::new().name("cantrip-cua-javascript".into()).spawn(move || {
        let mut sessions: HashMap<String, Session> = HashMap::new();
        let respond = |id: u64, result: Result<Value>| -> io::Result<()> {
            let result = match result { Ok(data) => Outcome::Ok { data }, Err(error) => Outcome::Error { error } };
            let sent = emit(&frames, frame(Message::Response { request_id: id, result }), true);
            pending.lock().unwrap().remove(&id);
            control.evaluations.lock().unwrap().remove(&id);
            sent
        };
        let result: io::Result<()> = (|| {
            loop {
                for key in sessions.keys().cloned().collect::<Vec<_>>() {
                    let session = sessions.get_mut(&key).expect("owned session");
                    if let Some(result) = session.step() {
                        let discard = result.is_err();
                        let id = session.clear_active().expect("completed evaluation");
                        if discard { sessions.remove(&key); }
                        respond(id, result.map(|value| json!({"value":value})))?;
                    }
                }
                if control.stopped.load(Ordering::Acquire) { break; }
                let runnable = sessions.values().any(|session| session.active.is_some() && session.runtime.is_job_pending());
                let command = if runnable {
                    receiver.try_recv().ok()
                } else {
                    let remaining = sessions.values().filter_map(|session| session.active.as_ref())
                        .map(|active| active.wall_limit.saturating_sub(active.started.elapsed())).min();
                    let received = match remaining {
                        Some(remaining) => receiver.recv_timeout(remaining),
                        None => receiver.recv().map_err(|_| crossbeam_channel::RecvTimeoutError::Disconnected),
                    };
                    match received {
                        Ok(command) => Some(command),
                        Err(crossbeam_channel::RecvTimeoutError::Timeout) => None,
                        Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                    }
                };
                let Some(command) = command else { continue; };
                match command {
                    Command::Evaluate { id, binding, source, wall_timeout_ms, cancellation } => {
                        let result = binding.validate().and_then(|_| cancellation.check()).and_then(|_| {
                            if source.len() > MAX_SOURCE { return Err(capacity()); }
                            if let Some(session) = sessions.get(&binding.session_id) {
                                if session.binding != binding { return Err(CuaError::new(ErrorCode::OwnershipMismatch, "JavaScript context belongs to another execution context.")); }
                                if session.active.is_some() { return Err(capacity()); }
                            } else {
                                if sessions.len() >= MAX_CONTEXTS { return Err(capacity()); }
                                sessions.insert(binding.session_id.clone(), Session::new(binding.clone(), frames.clone())?);
                            }
                            sessions.get_mut(&binding.session_id).expect("owned session").start(id, source, wall_timeout_ms, cancellation)
                        });
                        if let Err(error) = result {
                            // Do not dispose a different owner's or already active context.
                            if sessions.get(&binding.session_id).is_some_and(|session| session.binding == binding && session.active.is_none()) {
                                sessions.remove(&binding.session_id);
                            }
                            respond(id, Err(error))?;
                        }
                    }
                    Command::Reset { id, binding, cancellation } => {
                        let result = binding.validate().and_then(|_| cancellation.check()).and_then(|_| {
                            if sessions.get(&binding.session_id).is_some_and(|session| session.binding != binding) {
                                return Err(CuaError::new(ErrorCode::OwnershipMismatch, "JavaScript context belongs to another execution context."));
                            }
                            if let Some(mut session) = sessions.remove(&binding.session_id)
                                && let Some(active_id) = session.clear_active() {
                                respond(active_id, Err(cancelled())).map_err(|_| script_error())?;
                            }
                            Ok(json!({"reset":true}))
                        });
                        respond(id, result)?;
                    }
                    Command::Close { binding } => {
                        if sessions.get(&binding.session_id).is_some_and(|session| session.binding == binding)
                            && let Some(mut session) = sessions.remove(&binding.session_id)
                            && let Some(id) = session.clear_active() {
                            respond(id, Err(cancelled()))?;
                        }
                    }
                    Command::Reply { id, call_id, result } => {
                        if let Some(key) = sessions.iter().find(|(_,session)| session.active.as_ref().is_some_and(|active| active.id == id)).map(|(key,_)| key.clone())
                            && let Err(error) = sessions.get_mut(&key).expect("active session").reply(id, call_id, result) {
                            sessions.remove(&key); respond(id, Err(error))?;
                        }
                    }
                    Command::Wake => {},
                }
            }
            for (_, mut session) in sessions.drain() {
                if let Some(id) = session.clear_active() { respond(id, Err(cancelled()))?; }
            }
            while let Ok(command) = receiver.try_recv() {
                match command {
                    Command::Evaluate { id, .. } | Command::Reset { id, .. } => respond(id, Err(cancelled()))?,
                    _ => {},
                }
            }
            Ok(())
        })();
        if result.is_err() {
            for token in pending.lock().unwrap().values() { token.cancel(); }
            let _ = native.send(Work::OutputFailed);
        }
        drop(sessions);
        let _ = done_tx.send(());
    })?;
    Ok((router, done_rx))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_host_wait_uses_wall_deadline_without_an_active_cpu_clock() {
        let binding: SessionBinding = serde_json::from_value(
            json!({"sessionId":"js-fixture","workerId":"worker","chatId":"chat"}),
        )
        .unwrap();
        let (frames, _receiver) = crossbeam_channel::bounded(4);
        let mut session = Session::new(binding, frames).unwrap();
        session
            .start(
                1,
                "await cua.getState()".into(),
                default_wall_timeout_ms(),
                Cancellation::default(),
            )
            .unwrap();
        let active = session.active.as_mut().unwrap();
        assert!(active.clock.get().entered.is_none());
        let consumed = active.clock.get().elapsed;
        active.started = Instant::now() - WALL_LIMIT;
        let result = session.step().unwrap();
        assert_eq!(result.unwrap_err().code, ErrorCode::Capacity);
        assert_eq!(
            session.active.as_ref().unwrap().clock.get().elapsed,
            consumed
        );
        // Drop with a saved root promise and unresolved host resolvers must be safe.
        drop(session);
    }

    fn deadline_session() -> Session {
        let binding: SessionBinding = serde_json::from_value(
            json!({"sessionId":"deadline-fixture","workerId":"worker","chatId":"chat"}),
        )
        .unwrap();
        let (frames, _receiver) = crossbeam_channel::bounded(4);
        Session::new(binding, frames).unwrap()
    }

    #[test]
    fn trusted_wall_deadline_is_bounded_before_evaluation_starts() {
        let mut session = deadline_session();
        for limit in [0, MAX_WALL_TIMEOUT_MS + 1, u64::MAX] {
            let error = session
                .start(1, "42".into(), limit, Cancellation::default())
                .unwrap_err();
            assert_eq!(error.code, ErrorCode::Capacity);
            assert!(session.active.is_none());
            assert!(session.bridge.borrow().evaluation_id.is_none());
        }
    }

    #[test]
    fn extended_approval_wait_keeps_its_wall_deadline_and_active_execution_limit() {
        // Keep the receiver alive: the host send must actually succeed.
        let (frames, _receiver) = crossbeam_channel::bounded(4);
        let binding: SessionBinding = serde_json::from_value(
            json!({"sessionId":"deadline-fixture","workerId":"worker","chatId":"chat"}),
        )
        .unwrap();
        let mut session = Session::new(binding, frames).unwrap();
        session
            .start(
                1,
                "await cua.getState()".into(),
                MAX_WALL_TIMEOUT_MS,
                Cancellation::default(),
            )
            .unwrap();
        let active = session.active.as_mut().unwrap();
        assert_eq!(
            active.wall_limit,
            Duration::from_millis(MAX_WALL_TIMEOUT_MS)
        );
        active.started = Instant::now() - Duration::from_secs(46);
        let consumed = active.clock.get().elapsed;
        assert!(session.step().is_none());
        let active = session.active.as_mut().unwrap();
        assert!(active.clock.get().elapsed >= consumed);
        assert!(active.clock.get().elapsed < ACTIVE_LIMIT);
        assert!(active.clock.get().entered.is_none());
        // Increasing the approval wall time cannot replenish/exempt actual JS.
        active.clock.set(ActiveClock {
            elapsed: ACTIVE_LIMIT,
            entered: None,
        });
        assert_eq!(
            session.step().unwrap().unwrap_err().code,
            ErrorCode::Capacity
        );
    }

    #[test]
    fn a_completed_evaluation_does_not_lend_its_extended_timeout_to_the_next() {
        let (frames, _receiver) = crossbeam_channel::bounded(4);
        let binding: SessionBinding = serde_json::from_value(
            json!({"sessionId":"deadline-fixture","workerId":"worker","chatId":"chat"}),
        )
        .unwrap();
        let mut session = Session::new(binding, frames).unwrap();
        session
            .start(1, "42".into(), MAX_WALL_TIMEOUT_MS, Cancellation::default())
            .unwrap();
        assert_eq!(session.step().unwrap().unwrap(), json!(42));
        assert_eq!(session.clear_active(), Some(1));
        session
            .start(
                2,
                "await cua.getState()".into(),
                default_wall_timeout_ms(),
                Cancellation::default(),
            )
            .unwrap();
        let active = session.active.as_mut().unwrap();
        assert_eq!(active.wall_limit, WALL_LIMIT);
        active.started = Instant::now() - WALL_LIMIT;
        assert_eq!(
            session.step().unwrap().unwrap_err().code,
            ErrorCode::Capacity
        );
    }

    #[test]
    fn host_actions_only_accept_implemented_operations_and_no_authority_fields() {
        for operation in ["state", "targets", "snapshot", "cursor", "detach"] {
            assert!(validate_action(&json!({"operation":operation}).to_string()).is_ok());
            assert!(
                validate_action(&json!({"operation":operation,"binding":{}}).to_string()).is_err()
            );
        }
        assert!(
            validate_action(
                r#"{"operation":"attach","target":{"targetId":"window","targetGeneration":1}}"#
            )
            .is_ok()
        );
        assert!(
            validate_action(
                r#"{"operation":"attach","target":{"targetId":"window","targetGeneration":0}}"#
            )
            .is_err()
        );
        assert!(validate_action(r#"{"operation":"moveCursor","point":{"x":1.5,"y":0}}"#).is_ok());
        assert!(validate_action(r#"{"operation":"moveCursor","point":{"x":-1,"y":0}}"#).is_err());
        assert!(validate_action(r#"{"operation":"click"}"#).is_err());
        assert!(validate_action(&" ".repeat(MAX_SOURCE + 1)).is_err());
    }
}
