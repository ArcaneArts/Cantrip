//! Durable queue notice delivery and independent dispatch recovery.
mod native;
#[cfg(test)]
mod tests;
use crate::wire::Value;
use anyhow::Result;
use futures::{
    FutureExt,
    future::{BoxFuture, Shared, join_all},
};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, oneshot, watch};

pub type Dispatch = Arc<dyn Fn(String, String) -> BoxFuture<'static, Result<()>> + Send + Sync>;
pub type Publish = Arc<dyn Fn(String, String) -> Result<()> + Send + Sync>;
pub type ErrorSink = Arc<dyn Fn(anyhow::Error) + Send + Sync>;
pub type Sweep = Shared<BoxFuture<'static, ()>>;

trait Backend: Send + Sync {
    fn pending_dispatches(&self) -> BoxFuture<'_, Result<Vec<Value>>>;
    fn pending_notifications(&self) -> BoxFuture<'_, Result<Vec<Value>>>;
    fn publish(&self, entry: &Value) -> Result<()>;
    fn request(&self, entry: Value) -> BoxFuture<'_, Result<()>>;
    fn acknowledge(&self, entry: Value) -> BoxFuture<'_, Result<()>>;
    fn defer(&self, entry: Value) -> BoxFuture<'_, Result<()>>;
}
#[derive(Default)]
struct State {
    running: Option<(u64, Sweep)>,
    next: u64,
    recovering: bool,
    started: bool,
    active: usize,
}
pub struct QueueDelivery {
    backend: Arc<dyn Backend>,
    dispatch: Option<Dispatch>,
    on_error: ErrorSink,
    stopped: AtomicBool,
    stop: watch::Sender<bool>,
    state: Mutex<State>,
    changed: Notify,
}
enum WorkKind {
    Sweep(u64),
    Recovery,
    Group,
}
struct Work {
    service: Arc<QueueDelivery>,
    kind: WorkKind,
    complete: Option<oneshot::Sender<()>>,
}
impl Drop for Work {
    fn drop(&mut self) {
        let mut state = self.service.state.lock().unwrap();
        state.active -= 1;
        match self.kind {
            WorkKind::Sweep(id)
                if state
                    .running
                    .as_ref()
                    .is_some_and(|(active, _)| *active == id) =>
            {
                state.running = None;
            }
            WorkKind::Recovery => state.recovering = false,
            _ => {}
        }
        drop(state);
        self.service.changed.notify_waiters();
        // Source clears `running` before its shared promise resolves.
        if let Some(done) = self.complete.take() {
            let _ = done.send(());
        }
    }
}
impl QueueDelivery {
    fn with_backend(
        backend: Arc<dyn Backend>,
        dispatch: Option<Dispatch>,
        on_error: ErrorSink,
    ) -> Arc<Self> {
        Arc::new(Self {
            backend,
            dispatch,
            on_error,
            stopped: AtomicBool::new(false),
            stop: watch::channel(false).0,
            state: Mutex::new(State::default()),
            changed: Notify::new(),
        })
    }
    fn own(
        self: &Arc<Self>,
        kind: WorkKind,
        complete: Option<oneshot::Sender<()>>,
        future: impl std::future::Future<Output = ()> + Send + 'static,
    ) {
        self.state.lock().unwrap().active += 1;
        let ticket = Work {
            service: self.clone(),
            kind,
            complete,
        };
        let mut work = async move {
            let _ticket = ticket;
            future.await;
        }
        .boxed();
        // Begin in caller order, like Source's async IIFE. Pending work moves
        // into an owned task; dropping an awaiting HTTP caller cannot cancel it.
        if work.as_mut().now_or_never().is_none() {
            tokio::spawn(work);
        }
    }
    pub fn run_once(self: &Arc<Self>) -> Sweep {
        let mut state = self.state.lock().unwrap();
        if self.stopped.load(Ordering::Acquire) {
            return futures::future::ready(()).boxed().shared();
        }
        if let Some((_, running)) = &state.running {
            return running.clone();
        }
        let (complete, receiver) = oneshot::channel();
        let result = async move {
            let _ = receiver.await;
        }
        .boxed()
        .shared();
        state.next = state.next.wrapping_add(1);
        let id = state.next;
        state.running = Some((id, result.clone()));
        let recover = self.dispatch.is_some() && !state.recovering;
        if recover {
            state.recovering = true;
        }
        drop(state);
        let service = self.clone();
        self.own(WorkKind::Sweep(id), Some(complete), async move {
            if recover {
                let recovery = service.clone();
                service.own(WorkKind::Recovery, None, async move {
                    if let Err(error) = recovery.recover().await {
                        (recovery.on_error)(error);
                    }
                });
            }
            if let Err(error) = service.sweep().await {
                (service.on_error)(error);
            }
        });
        result
    }
    async fn recover(self: &Arc<Self>) -> Result<()> {
        let entries = Arc::new(self.backend.pending_dispatches().await?);
        let cursor = Arc::new(AtomicUsize::new(0));
        join_all((0..entries.len().min(8)).map(|_| {
            let entries = entries.clone();
            let cursor = cursor.clone();
            async move {
                while !self.stopped.load(Ordering::Acquire) {
                    let index = cursor.fetch_add(1, Ordering::Relaxed);
                    let Some(entry) = entries.get(index) else {
                        break;
                    };
                    let result = async {
                        let owner = super::super::admit::text(&entry["ownerId"])?;
                        let chat = super::super::admit::text(&entry["chatId"])?;
                        (self.dispatch.as_ref().unwrap())(owner, chat).await
                    }
                    .await;
                    if let Err(error) = result {
                        (self.on_error)(error);
                    }
                }
            }
        }))
        .await;
        Ok(())
    }
    async fn sweep(self: &Arc<Self>) -> Result<()> {
        let entries = Arc::new(self.backend.pending_notifications().await?);
        let count = entries.len().min(8);
        let cursor = Arc::new(AtomicUsize::new(0));
        let (sender, receiver) = oneshot::channel();
        let sender = Arc::new(Mutex::new(Some(sender)));
        let service = self.clone();
        self.own(WorkKind::Group, None, async move {
            join_all((0..count).map(|_| {
                let entries = entries.clone();
                let cursor = cursor.clone();
                let sender = sender.clone();
                let service = service.clone();
                async move {
                    if let Err(error) = service.notice_worker(entries, cursor).await
                        && let Some(sender) = sender.lock().unwrap().take()
                    {
                        let _ = sender.send(Err(error));
                    }
                }
            }))
            .await;
            if let Some(sender) = sender.lock().unwrap().take() {
                let _ = sender.send(Ok(()));
            }
        });
        // Promise.all rejects on the first worker failure while its other
        // workers keep running. The owned group intentionally outlives this read.
        receiver
            .await
            .map_err(|_| anyhow::anyhow!("Queue notification group ended"))?
    }
    async fn notice_worker(
        self: &Arc<Self>,
        entries: Arc<Vec<Value>>,
        cursor: Arc<AtomicUsize>,
    ) -> Result<()> {
        while !self.stopped.load(Ordering::Acquire) {
            let index = cursor.fetch_add(1, Ordering::Relaxed);
            let Some(entry) = entries.get(index) else {
                break;
            };
            let outcome = async {
                self.backend.publish(entry)?;
                self.backend.request(entry.clone()).await?;
                if !self.stopped.load(Ordering::Acquire) {
                    self.backend.acknowledge(entry.clone()).await?;
                }
                Ok::<(), anyhow::Error>(())
            }
            .await;
            if let Err(error) = outcome {
                (self.on_error)(error);
                if !self.stopped.load(Ordering::Acquire) {
                    self.backend.defer(entry.clone()).await?;
                }
            }
        }
        Ok(())
    }
    pub fn start(self: &Arc<Self>) {
        let mut state = self.state.lock().unwrap();
        if self.stopped.load(Ordering::Acquire) || state.started {
            return;
        }
        state.started = true;
        drop(state);
        drop(self.run_once());
        let service = Arc::downgrade(self);
        let mut stop = self.stop.subscribe();
        let first_tick = tokio::time::Instant::now() + Duration::from_secs(1);
        tokio::spawn(async move {
            let mut timer = tokio::time::interval_at(first_tick, Duration::from_secs(1));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                if *stop.borrow() {
                    break;
                }
                tokio::select! {biased;_=stop.changed()=>break,_=timer.tick()=>{}}
                let Some(service) = service.upgrade() else {
                    break;
                };
                drop(service.run_once());
            }
        });
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
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
