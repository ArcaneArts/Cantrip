//! Deliver durable logical closures independently of GUI activity or reconnects.
mod native;
#[cfg(test)]
mod tests;
use crate::wire::Value;
use anyhow::{Context, Result};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared, join_all},
};
pub use native::deliver;
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, oneshot, watch};

type Sweep = Shared<BoxFuture<'static, ()>>;
type Reporter = Arc<dyn Fn(anyhow::Error, Option<Value>) + Send + Sync>;
type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
pub(crate) trait Backend: Send + Sync {
    fn pending(&self) -> BoxFuture<'_, Result<Vec<Value>>>;
    fn request(&self, entry: Value) -> BoxFuture<'_, Result<()>>;
    fn acknowledge(&self, entry: Value) -> BoxFuture<'_, Result<()>>;
    fn defer(&self, entry: Value, at: i64) -> BoxFuture<'_, Result<()>>;
}
#[derive(Default)]
struct State {
    running: Option<(u64, Sweep)>,
    next: u64,
    timer: Option<u64>,
    timer_next: u64,
    active: usize,
}
pub struct LogicalDelivery {
    backend: Arc<dyn Backend>,
    report: Reporter,
    clock: Clock,
    interval: Duration,
    state: Mutex<State>,
    stopped: AtomicBool,
    stop: watch::Sender<bool>,
    changed: Notify,
}
pub(crate) use LogicalDelivery as DurableDelivery;
struct Work {
    service: Arc<LogicalDelivery>,
    id: u64,
    complete: Option<oneshot::Sender<()>>,
}
impl Drop for Work {
    fn drop(&mut self) {
        let mut state = self.service.state.lock().unwrap();
        state.active -= 1;
        if state.running.as_ref().is_some_and(|(id, _)| *id == self.id) {
            state.running = None;
        }
        drop(state);
        self.service.changed.notify_waiters();
        if let Some(done) = self.complete.take() {
            let _ = done.send(());
        }
    }
}
impl LogicalDelivery {
    pub(crate) fn with_backend(
        backend: Arc<dyn Backend>,
        report: Reporter,
        clock: Clock,
        interval: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            backend,
            report,
            clock,
            interval,
            state: Mutex::new(State::default()),
            stopped: AtomicBool::new(false),
            stop: watch::channel(false).0,
            changed: Notify::new(),
        })
    }
    pub fn run_once(self: &Arc<Self>) -> Sweep {
        let mut state = self.state.lock().unwrap();
        if self.stopped.load(Ordering::Acquire) {
            return futures::future::ready(()).boxed().shared();
        }
        if let Some((_, running)) = &state.running {
            return running.clone();
        }
        let (done, receive) = oneshot::channel();
        let result = async move {
            let _ = receive.await;
        }
        .boxed()
        .shared();
        state.next = state.next.wrapping_add(1);
        let id = state.next;
        state.running = Some((id, result.clone()));
        state.active += 1;
        drop(state);
        let work = Work {
            service: self.clone(),
            id,
            complete: Some(done),
        };
        let mut future = async move {
            if let Err(error) = work.service.sweep().await
                && !work.service.stopped.load(Ordering::Acquire)
            {
                (work.service.report)(error, None);
            }
            drop(work);
        }
        .boxed();
        // Source starts its read synchronously and owns the shared promise.
        // Cancelling a caller never cancels an already dispatched completion.
        if future.as_mut().now_or_never().is_none() {
            tokio::spawn(future);
        }
        result
    }
    async fn sweep(self: &Arc<Self>) -> Result<()> {
        let entries = Arc::new(self.backend.pending().await?);
        let next = Arc::new(AtomicUsize::new(0));
        join_all((0..entries.len().min(8)).map(|_| {
            let entries = entries.clone();
            let next = next.clone();
            async move {
                while !self.stopped.load(Ordering::Acquire) {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(entry) = entries.get(index) else {
                        break;
                    };
                    self.deliver(entry).await;
                }
            }
        }))
        .await;
        Ok(())
    }
    async fn deliver(&self, entry: &Value) {
        let result = async {
            self.backend.request(entry.clone()).await?;
            if !self.stopped.load(Ordering::Acquire) {
                self.backend.acknowledge(entry.clone()).await?;
            }
            Ok::<(), anyhow::Error>(())
        }
        .await;
        if let Err(error) = result {
            if self.stopped.load(Ordering::Acquire) {
                return;
            }
            (self.report)(error, Some(entry.clone()));
            let retry = async {
                let attempts = entry["attempts"]
                    .as_f64()
                    .context("Logical completion attempts")?;
                let delay = (1000.0 * 2.0_f64.powf(attempts.min(5.0))).min(30000.0);
                // Date's TimeClip truncates after adding the sampled wall clock.
                let at = ((self.clock)() as f64 + delay).trunc() as i64;
                self.backend.defer(entry.clone(), at).await
            }
            .await;
            if let Err(error) = retry {
                (self.report)(error, Some(entry.clone()));
            }
        }
    }
    pub fn start(self: &Arc<Self>) {
        if self.stopped.load(Ordering::Acquire) {
            return;
        }
        let run = self.run_once();
        let service = Arc::downgrade(self);
        tokio::spawn(async move {
            run.await;
            if let Some(service) = service.upgrade() {
                service.schedule();
            }
        });
    }
    fn schedule(self: &Arc<Self>) {
        let mut state = self.state.lock().unwrap();
        if self.stopped.load(Ordering::Acquire) || state.timer.is_some() {
            return;
        }
        state.timer_next = state.timer_next.wrapping_add(1);
        let id = state.timer_next;
        state.timer = Some(id);
        drop(state);
        let deadline = tokio::time::Instant::now() + self.interval;
        let service = Arc::downgrade(self);
        let mut stop = self.stop.subscribe();
        tokio::spawn(async move {
            if *stop.borrow() {
                return;
            }
            tokio::select! {biased;_=stop.changed()=>return,_=tokio::time::sleep_until(deadline)=>{}}
            let Some(service) = service.upgrade() else {
                return;
            };
            let mut state = service.state.lock().unwrap();
            if state.timer != Some(id) {
                return;
            }
            state.timer = None;
            drop(state);
            service.start();
        });
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.state.lock().unwrap().timer = None;
        self.stop.send_replace(true);
    }
    pub async fn drained(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.state.lock().unwrap().active == 0 {
                return;
            }
            changed.await;
        }
    }
}
