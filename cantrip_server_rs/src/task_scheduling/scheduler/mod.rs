//! Coalesced Task scheduling over the concrete retry, recovery and execution
//! services. A tick owns reconciliation; dispatched turns remain independently
//! owned so a slow worker cannot hold the owner planning loop open.
mod tick;
use super::{automatic_retry, claimed_execution, eligibility, resumed_execution};
use crate::{
    chats::{live_mutations::Service as Live, task_recovery, turn_runtime::stages::Operations},
    database::Database,
    operations::logging::{self, LogCall, Logger},
    task_dispatch, tasks,
    wire::{Value, value::json},
};
use anyhow::{Context, Result};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;

pub const POLL_INTERVAL: Duration = Duration::from_millis(1_000);
pub type Wakeup = Arc<dyn Fn() + Send + Sync>;
pub struct Dependencies {
    pub database: Arc<Database>,
    pub retries: Arc<automatic_retry::Service>,
    pub recovery: Arc<task_recovery::Service>,
    pub eligibility: Arc<eligibility::Service>,
    pub claimed: Arc<claimed_execution::Service>,
    pub resumed: Arc<resumed_execution::Service>,
    pub live: Arc<Live>,
    pub logger: Logger,
    pub server_id: String,
    pub instance_id: String,
}
#[derive(Default)]
struct Tick {
    complete: AtomicBool,
    changed: Notify,
}
impl Tick {
    async fn wait(&self) {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.complete.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }
}
pub struct Service {
    dependencies: Dependencies,
    dispatch: task_dispatch::Repository,
    tasks: tasks::Repository,
    active: Mutex<Option<Arc<Tick>>>,
    timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
    operations: Arc<Operations>,
}
struct Finished {
    service: Arc<Service>,
    tick: Arc<Tick>,
}
impl Drop for Finished {
    fn drop(&mut self) {
        // Publish completion only after clearing the active slot. A waiter
        // captures this exact tick, rather than accidentally waiting for the
        // next periodic tick that may begin immediately afterwards.
        *self.service.active.lock().unwrap() = None;
        self.tick.complete.store(true, Ordering::SeqCst);
        self.tick.changed.notify_waiters();
    }
}
impl Service {
    fn from_dependencies(dependencies: Dependencies) -> Self {
        let database = dependencies.database.clone();
        Self {
            dispatch: task_dispatch::Repository::new(database.clone()),
            tasks: tasks::Repository::new(database),
            dependencies,
            active: Mutex::default(),
            timer: Mutex::default(),
            operations: Arc::default(),
        }
    }
    pub fn new(dependencies: Dependencies) -> Arc<Self> {
        Arc::new(Self::from_dependencies(dependencies))
    }
    /// Build execution collaborators with their actual scheduler wakeup. The
    /// weak reference also allows the complete graph to shut down without a
    /// reference cycle between the scheduler and its turn-completion hooks.
    pub fn new_cyclic(build: impl FnOnce(Wakeup) -> Dependencies) -> Arc<Self> {
        Arc::new_cyclic(|weak: &std::sync::Weak<Self>| {
            let weak = weak.clone();
            let wakeup = Arc::new(move || {
                if let Some(service) = weak.upgrade() {
                    service.queue_tick();
                }
            });
            Self::from_dependencies(build(wakeup))
        })
    }
    pub fn queue_tick(self: &Arc<Self>) {
        let tick = {
            let mut active = self.active.lock().unwrap();
            if active.is_some() {
                return;
            }
            let tick = Arc::new(Tick::default());
            *active = Some(tick.clone());
            tick
        };
        let service = self.clone();
        let finished = Finished {
            service: service.clone(),
            tick,
        };
        drop(self.operations.spawn(async move {
            let _finished = finished;
            if let Err(error) = service.tick().await {
                (service.dependencies.logger)(LogCall::event(
                    "error",
                    "Could not schedule queued Tasks",
                    json!({"err":logging::error_details(&error)}),
                ));
            }
            Ok(())
        }));
    }
    /// Match desktop/standalone startup: a one-second poll plus an immediate
    /// first tick. Composition finishes before this admits background work.
    pub fn start(self: &Arc<Self>) {
        let mut timer = self.timer.lock().unwrap();
        if timer.is_some() {
            return;
        }
        let weak = Arc::downgrade(self);
        *timer = Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval_at(
                tokio::time::Instant::now() + POLL_INTERVAL,
                POLL_INTERVAL,
            );
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let Some(service) = weak.upgrade() else {
                    break;
                };
                service.queue_tick();
            }
        }));
        drop(timer);
        self.queue_tick();
    }
    pub fn stop_timer(&self) {
        if let Some(timer) = self.timer.lock().unwrap().take() {
            timer.abort();
        }
    }
    pub fn stop_automatic_retries(&self) {
        self.dependencies.retries.stop();
    }
    pub async fn wait_active(&self) {
        let tick = self.active.lock().unwrap().clone();
        if let Some(tick) = tick {
            tick.wait().await;
        }
        self.dependencies.retries.drained().await;
    }
    /// Called after stopping sources of new work and settling worker commands.
    /// Keep the database alive through every admitted launch and failure write.
    pub async fn drained(&self) {
        self.operations.drained().await;
        self.dependencies.retries.drained().await;
        self.dependencies.recovery.drained().await;
        self.dependencies.eligibility.drained().await;
        self.dependencies.resumed.drained().await;
        self.dependencies.claimed.drained().await;
        self.dependencies.live.drained().await;
        self.operations.drained().await;
    }
    fn log(&self, level: &'static str, message: &'static str, context: Value) {
        (self.dependencies.logger)(LogCall::event(level, message, context));
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        if let Some(timer) = self.timer.get_mut().unwrap().take() {
            timer.abort();
        }
    }
}
