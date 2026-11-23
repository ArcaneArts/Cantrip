//! Owned dispatch, lease renewal, recovery, and post-commit publication.
use super::*;
use crate::{
    operations::logging::{self, LogCall, Logger},
    workers::command_bus::LimitedCommandBus,
};
use std::{sync::Mutex, time::Duration};
use tokio::sync::{Notify, watch};

pub type Publish = Arc<dyn Fn(Value) -> Result<()> + Send + Sync>;
pub struct Dependencies {
    pub commands: Arc<LimitedCommandBus>,
    pub publish: Publish,
    pub publishing_enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    pub logger: Logger,
}
#[derive(Default)]
struct State {
    dispatching: bool,
    rerun: bool,
    stopping: bool,
    sweeping: bool,
    active: usize,
    callbacks: usize,
}
pub struct Service {
    pub repository: Repository,
    pub(super) dependencies: Dependencies,
    state: Mutex<State>,
    publication: Mutex<()>,
    changed: Notify,
    stop: watch::Sender<bool>,
}
struct Job(Arc<Service>);
impl Drop for Job {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap();
        state.active -= 1;
        state.rerun = true;
        drop(state);
        self.0.changed.notify_waiters();
        self.0.queue();
    }
}
struct Callback(Arc<Service>);
impl Drop for Callback {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().callbacks -= 1;
        self.0.changed.notify_waiters();
    }
}
impl Service {
    pub fn with_dependencies(database: Arc<Database>, dependencies: Dependencies) -> Arc<Self> {
        Arc::new(Self {
            repository: Repository::new(database),
            dependencies,
            state: Mutex::new(State::default()),
            publication: Mutex::new(()),
            changed: Notify::new(),
            stop: watch::channel(false).0,
        })
    }
    fn callback(self: &Arc<Self>) -> Option<Callback> {
        let mut state = self.state.lock().unwrap();
        if state.stopping {
            return None;
        }
        state.callbacks += 1;
        Some(Callback(self.clone()))
    }
    pub async fn owned<T: Send + 'static>(
        self: &Arc<Self>,
        future: impl std::future::Future<Output = Result<T>> + Send + 'static,
    ) -> Result<T> {
        let ticket = self.callback().context("Chat import service is closing")?;
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _ticket = ticket;
            let _ = send.send(future.await);
        });
        receive.await.context("Chat import operation task ended")?
    }
    pub async fn start_with_recovery(self: &Arc<Self>, force: bool) -> Result<()> {
        let completed = self.repository.complete_unsupported().await?;
        if completed > 0 {
            (self.dependencies.logger)(LogCall::event(
                "info",
                "Completed previously imported canonical chat histories",
                json!({"completed":completed}),
            ));
        }
        self.repository.recover(force, crate::auth::now()).await?;
        self.queue();
        {
            let mut state = self.state.lock().unwrap();
            if state.stopping || state.sweeping {
                return Ok(());
            }
            state.sweeping = true;
        }
        let service = Arc::downgrade(self);
        let mut ending = self.stop.subscribe();
        tokio::spawn(async move {
            let mut timer = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_secs(30),
                Duration::from_secs(30),
            );
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {biased;_=ending.changed()=>break,_=timer.tick()=>{}}
                let Some(service) = service.upgrade() else {
                    break;
                };
                let Some(_ticket) = service.callback() else {
                    break;
                };
                match service.repository.recover(false, crate::auth::now()).await {
                    Ok(count) if count > 0 => service.queue(),
                    Ok(_) => {}
                    Err(error) => service.report(
                        "error",
                        "Could not recover expired chat import leases",
                        &error,
                        Value::object([] as [(&str, Value); 0]),
                    ),
                }
            }
        });
        Ok(())
    }
    pub fn worker_connected(self: &Arc<Self>, worker: String) {
        let Some(ticket) = self.callback() else {
            return;
        };
        let service = self.clone();
        tokio::spawn(async move {
            let _ticket = ticket;
            match service.repository.requeue_worker(&worker).await {
                Ok(_) => service.queue(),
                Err(error) => service.report(
                    "error",
                    "Could not resume chat import jobs for worker",
                    &error,
                    json!({"workerId":worker}),
                ),
            }
        });
    }
    pub fn queue(self: &Arc<Self>) {
        let mut state = self.state.lock().unwrap();
        if state.stopping {
            return;
        }
        if state.dispatching {
            state.rerun = true;
            return;
        }
        state.dispatching = true;
        drop(state);
        let service = self.clone();
        tokio::spawn(async move {
            if let Err(error) = service.dispatch().await {
                service.report(
                    "error",
                    "Chat import dispatch failed",
                    &error,
                    Value::object([] as [(&str, Value); 0]),
                );
            }
            let mut state = service.state.lock().unwrap();
            state.dispatching = false;
            let again = state.rerun;
            state.rerun = false;
            drop(state);
            service.changed.notify_waiters();
            if again {
                service.queue();
            }
        });
    }
    async fn dispatch(self: &Arc<Self>) -> Result<()> {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let (stopping, active) = {
                let state = self.state.lock().unwrap();
                (state.stopping, state.active)
            };
            if stopping {
                break;
            }
            if active >= 2 {
                changed.await;
                continue;
            }
            let Some(claimed) = self.repository.claim_next().await? else {
                break;
            };
            self.state.lock().unwrap().active += 1;
            let service = self.clone();
            tokio::spawn(async move {
                let _ticket = Job(service.clone());
                if let Err(error) = service.execute(&claimed).await {
                    service.report(
                        "error",
                        "Chat import failed outside its durable transition",
                        &error,
                        json!({"chatImportJobId":claimed["job"]["id"]}),
                    );
                }
            });
        }
        Ok(())
    }
    pub(super) fn report(
        &self,
        level: &'static str,
        message: &'static str,
        error: &anyhow::Error,
        mut context: Value,
    ) {
        context["err"] = logging::error_details(error);
        (self.dependencies.logger)(LogCall::event(level, message, context));
    }
    pub fn publish(&self, owner: &str, job: &Value) {
        // Source publishes the complete batch synchronously. Separate Tokio
        // executor tasks must not interleave its job/project/chat frames.
        let _publication = self.publication.lock().unwrap();
        let (level, message) = match job["state"].as_str() {
            Some("failed") => ("error", "Chat import failed"),
            Some("blocked") => ("warn", "Chat import needs attention"),
            Some("succeeded") => ("info", "Chat import completed"),
            _ => ("debug", "Chat import transitioned"),
        };
        let mut context = json!({"event":"chat-import.job.transitioned","subsystem":"chat-import","operation":"import-chat","status":job["state"],"runId":job["id"],"projectId":job["projectId"],"workerId":job["targetPlacement"]["workerId"],"attempt":job["attempt"]});
        if crate::wire::coercion::truthy(job.get("chatId")) {
            context["chatId"] = job["chatId"].clone();
        }
        (self.dependencies.logger)(LogCall::event(level, message, context));
        if !(self.dependencies.publishing_enabled)() {
            return;
        }
        let result = (|| -> Result<()> {
            for (scope, resource, entity, revision) in [
                (
                    json!({"kind":"project","projectId":job["projectId"]}),
                    "chat-import-job",
                    job["id"].clone(),
                    job["stateRevision"].clone(),
                ),
                (
                    json!({"kind":"project","projectId":job["projectId"]}),
                    "project",
                    job["projectId"].clone(),
                    Value::Null,
                ),
            ] {
                (self.dependencies.publish)(
                    json!({"ownerId":owner,"scope":scope,"resource":resource,"action":"invalidated","entityId":entity,"revision":revision,"payload":Value::Null}),
                )?;
            }
            if crate::wire::coercion::truthy(job.get("chatId")) {
                for (scope, resource) in [
                    (
                        json!({"kind":"project","projectId":job["projectId"]}),
                        "chat",
                    ),
                    (
                        json!({"kind":"chat","chatId":job["chatId"]}),
                        "chat-message",
                    ),
                ] {
                    (self.dependencies.publish)(
                        json!({"ownerId":owner,"scope":scope,"resource":resource,"action":"invalidated","entityId":job["chatId"],"revision":Value::Null,"payload":Value::Null}),
                    )?;
                }
            }
            Ok(())
        })();
        if let Err(error) = result {
            self.report(
                "error",
                "Could not publish chat import change",
                &error,
                json!({"chatImportJobId":job["id"]}),
            );
        }
    }
    pub fn stop(&self) {
        self.state.lock().unwrap().stopping = true;
        self.stop.send_replace(true);
        self.changed.notify_waiters();
    }
    pub async fn drained(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let done = {
                let state = self.state.lock().unwrap();
                !state.dispatching && state.active == 0 && state.callbacks == 0
            };
            if done {
                return;
            }
            changed.await;
        }
    }
}
