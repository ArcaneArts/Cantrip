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
const MAX_SOURCE: usize = 2 * 1024 * 1024;
const MAX_OUTPUT: usize = 32 * 1024;
const MAX_HOST_CALLS: u64 = 16384;
const MAX_HEAP: usize = 128 * 1024 * 1024;
const ACTIVE_LIMIT: Duration = Duration::from_secs(10);
#[cfg(test)]
const WALL_LIMIT: Duration = Duration::from_secs(45);
const MAX_WALL_TIMEOUT_MS: u64 = 7_500_000;
pub(crate) fn default_wall_timeout_ms() -> u64 {
    45_000
}
const JOB_BATCH: usize = 16;
const MAX_JOBS: u32 = 200_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TargetReference {
    target_id: String,
    target_generation: u64,
}

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
enum HostAction {
    Perform {
        command: crate::gesture::InputCommand,
    },
    Wait {
        ms: u64,
    },
    State {},
    Targets {
        #[serde(default, deserialize_with = "crate::inventory::deserialize_cursor")]
        after: Option<String>,
    },
    Attach {
        target: TargetReference,
    },
    Click {
        point: Option<Point>,
    },
    BackgroundClick {
        point: Option<Point>,
    },
    ProcessClick {
        point: Option<Point>,
    },
    GlobalClick {
        point: Point,
    },
    Controls {
        point: Option<Point>,
    },
    Press {
        reference: String,
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
    if source.len() > 15 * 1024 * 1024 {
        return Err(capacity());
    }
    let action: HostAction = serde_json::from_str(source).map_err(|_| script_error())?;
    match action {
        HostAction::Perform { command } => command.validate()?,
        HostAction::Wait { ms } if ms > 10000 => return Err(script_error()),
        HostAction::Targets { after: Some(after) } => validate_id(&after)?,
        HostAction::Attach { target } => {
            validate_id(&target.target_id)?;
            if !(1..=MAX_SEQUENCE).contains(&target.target_generation) {
                return Err(script_error());
            }
        }
        HostAction::Press { reference } => validate_id(&reference)?,
        HostAction::ConfigureCursor { appearance } => appearance.validate()?,
        HostAction::MoveCursor { point }
        | HostAction::GlobalClick { point }
        | HostAction::Controls { point: Some(point) }
        | HostAction::Click { point: Some(point) }
        | HostAction::BackgroundClick { point: Some(point) }
        | HostAction::ProcessClick { point: Some(point) }
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
    help: () => ({apiVersion:3, methods:{requestFocus:"requestFocus() activates and raises the attached window; sends no click",commandClick:"commandClick(point, holdMs=150) sends a real Command-modified mouse press without requesting focus",pointerPress:"pointerPress(point, holdMs=150, modifiers=[]) where modifiers are Shift,Control,Alt,Meta; modifiers are NOT held timeline keys",inputTimeline:"inputTimeline(frames): atMs, keyDown, keyUp, pointerDown, pointerUp, pointerModifiers on pointerDown",keyChord:"keyChord(keys,holdMs=500)"}, limits:{scriptBytes:2097152,hostCalls:16384,timelineFrames:131072,timelineMs:7200000,hostActionBytes:15728640,outputBytes:32768,maxHeldKeys:16,maxSnapshots:2,maxWallMs:7500000}, notes:"Use one native timeline for a preplanned stable interface to avoid model round trips between music chunks. No automatic focus or retries after uncertain input. Command is visible to the target and may change link/selection behavior. An installed helper update requires a worker restart to replace an already running helper."}),
    requestFocus: () => call({operation:'perform',command:{kind:'focus'}}),
    commandClick: (point, holdMs = 150) => call({operation:'perform',command:{kind:'timeline',frames:[{atMs:0,pointerDown:point,pointerModifiers:['Meta']},{atMs:holdMs,pointerUp:true}]}}),
    keyChord: (keys, holdMs = 500) => call({operation:'perform', command:{kind:'timeline',frames:[{atMs:0,keyDown:keys},{atMs:holdMs,keyUp:keys}]}}),
    inputTimeline: frames => call({operation:'perform',command:{kind:'timeline',frames}}),
    pointerPress: (point, holdMs = 150, modifiers = []) => call({operation:'perform',command:{kind:'timeline',frames:[{atMs:0,pointerDown:point,pointerModifiers:modifiers},{atMs:holdMs,pointerUp:true}]}}),
    typeText: text => call({operation:'perform', command:{kind:'text',text}}),
    keyPress: (key, modifiers = []) => call({operation:'perform', command:{kind:'key',key,modifiers}}),
    clickDrag: (start, end, durationMs = 200) => call({operation:'perform', command:{kind:'drag',start,end,durationMs}}),
    scroll: (deltaY, deltaX = 0, point) => call({operation:'perform', command:{kind:'scroll',deltaX,deltaY,point}}),
    wait: ms => call({operation:'wait',ms}),
    getState: () => call({operation:'state'}),
    targets: (options = {}) => {
      if (options === null || typeof options !== 'object' || Array.isArray(options) ||
          Object.keys(options).some(key => key !== 'after') ||
          ('after' in options && typeof options.after !== 'string')) throw new Error('Invalid target page options');
      return call({operation:'targets', ...options});
    },
    attach: target => call({operation:'attach', target}),
    click: point => call({operation:'click', point}),
    backgroundClick: point => call({operation:'backgroundClick', point}),
    processClick: point => call({operation:'processClick', point}),
    globalClick: point => call({operation:'globalClick', point}),
    controls: point => call({operation:'controls', point}),
    press: reference => call({operation:'press', reference}),
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
    rejections: Vec<(Persistent<rquickjs::Value<'static>>, CuaError)>,
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
            rejections: Vec::new(),
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
            bridge.rejections.clear();
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
                .map_err(|error| {
                    // Classify parser failures without exposing source, stack or
                    // exception messages across the native protocol boundary.
                    let syntax = error.is_exception()
                        && ctx.catch().as_object().is_some_and(|exception| {
                            exception.get::<_, String>("name").ok().as_deref()
                                == Some("SyntaxError")
                        });
                    if syntax {
                        CuaError::new(
                            ErrorCode::ScriptSyntax,
                            "Invalid JavaScript syntax. Use top-level await and a final expression, such as await cua.targets(); do not use a top-level return.",
                        )
                    } else {
                        script_error()
                    }
                })
        });
        Self::leave(&clock);
        self.check_budget(&cancellation, started, wall_limit, &clock)?;
        let promise = promise?;
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
        let mut host_error = None;
        let value = self
            .context
            .with(|ctx| -> rquickjs::Result<Option<String>> {
                let promise = active.promise.clone().restore(&ctx)?;
                // QuickJS's JS_EVAL_FLAG_ASYNC resolves its completion envelope
                // { value: <last expression> }, not the expression directly.
                let completion = match promise
                    .result::<rquickjs::Object>()
                    .ok_or(rquickjs::Error::WouldBlock)?
                {
                    Ok(completion) => completion,
                    Err(error) => {
                        if error.is_exception() {
                            let exception = ctx.catch();
                            // Identity, never script-controlled code/message fields.
                            for (value, rejection) in &self.bridge.borrow().rejections {
                                if value.clone().restore(&ctx)? == exception {
                                    host_error = Some(rejection.clone());
                                    break;
                                }
                            }
                        }
                        return Err(error);
                    }
                };
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
        let value = value.map_err(|_| host_error.unwrap_or_else(script_error))?;
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
                    return Some(self.finish_value(active).map_err(|error| {
                        if error.code == ErrorCode::InvalidRequest && self.bridge.borrow().calls == 0 {
                            CuaError::new(ErrorCode::ScriptEvaluation,
                                "JavaScript evaluation failed before any computer-use host action was dispatched. Persistent let/const bindings cannot be redeclared; use a block or fresh variable names.")
                        } else {
                            error
                        }
                    }));
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
            let (function, data, error) = match result {
                Outcome::Ok { data } => (pending.resolve.restore(&ctx)?, data, None),
                Outcome::Error { error } => (
                    pending.reject.restore(&ctx)?,
                    json!({"code":error.code,"message":"CUA host operation failed."}),
                    Some(error),
                ),
            };
            let bytes = serde_json::to_vec(&data).map_err(|_| rquickjs::Error::Unknown)?;
            let value: rquickjs::Value = ctx.json_parse(bytes)?;
            if let Some(error) = error {
                self.bridge
                    .borrow_mut()
                    .rejections
                    .push((Persistent::save(&ctx, value.clone()), error));
            }
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
        bridge.rejections.clear();
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
    fn macro_bootstrap_sends_bounded_host_commands() {
        for (script, expected) in [
            (
                r#"await cua.requestFocus()"#,
                json!({"operation":"perform","command":{"kind":"focus"}}),
            ),
            (
                r#"await cua.commandClick({x:12,y:34},200)"#,
                json!({"operation":"perform","command":{"kind":"timeline","frames":[{"atMs":0,"pointerDown":{"x":12,"y":34},"pointerModifiers":["Meta"]},{"atMs":200,"pointerUp":true}]}}),
            ),
            (
                r#"await cua.keyChord(["C","B","M"],500)"#,
                json!({"operation":"perform","command":{"kind":"timeline","frames":[{"atMs":0,"keyDown":["C","B","M"]},{"atMs":500,"keyUp":["C","B","M"]}]}}),
            ),
            (
                r#"await cua.pointerPress({x:10,y:20},200)"#,
                json!({"operation":"perform","command":{"kind":"timeline","frames":[{"atMs":0,"pointerDown":{"x":10,"y":20},"pointerModifiers":[]},{"atMs":200,"pointerUp":true}]}}),
            ),
            (
                r#"await cua.pointerPress({x:10,y:20},150,["Meta"])"#,
                json!({"operation":"perform","command":{"kind":"timeline","frames":[{"atMs":0,"pointerDown":{"x":10,"y":20},"pointerModifiers":["Meta"]},{"atMs":150,"pointerUp":true}]}}),
            ),
            (
                r#"await cua.inputTimeline([{atMs:0,keyDown:["C"]},{atMs:50,keyUp:["C"]}])"#,
                json!({"operation":"perform","command":{"kind":"timeline","frames":[{"atMs":0,"keyDown":["C"]},{"atMs":50,"keyUp":["C"]}]}}),
            ),
            (
                r#"await cua.typeText("hi🦀")"#,
                json!({"operation":"perform","command":{"kind":"text","text":"hi🦀"}}),
            ),
            (
                r#"await cua.keyPress("Enter")"#,
                json!({"operation":"perform","command":{"kind":"key","key":"Enter","modifiers":[]}}),
            ),
            (
                r#"await cua.clickDrag({x:1,y:2},{x:3,y:4})"#,
                json!({"operation":"perform","command":{"kind":"drag","start":{"x":1,"y":2},"end":{"x":3,"y":4},"durationMs":200}}),
            ),
            (
                r#"await cua.scroll(300)"#,
                json!({"operation":"perform","command":{"kind":"scroll","deltaY":300,"deltaX":0}}),
            ),
            (
                r#"await cua.wait(150)"#,
                json!({"operation":"wait","ms":150}),
            ),
        ] {
            let binding = serde_json::from_value(
                json!({"sessionId":"macro","workerId":"worker","chatId":"chat"}),
            )
            .unwrap();
            let (frames, receiver) = crossbeam_channel::bounded(4);
            let mut session = Session::new(binding, frames).unwrap();
            session
                .start(
                    1,
                    script.into(),
                    default_wall_timeout_ms(),
                    Cancellation::default(),
                )
                .unwrap();
            assert!(session.step().is_none());
            let frame = receiver.try_recv().unwrap();
            let Message::HostCall { action, .. } = frame.header.message else {
                panic!("expected host action")
            };
            assert_eq!(action, expected);
        }
    }
    #[test]
    fn live_help_and_large_generated_score_match_runtime_limits() {
        let binding =
            serde_json::from_value(json!({"sessionId":"help","workerId":"worker","chatId":"chat"}))
                .unwrap();
        let (frames, receiver) = crossbeam_channel::bounded(4);
        let mut session = Session::new(binding, frames).unwrap();
        session
            .start(
                1,
                "await cua.help()".into(),
                MAX_WALL_TIMEOUT_MS,
                Cancellation::default(),
            )
            .unwrap();
        let help = session.step().unwrap().unwrap();
        assert_eq!(help["limits"]["scriptBytes"], MAX_SOURCE);
        assert_eq!(help["limits"]["hostCalls"], MAX_HOST_CALLS);
        assert_eq!(help["limits"]["maxWallMs"], MAX_WALL_TIMEOUT_MS);
        assert!(receiver.is_empty());
        session.clear_active();
        // Generate a long score in JS, validate and serialize the actual host
        // action, but never authorize or dispatch native input.
        session.start(2, "await cua.inputTimeline(Array.from({length:131072}, (_,i)=>i%2===0?{atMs:i*50,keyDown:['C']}:{atMs:i*50,keyUp:['C']}))".into(), MAX_WALL_TIMEOUT_MS, Cancellation::default()).unwrap();
        assert!(session.step().is_none());
        let frame = receiver.try_recv().unwrap();
        let Message::HostCall { action, .. } = &frame.header.message else {
            panic!("expected timeline");
        };
        assert_eq!(
            action["command"]["frames"].as_array().unwrap().len(),
            131072
        );
        let mut bytes = Vec::new();
        crate::protocol::write_frame(&mut bytes, &frame).unwrap();
    }
    #[test]
    fn point_inspection_validates_coordinates_without_authority_fields() {
        assert_eq!(
            validate_action(r#"{"operation":"controls","point":{"x":54,"y":955}}"#).unwrap()["point"],
            json!({"x":54,"y":955})
        );
        assert!(validate_action(r#"{"operation":"controls"}"#).is_ok());
        assert!(validate_action(r#"{"operation":"controls","point":{"x":-1,"y":0}}"#).is_err());
        assert!(validate_action(r#"{"operation":"controls","sessionId":"other"}"#).is_err());
    }
    #[test]
    fn top_level_return_reports_syntax_without_dispatching_host_work() {
        let binding: SessionBinding = serde_json::from_value(
            json!({"sessionId":"syntax-fixture","workerId":"worker","chatId":"chat"}),
        )
        .unwrap();
        let (frames, receiver) = crossbeam_channel::bounded(4);
        let mut session = Session::new(binding, frames).unwrap();
        let error = session
            .start(
                1,
                "return await cua.targets();".into(),
                default_wall_timeout_ms(),
                Cancellation::default(),
            )
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::ScriptSyntax);
        assert!(error.message.contains("do not use a top-level return"));
        assert!(receiver.is_empty());
        assert!(session.active.is_none());
        session
            .start(
                2,
                "await Promise.resolve(42)".into(),
                default_wall_timeout_ms(),
                Cancellation::default(),
            )
            .unwrap();
        assert_eq!(session.step().unwrap().unwrap(), json!(42));
    }

    #[test]
    fn reused_top_level_binding_rejects_before_click_host_dispatch() {
        let binding: SessionBinding = serde_json::from_value(
            json!({"sessionId":"binding-fixture","workerId":"worker","chatId":"chat"}),
        )
        .unwrap();
        let (frames, receiver) = crossbeam_channel::bounded(4);
        let mut session = Session::new(binding, frames).unwrap();
        session
            .start(
                1,
                "let shot = 1; shot".into(),
                default_wall_timeout_ms(),
                Cancellation::default(),
            )
            .unwrap();
        assert_eq!(session.step().unwrap().unwrap(), json!(1));
        session.clear_active();
        session
            .start(
                2,
                "let receipt = await cua.click({x:55,y:929}); let shot = 2; ({receipt,shot})"
                    .into(),
                default_wall_timeout_ms(),
                Cancellation::default(),
            )
            .unwrap();
        assert_eq!(
            session.step().unwrap().unwrap_err().code,
            ErrorCode::ScriptEvaluation
        );
        assert!(
            receiver.is_empty(),
            "No native click may be dispatched on declaration failure"
        );
        session.clear_active();
        for id in 3..5 {
            session
                .start(
                    id,
                    "{ let shot = 2; shot }".into(),
                    default_wall_timeout_ms(),
                    Cancellation::default(),
                )
                .unwrap();
            assert_eq!(session.step().unwrap().unwrap(), json!(2));
            session.clear_active();
        }
    }

    #[test]
    fn uncaught_host_rejections_preserve_only_the_original_error_identity() {
        for code in [
            ErrorCode::Unsupported,
            ErrorCode::ControlNotFound,
            ErrorCode::ControlAmbiguous,
            ErrorCode::ControlInspectionIncomplete,
            ErrorCode::InputUnknown,
            ErrorCode::TargetNotFound,
        ] {
            for (source, expected) in [
                ("await cua.click({x:55,y:797}); await cua.snapshot()", code),
                (
                    "try { await cua.click(); } catch (e) { e.code = 'permission-denied'; throw e; }",
                    code,
                ),
                (
                    "try { await cua.click(); } catch (e) { throw {code:e.code}; }",
                    ErrorCode::InvalidRequest,
                ),
                (
                    "try { await cua.click(); } catch {} throw new Error('private detail')",
                    ErrorCode::InvalidRequest,
                ),
            ] {
                let binding = serde_json::from_value(
                    json!({"sessionId":"host-error-fixture","workerId":"worker","chatId":"chat"}),
                )
                .unwrap();
                let (frames, receiver) = crossbeam_channel::bounded(4);
                let mut session = Session::new(binding, frames).unwrap();
                session
                    .start(
                        1,
                        source.into(),
                        default_wall_timeout_ms(),
                        Cancellation::default(),
                    )
                    .unwrap();
                assert!(session.step().is_none());
                receiver.try_recv().unwrap();
                session
                    .reply(
                        1,
                        1,
                        Outcome::Error {
                            error: CuaError::new(code, "Host failure"),
                        },
                    )
                    .unwrap();
                assert_eq!(
                    session.step().unwrap().unwrap_err().code,
                    expected,
                    "{source}"
                );
                assert!(
                    receiver.is_empty(),
                    "Failed click must not run its following snapshot"
                );
                session.clear_active();
                assert!(session.bridge.borrow().rejections.is_empty());
            }
        }
    }

    #[test]
    fn a_script_can_handle_a_host_error_and_return_normally() {
        let binding = serde_json::from_value(
            json!({"sessionId":"caught-error-fixture","workerId":"worker","chatId":"chat"}),
        )
        .unwrap();
        let (frames, _receiver) = crossbeam_channel::bounded(4);
        let mut session = Session::new(binding, frames).unwrap();
        session
            .start(
                1,
                "try { await cua.click(); } catch {} 42".into(),
                default_wall_timeout_ms(),
                Cancellation::default(),
            )
            .unwrap();
        assert!(session.step().is_none());
        session
            .reply(
                1,
                1,
                Outcome::Error {
                    error: CuaError::new(ErrorCode::Unsupported, "Host failure"),
                },
            )
            .unwrap();
        assert_eq!(session.step().unwrap().unwrap(), json!(42));
    }

    #[test]
    fn failure_after_a_host_call_never_claims_no_dispatch() {
        let binding: SessionBinding = serde_json::from_value(
            json!({"sessionId":"post-host-fixture","workerId":"worker","chatId":"chat"}),
        )
        .unwrap();
        let (frames, receiver) = crossbeam_channel::bounded(4);
        let mut session = Session::new(binding, frames).unwrap();
        session
            .start(
                1,
                "await cua.targets(); throw new Error('private runtime detail')".into(),
                default_wall_timeout_ms(),
                Cancellation::default(),
            )
            .unwrap();
        assert!(session.step().is_none());
        assert!(!receiver.is_empty());
        session
            .reply(
                1,
                1,
                Outcome::Ok {
                    data: json!({"targets":[]}),
                },
            )
            .unwrap();
        let error = session.step().unwrap().unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidRequest);
        assert!(!error.message.contains("private runtime detail"));
    }

    #[test]
    fn runtime_errors_are_not_reported_as_parser_failures() {
        let mut session = deadline_session();
        session
            .start(
                1,
                "throw new Error('private runtime detail')".into(),
                default_wall_timeout_ms(),
                Cancellation::default(),
            )
            .unwrap();
        let error = session.step().unwrap().unwrap_err();
        assert_eq!(error.code, ErrorCode::ScriptEvaluation);
        assert!(!error.message.contains("private runtime detail"));
    }

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
        assert!(validate_action(r#"{"operation":"click"}"#).is_ok());
        assert!(validate_action(r#"{"operation":"backgroundClick"}"#).is_ok());
        assert!(
            validate_action(r#"{"operation":"backgroundClick","point":{"x":-1,"y":0}}"#).is_err()
        );
        assert!(validate_action(r#"{"operation":"backgroundClick","processId":123}"#).is_err());
        assert!(validate_action(r#"{"operation":"processClick"}"#).is_ok());
        assert!(validate_action(r#"{"operation":"processClick","point":{"x":-1,"y":0}}"#).is_err());
        assert!(validate_action(r#"{"operation":"processClick","processId":123}"#).is_err());
        assert!(validate_action(&" ".repeat(MAX_SOURCE + 1)).is_err());
    }
}
