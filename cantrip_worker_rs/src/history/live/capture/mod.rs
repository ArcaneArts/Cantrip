//! One observation lifetime, three independent jobs: read, persist, and wake.
//! Native dispatch never waits for storage; retirement drains accepted frames.
mod jobs;
mod state;
#[cfg(test)]
mod tests;
use super::{
    Failure,
    observation::{Observer, Runtime, Subscription},
    ready, response,
};
use anyhow::{Result, bail};
use cantrip_history::{projection::Work, source::Journal};
use cantrip_wire::{JsString, Value};
use state::{Kind, Pending, State, Timer};
use std::{
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};
use tokio::sync::oneshot;
pub type Append = Arc<dyn Fn(Value) -> Work<Value> + Send + Sync>;
pub type Persisted = Arc<dyn Fn(Value) -> Work<()> + Send + Sync>;
pub type Diagnostic = Arc<dyn Fn(Failure, Phase) -> Result<()> + Send + Sync>;
#[derive(Clone, Copy, Debug)]
pub enum Phase {
    Observe,
    Snapshot,
    Append,
    Notify,
}
impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Observe => "observe",
            Self::Snapshot => "snapshot",
            Self::Append => "append",
            Self::Notify => "notify",
        }
    }
}
#[derive(Clone)]
pub struct Snapshot {
    pub observation: Value,
    pub record: Value,
}
#[derive(Clone, Copy)]
pub struct Timing {
    retry: u64,
    maximum: u64,
    snapshot: u64,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            retry: 500,
            maximum: 30_000,
            snapshot: 50,
        }
    }
}
impl Timing {
    pub fn new(retry: Option<f64>, maximum: Option<f64>, snapshot: Option<f64>) -> Result<Self> {
        let retry = retry.unwrap_or(500.);
        let maximum = maximum.unwrap_or(30_000.);
        let snapshot = snapshot.unwrap_or(50.);
        if [retry, maximum, snapshot]
            .iter()
            .any(|v| !v.is_finite() || v.fract() != 0. || *v < 0. || *v > 2147483647.)
            || retry < 1.
            || maximum < retry
        {
            bail!("Invalid native history capture scheduling interval.");
        }
        Ok(Self {
            retry: retry as u64,
            maximum: maximum as u64,
            snapshot: snapshot as u64,
        })
    }
    fn delay(self, failures: u32) -> u64 {
        self.maximum.min(
            self.retry
                .saturating_mul(1u64 << failures.saturating_sub(1).min(32)),
        )
    }
}
pub struct Options {
    pub runtime: Arc<dyn Runtime>,
    pub thread_id: JsString,
    pub append: Append,
    pub on_persisted: Option<Persisted>,
    pub on_error: Option<Diagnostic>,
    pub timing: Timing,
}
struct Inner {
    options: Options,
    state: Mutex<State>,
    subscription: OnceLock<Subscription>,
}
#[derive(Clone)]
pub struct Capture(Arc<Inner>);
impl Capture {
    pub fn new(options: Options) -> Result<Self> {
        let capture = Self::deferred(options)?;
        capture.activate();
        Ok(capture)
    }
    /// Subscribe immediately; the manager installs ownership before timers run.
    pub(crate) fn deferred(options: Options) -> Result<Self> {
        let this = Self(Arc::new(Inner {
            options,
            state: Mutex::new(State::default()),
            subscription: OnceLock::new(),
        }));
        let capture = Arc::downgrade(&this.0);
        let error = capture.clone();
        let subscription = this.0.options.runtime.observe(
            this.0.options.thread_id.clone(),
            Observer {
                capture: Arc::new(move |frame| {
                    if let Some(inner) = capture.upgrade() {
                        Self(inner).notification(frame);
                    }
                    Ok(None)
                }),
                on_error: Arc::new(move |failure, _| {
                    if let Some(inner) = error.upgrade() {
                        let this = Self(inner);
                        this.report(failure, Phase::Observe);
                        this.reconcile(None);
                    }
                    Ok(())
                }),
            },
        )?;
        let _ = this.0.subscription.set(subscription.clone());
        let weak = Arc::downgrade(&this.0);
        subscription.on_retired(Arc::new(move |reason| {
            if let Some(inner) = weak.upgrade() {
                let mut state = inner.state.lock().unwrap();
                state.end_observation(reason);
                state.check_flushed();
            }
        }));
        Ok(this)
    }
    pub(crate) fn activate(&self) {
        self.0.state.lock().unwrap().ready = true;
        if self.signal().check().is_ok() {
            self.reconcile(Some(0));
        }
        self.schedule(Kind::Write, 0);
    }
    pub fn on_retired(&self, listener: super::observation::Retired) {
        self.subscription().on_retired(listener);
    }
    pub fn journal(journal: Journal) -> Append {
        Arc::new(move |frame| Box::pin(journal.append(&frame)))
    }
    fn subscription(&self) -> &Subscription {
        self.0
            .subscription
            .get()
            .expect("capture initialized before jobs start")
    }
    pub fn generation(&self) -> JsString {
        self.subscription().generation()
    }
    pub fn signal(&self) -> crate::metadata::Signal {
        self.subscription().signal()
    }
    pub fn pending_records(&self) -> usize {
        self.0.state.lock().unwrap().pending.len()
    }
    fn report(&self, error: Failure, phase: Phase) {
        if let Some(callback) = &self.0.options.on_error {
            let _ = callback(error, phase);
        }
    }
    pub fn reconcile(&self, delay: Option<u64>) {
        {
            let mut state = self.0.state.lock().unwrap();
            if !state.observing || state.stopped {
                return;
            }
            if !state.dirty {
                state.revision += 1;
            }
            state.dirty = true;
        }
        self.schedule(Kind::Read, delay.unwrap_or(self.0.options.timing.snapshot));
    }
    pub fn snapshot(&self) -> Work<Snapshot> {
        let mut state = self.0.state.lock().unwrap();
        if !state.observing || state.stopped {
            return ready(Err(anyhow::anyhow!(
                "Native history capture is no longer observing."
            )));
        }
        state.revision += 1;
        let revision = state.revision;
        let (send, receive) = oneshot::channel();
        state.snapshots.push((revision, send));
        state.dirty = true;
        drop(state);
        self.schedule(Kind::Read, 0);
        response(receive)
    }
    fn notification(&self, frame: Value) {
        let reconcile = {
            let mut state = self.0.state.lock().unwrap();
            if !state.observing || state.stopped {
                return;
            }
            let reconcile = state.cursors.notification(&frame)
                || matches!(
                    frame["method"].as_str(),
                    Some("thread/started" | "turn/started" | "turn/completed")
                );
            state.pending.push_back(Pending {
                frame,
                revision: None,
            });
            reconcile
        };
        if reconcile {
            self.reconcile(None);
        }
        self.schedule(Kind::Write, 0);
    }
    fn schedule(&self, kind: Kind, delay: u64) {
        let mut state = self.0.state.lock().unwrap();
        if !state.ready || state.stopped || state.timers[kind as usize].is_some() {
            return;
        }
        let active = match kind {
            Kind::Read => state.observing && !state.reading && state.dirty,
            Kind::Write => !state.writing && !state.pending.is_empty(),
            Kind::Notify => !state.notifying && state.notification.is_some(),
        };
        if !active {
            return;
        }
        state.next_timer += 1;
        let id = state.next_timer;
        let this = self.clone();
        let operation: futures::future::BoxFuture<'static, ()> = Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            this.fire(kind, id).await;
        });
        let task = tokio::spawn(operation);
        state.timers[kind as usize] = Some(Timer {
            id,
            abort: task.abort_handle(),
        });
    }
    pub fn flush(&self) -> Work<()> {
        let mut state = self.0.state.lock().unwrap();
        if state.stopped {
            return ready(Err(anyhow::anyhow!(
                "Native history capture was stopped before confirming a drain."
            )));
        }
        let (send, receive) = oneshot::channel();
        state.flushes.push(send);
        state.check_flushed();
        response(receive)
    }
    pub fn close(&self) -> Work<()> {
        self.0
            .state
            .lock()
            .unwrap()
            .end_observation(Failure::new(anyhow::anyhow!(
                "Native history observation was closed."
            )));
        self.subscription().close();
        self.flush()
    }
    pub fn when_stopped(&self) -> Work<()> {
        let mut state = self.0.state.lock().unwrap();
        if !state.stopped {
            return ready(Err(anyhow::anyhow!(
                "Native history capture has not stopped."
            )));
        }
        let (send, receive) = oneshot::channel();
        state.stopped_waiters.push(send);
        state.check_flushed();
        response(receive)
    }
    /// Final teardown does not acknowledge pending memory. In-flight append and
    /// wake callbacks retain ownership; when_stopped waits before releasing keys.
    pub fn stop(&self) {
        {
            let mut state = self.0.state.lock().unwrap();
            state.stopped = true;
            let error = Failure::new(anyhow::anyhow!(
                "Native history capture stopped before confirming a drain."
            ));
            state.end_observation(error.clone());
            state.cancel_timer(Kind::Write);
            state.cancel_timer(Kind::Notify);
            for waiter in state.flushes.drain(..) {
                let _ = waiter.send(Err(error.clone()));
            }
        }
        self.subscription().close();
        self.0.state.lock().unwrap().check_flushed();
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        if let Some(subscription) = self.subscription.get() {
            subscription.close();
        }
    }
}
