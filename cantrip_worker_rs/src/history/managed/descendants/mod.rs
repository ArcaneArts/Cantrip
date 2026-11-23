//! Retained parent activity discovers candidates; actual native headers and
//! server binding provenance establish their ancestry. No input is dispatched.
mod resolve;
mod scan;
use super::{Diagnostic, ManagedRuntime, Scope, sources::Input};
use crate::{
    history::live::{Failure, flight::Cache, identity::ClientApi},
    metadata::{Abort, Signal},
    native_items::{obj, s},
};
use anyhow::Result;
use cantrip_history::{projection::Work, source::Journal};
use cantrip_wire::{JsString, Value};
use indexmap::IndexMap;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::oneshot;
pub type Reconcile = Arc<dyn Fn() + Send + Sync>;
pub type Bind = Arc<dyn Fn(Input) -> Result<Option<Reconcile>> + Send + Sync>;
pub struct Options {
    pub client: Arc<dyn ClientApi>,
    pub bind: Bind,
    pub on_error: Option<Diagnostic>,
    pub retry_delay: Duration,
}
struct JobState {
    sequence: u64,
    dirty: bool,
    running: bool,
    timer: Option<tokio::task::AbortHandle>,
}
struct Job {
    source: Journal,
    scope: Scope,
    runtime: Arc<dyn ManagedRuntime>,
    state: Mutex<JobState>,
}
#[derive(Default)]
struct State {
    jobs: IndexMap<String, Arc<Job>>,
    epoch: u64,
    stopped: bool,
    waiters: Vec<oneshot::Sender<()>>,
    stoppers: Vec<oneshot::Sender<()>>,
}
struct Inner {
    options: Options,
    state: Mutex<State>,
    resolutions: Cache<Value>,
    abort: Abort,
    signal: Signal,
}
#[derive(Clone)]
pub struct Descendants(Arc<Inner>);
impl Descendants {
    pub fn new(options: Options) -> Self {
        let (abort, signal) = Abort::new();
        Self(Arc::new(Inner {
            options,
            state: Mutex::new(State::default()),
            resolutions: Cache::default(),
            abort,
            signal,
        }))
    }
    pub fn revision(&self) -> u64 {
        self.0.state.lock().unwrap().epoch
    }
    pub fn wake(&self, source: Journal, scope: Scope, runtime: Arc<dyn ManagedRuntime>) {
        let key = Value::Array(vec![
            source.journal_id().clone(),
            runtime.generation().map_or(Value::Null, s),
        ])
        .stringify();
        let job = {
            let mut state = self.0.state.lock().unwrap();
            if state.stopped {
                return;
            }
            let job = state
                .jobs
                .entry(key)
                .or_insert_with(|| {
                    Arc::new(Job {
                        source,
                        scope,
                        runtime,
                        state: Mutex::new(JobState {
                            sequence: 0,
                            dirty: false,
                            running: false,
                            timer: None,
                        }),
                    })
                })
                .clone();
            job.state.lock().unwrap().dirty = true;
            state.epoch += 1;
            job
        };
        self.schedule(job, Duration::ZERO);
    }
    fn schedule(&self, job: Arc<Job>, delay: Duration) {
        let state = self.0.state.lock().unwrap();
        let mut pending = job.state.lock().unwrap();
        if state.stopped || pending.running || pending.timer.is_some() {
            return;
        }
        let this = self.clone();
        let keep = job.clone();
        let task = tokio::spawn(Box::pin(async move {
            tokio::time::sleep(delay).await;
            {
                let state = this.0.state.lock().unwrap();
                let mut job = keep.state.lock().unwrap();
                job.timer = None;
                if state.stopped {
                    return;
                }
                // Claim before invoking any runtime/client/bind callback.
                job.running = true;
                job.dirty = false;
            }
            let result = this.scan(&keep).await;
            if let Err(error) = result {
                let active = !this.0.state.lock().unwrap().stopped;
                if active {
                    keep.state.lock().unwrap().dirty = true;
                    this.report(error, &keep.scope);
                }
            }
            let dirty = {
                let mut job = keep.state.lock().unwrap();
                job.running = false;
                job.dirty
            };
            if dirty {
                this.schedule(keep, this.0.options.retry_delay);
            }
            this.settle();
        }) as futures::future::BoxFuture<'static, ()>);
        pending.timer = Some(task.abort_handle());
    }
    fn report(&self, error: anyhow::Error, scope: &Scope) {
        if let Some(report) = &self.0.options.on_error {
            let _ = report(Failure::new(error), scope.value());
        }
    }
    fn settle(&self) {
        let mut state = self.0.state.lock().unwrap();
        let busy = state.jobs.values().any(|job| {
            let job = job.state.lock().unwrap();
            job.running || job.timer.is_some() || job.dirty
        });
        if !busy || state.stopped {
            for waiter in state.waiters.drain(..) {
                let _ = waiter.send(());
            }
        }
        if state.stopped
            && !state
                .jobs
                .values()
                .any(|job| job.state.lock().unwrap().running)
        {
            for stopper in state.stoppers.drain(..) {
                let _ = stopper.send(());
            }
        }
    }
    pub fn flush(&self) -> Work<()> {
        let (send, receive) = oneshot::channel();
        self.0.state.lock().unwrap().waiters.push(send);
        self.settle();
        cantrip_transport::lifecycle::owned(async move {
            receive.await?;
            Ok(())
        })
    }
    pub fn stop(&self) -> Work<()> {
        let (send, receive) = oneshot::channel();
        {
            let mut state = self.0.state.lock().unwrap();
            state.stopped = true;
            self.0
                .abort
                .abort(anyhow::anyhow!("Native child history discovery stopped."));
            for job in state.jobs.values() {
                if let Some(timer) = job.state.lock().unwrap().timer.take() {
                    timer.abort();
                }
            }
            state.stoppers.push(send);
        }
        self.settle();
        cantrip_transport::lifecycle::owned(async move {
            receive.await?;
            Ok(())
        })
    }
}
