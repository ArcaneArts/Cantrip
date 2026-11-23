mod jobs;
use super::{Diagnostic, Failure, Retry, Scope, completion};
use crate::{
    history::client::ServerRequestError,
    metadata::{Abort, Signal},
    native_items::{obj, s},
};
use anyhow::{Result, bail};
use cantrip_history::{
    content::Encryption,
    projection::{Projection, Work},
    source::Journal,
};
use cantrip_wire::{JsString, Value};
use indexmap::IndexMap;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::oneshot;
pub struct Opened {
    pub projection: Projection,
    cleanup: Option<Arc<dyn Fn() + Send + Sync>>,
}
impl Opened {
    pub fn new(projection: Projection, cleanup: Option<Arc<dyn Fn() + Send + Sync>>) -> Self {
        Self {
            projection,
            cleanup,
        }
    }
}
impl Drop for Opened {
    fn drop(&mut self) {
        if let Some(cleanup) = &self.cleanup {
            cleanup();
        }
    }
}
pub type Factory = Arc<dyn Fn(Journal, Scope, Signal) -> Work<Opened> + Send + Sync>;
pub struct Options {
    pub worker_id: JsString,
    pub service: Arc<dyn Encryption>,
    pub source_directory: Option<PathBuf>,
    pub factory: Factory,
    pub on_error: Option<Diagnostic>,
    pub on_recovery_error: Option<Diagnostic>,
    pub retry: Retry,
}
struct Job {
    projection: Option<Projection>,
    running: bool,
    timer: Option<tokio::task::AbortHandle>,
    dirty: bool,
    failures: u32,
    unavailable: Option<Failure>,
}
struct Entry {
    scope: Scope,
    source: Journal,
    abort: Abort,
    signal: Signal,
    job: Mutex<Job>,
}
struct State {
    entries: IndexMap<String, Arc<Entry>>,
    stopped: bool,
    closing: bool,
    recovery_pending: bool,
    recovery_running: bool,
    recovery_timer: Option<tokio::task::AbortHandle>,
    recovery_failures: u32,
    waiters: Vec<oneshot::Sender<completion::Reply<()>>>,
    stoppers: Vec<oneshot::Sender<completion::Reply<()>>>,
}
struct Inner {
    options: Options,
    state: Mutex<State>,
    cancel_recovery: Arc<AtomicBool>,
}
#[derive(Clone)]
pub struct Pump(Arc<Inner>);
impl Pump {
    pub fn new(options: Options) -> Self {
        let recover = options
            .source_directory
            .as_ref()
            .is_some_and(|p| !p.as_os_str().is_empty());
        let this = Self(Arc::new(Inner {
            options,
            state: Mutex::new(State {
                entries: IndexMap::new(),
                stopped: false,
                closing: false,
                recovery_pending: recover,
                recovery_running: false,
                recovery_timer: None,
                recovery_failures: 0,
                waiters: Vec::new(),
                stoppers: Vec::new(),
            }),
            cancel_recovery: Arc::new(AtomicBool::new(false)),
        }));
        this.schedule_recovery(0);
        this
    }
    pub fn wake(&self, source: Journal, scope: Scope) -> Result<()> {
        {
            let state = self.0.state.lock().unwrap();
            if state.stopped || state.closing {
                bail!("Native history projection is closing.");
            }
        }
        self.accept(source, scope)
    }
    fn accept(&self, source: Journal, scope: Scope) -> Result<()> {
        if self.0.state.lock().unwrap().stopped {
            bail!("Native history projection is stopped.");
        }
        let actual = source.scope();
        let (owner, server) = self.0.options.service.identity()?;
        if actual["workerId"] != s(self.0.options.worker_id.clone())
            || actual["ownerId"] != s(owner)
            || actual["serverId"] != s(server)
            || actual["chatId"] != s(scope.chat_id.clone())
            || actual["threadId"] != s(scope.thread_id.clone())
            || actual["bindingId"] != s(scope.binding_id.clone())
        {
            bail!("Native history wake belongs to another source binding.");
        }
        let key = actual.stringify();
        let entry = {
            let mut state = self.0.state.lock().unwrap();
            if state.stopped {
                bail!("Native history projection is stopped.");
            }
            if let Some(entry) = state.entries.get(&key) {
                if entry.source.journal_id() != source.journal_id() {
                    bail!("Native history source identity changed; durable recovery is required.");
                }
                entry.clone()
            } else {
                let (abort, signal) = Abort::new();
                let entry = Arc::new(Entry {
                    scope,
                    source,
                    abort,
                    signal,
                    job: Mutex::new(Job {
                        projection: None,
                        running: false,
                        timer: None,
                        dirty: false,
                        failures: 0,
                        unavailable: None,
                    }),
                });
                state.entries.insert(key, entry.clone());
                entry
            }
        };
        {
            let mut job = entry.job.lock().unwrap();
            if job.unavailable.is_some() {
                return Ok(());
            }
            job.dirty = true;
        }
        self.schedule(entry, 0);
        Ok(())
    }
    fn schedule(&self, entry: Arc<Entry>, delay: u64) {
        let state = self.0.state.lock().unwrap();
        let mut job = entry.job.lock().unwrap();
        if state.stopped || job.running || job.timer.is_some() || !job.dirty {
            return;
        }
        let this = self.clone();
        let keep = entry.clone();
        let task = tokio::spawn(Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            {
                let state = this.0.state.lock().unwrap();
                let mut job = keep.job.lock().unwrap();
                job.timer = None;
                if state.stopped {
                    return;
                }
                job.running = true;
            }
            this.drain(keep).await;
        }) as futures::future::BoxFuture<'static, ()>);
        job.timer = Some(task.abort_handle());
    }
    fn schedule_recovery(&self, delay: u64) {
        let mut state = self.0.state.lock().unwrap();
        if state.stopped
            || !state.recovery_pending
            || state.recovery_running
            || state.recovery_timer.is_some()
        {
            return;
        }
        let this = self.clone();
        let task = tokio::spawn(Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            {
                let mut state = this.0.state.lock().unwrap();
                state.recovery_timer = None;
                if state.stopped {
                    return;
                }
                state.recovery_running = true;
            }
            this.recover().await;
        }) as futures::future::BoxFuture<'static, ()>);
        state.recovery_timer = Some(task.abort_handle());
    }
    fn report(&self, error: Failure, scope: Value, recovery: bool) {
        if let Some(report) = if recovery {
            &self.0.options.on_recovery_error
        } else {
            &self.0.options.on_error
        } {
            let _ = report(error, scope);
        }
    }
    fn settle(&self) {
        let mut state = self.0.state.lock().unwrap();
        let running = state.recovery_running
            || state
                .entries
                .values()
                .any(|entry| entry.job.lock().unwrap().running);
        if state.stopped && !running {
            for waiter in state.stoppers.drain(..) {
                let _ = waiter.send(Ok(()));
            }
        }
        if state.recovery_pending
            || state.recovery_timer.is_some()
            || state.recovery_running
            || state.entries.values().any(|entry| {
                let job = entry.job.lock().unwrap();
                job.dirty || job.running || job.timer.is_some()
            })
        {
            return;
        }
        let unavailable = state
            .entries
            .values()
            .find_map(|entry| entry.job.lock().unwrap().unavailable.clone());
        for waiter in state.waiters.drain(..) {
            let _ = waiter.send(unavailable.clone().map_or(Ok(()), Err));
        }
    }
    pub fn flush(&self) -> Work<()> {
        let mut state = self.0.state.lock().unwrap();
        if state.stopped {
            return crate::history::live::ready(Err(anyhow::anyhow!(
                "Native history projection was stopped."
            )));
        }
        let (send, receive) = oneshot::channel();
        state.waiters.push(send);
        drop(state);
        self.settle();
        crate::history::live::response(receive)
    }
    pub fn close(&self) -> Work<()> {
        self.0.state.lock().unwrap().closing = true;
        let flushed = self.flush();
        let this = self.clone();
        cantrip_transport::lifecycle::owned(async move {
            let result = flushed.await;
            this.stop().await?;
            result
        })
    }
    pub fn stop(&self) -> Work<()> {
        let mut state = self.0.state.lock().unwrap();
        state.stopped = true;
        self.0.cancel_recovery.store(true, Ordering::Release);
        if let Some(timer) = state.recovery_timer.take() {
            timer.abort();
        }
        state.recovery_pending = false;
        for entry in state.entries.values() {
            let mut job = entry.job.lock().unwrap();
            if let Some(timer) = job.timer.take() {
                timer.abort();
            }
            entry
                .abort
                .abort(anyhow::anyhow!("Native history projection worker stopped."));
        }
        let error = Failure::new(anyhow::anyhow!(
            "Native history projection stopped before confirming a drain."
        ));
        for waiter in state.waiters.drain(..) {
            let _ = waiter.send(Err(error.clone()));
        }
        let (send, receive) = oneshot::channel();
        state.stoppers.push(send);
        drop(state);
        self.settle();
        crate::history::live::response(receive)
    }
}
