use super::*;
use crate::{
    live::LiveService,
    workers::{command_bus::CommandFailure, service::WorkerService},
};
use std::{sync::Mutex, time::Duration};
use tokio::sync::{Notify, watch};

#[derive(Default)]
struct State {
    dispatching: bool,
    rerun: bool,
    stopping: bool,
    active: usize,
    callbacks: usize,
}
pub struct Service {
    pub repository: Repository,
    workers: Arc<WorkerService>,
    live: Arc<LiveService>,
    state: Mutex<State>,
    changed: Notify,
    stop: watch::Sender<bool>,
}
struct Callback(Arc<Service>);
impl Drop for Callback {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().callbacks -= 1;
        self.0.changed.notify_waiters();
    }
}
struct JobTask(Arc<Service>);
impl Drop for JobTask {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap();
        state.active -= 1;
        state.rerun = true;
        drop(state);
        self.0.changed.notify_waiters();
    }
}
#[derive(Debug)]
struct InvalidResult;
impl std::fmt::Display for InvalidResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Invalid standalone Chat scratch worker result")
    }
}
impl std::error::Error for InvalidResult {}

impl Service {
    pub fn new(
        database: Arc<Database>,
        workers: Arc<WorkerService>,
        live: Arc<LiveService>,
    ) -> Arc<Self> {
        Arc::new(Self {
            repository: Repository::new(database),
            workers,
            live,
            state: Mutex::new(State::default()),
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
        let ticket = self.callback().context("Scratch job service is closing")?;
        let (send, receive) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            let _ticket = ticket;
            let _ = send.send(future.await);
        });
        receive.await.context("Scratch operation task ended")?
    }
    pub async fn start(self: &Arc<Self>, force: bool) -> Result<()> {
        self.repository.recover(force, crate::auth::now()).await?;
        self.purge_expired().await?;
        self.queue();
        let service = Arc::downgrade(self);
        let mut stop = self.stop.subscribe();
        tokio::spawn(async move {
            let mut timer = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_secs(30),
                Duration::from_secs(30),
            );
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {biased;_=stop.changed()=>break,_=timer.tick()=>{}}
                let Some(service) = service.upgrade() else {
                    break;
                };
                let Some(_ticket) = service.callback() else {
                    break;
                };
                match service.recover_expired().await {
                    Ok(n) if n > 0 => service.queue(),
                    Ok(_) => {}
                    Err(_) => Self::diagnostic("standalone-chat.scratch.recovery-failed"),
                }
            }
        });
        Ok(())
    }
    async fn recover_expired(self: &Arc<Self>) -> Result<usize> {
        let n = self.repository.recover(false, crate::auth::now()).await?;
        self.purge_expired().await?;
        Ok(n)
    }
    async fn purge_expired(self: &Arc<Self>) -> Result<()> {
        let changes = self
            .repository
            .purge_all_expired(crate::auth::now())
            .await?;
        for change in &changes {
            self.publish(&text(&change["ownerId"])?, &change["job"]);
        }
        if !changes.is_empty() {
            self.queue();
        }
        Ok(())
    }
    pub fn worker_connected(self: &Arc<Self>, worker: String) {
        let Some(ticket) = self.callback() else {
            return;
        };
        let service = self.clone();
        tokio::spawn(async move {
            let _ticket = ticket;
            if service.repository.requeue_worker(&worker).await.is_err() {
                Self::diagnostic("standalone-chat.scratch.worker-resume-failed");
                return;
            }
            if service.reconcile(&worker).await.is_err() {
                Self::diagnostic("standalone-chat.scratch.reconciliation-failed");
                return;
            }
            service.queue();
        });
    }
    async fn reconcile(&self, worker: &str) -> Result<()> {
        let Some(owner) = self.workers.repository.owner(worker).await? else {
            return Ok(());
        };
        if !self.workers.bridge.is_connected(worker) {
            return Ok(());
        }
        let Some(record) = self.workers.repository.get_worker(&owner, worker).await? else {
            return Ok(());
        };
        if record["standaloneChat"]["scratch"]["reconcile"] != true {
            return Ok(());
        }
        let roots = self.repository.reconciliation_targets(worker).await?;
        // The reference catches command, parsing and cleanup failures together;
        // owner/capability/target reads above retain their original propagation.
        let result: Result<()> = async {
            let result = self
                .workers
                .commands
                .request(
                    worker,
                    json!({"type":"chat.scratch.reconcile","roots":roots}),
                    Some(Duration::from_secs(60)),
                    None,
                )
                .await?
                .unwrap_or(Value::Null);
            let result = crate::wire::parse(
                "standaloneChatScratchReconciliationResultSchema",
                Some(&result),
            )
            .map_err(|_| InvalidResult)?;
            for job in self
                .repository
                .purge_expired(&owner, crate::auth::now())
                .await?
            {
                self.publish(&owner, &job);
            }
            let missing = result["missingRootIds"]
                .as_array()
                .context("Reconciled missing roots")?
                .iter()
                .map(text)
                .collect::<Result<Vec<_>>>()?;
            self.repository.mark_missing(worker, &missing).await?;
            if !result["orphanedRootIds"]
                .as_array()
                .context("Orphan roots")?
                .is_empty()
            {
                Self::diagnostic("standalone-chat.scratch.orphaned-roots");
            }
            Ok(())
        }
        .await;
        if result.is_err() {
            Self::diagnostic("standalone-chat.scratch.reconciliation-failed");
        }
        Ok(())
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
            if service.dispatch().await.is_err() {
                Self::diagnostic("standalone-chat.scratch.dispatch-failed");
            }
            let again = {
                let mut state = service.state.lock().unwrap();
                state.dispatching = false;
                let again = state.rerun;
                state.rerun = false;
                again
            };
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
            if active >= 4 {
                changed.await;
                continue;
            }
            let Some(claimed) = self.repository.claim_next().await? else {
                break;
            };
            self.state.lock().unwrap().active += 1;
            let service = self.clone();
            tokio::spawn(async move {
                let _ticket = JobTask(service.clone());
                if service.execute(&claimed).await.is_err() {
                    Self::diagnostic("standalone-chat.scratch.transition-failed");
                }
            });
        }
        Ok(())
    }
    async fn execute(&self, claimed: &Value) -> Result<()> {
        let id = text(&claimed["job"]["id"])?;
        let command = text(&claimed["commandId"])?;
        let attempt = claimed["job"]["attempt"]
            .as_f64()
            .context("Scratch job attempt")?;
        let repository = self.repository.clone();
        let renew_id = id.clone();
        let renew_command = command.clone();
        let (stop, mut ending) = watch::channel(false);
        let renewal = tokio::spawn(async move {
            let mut timer = tokio::time::interval_at(
                tokio::time::Instant::now() + Duration::from_secs(30),
                Duration::from_secs(30),
            );
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {biased;_=ending.changed()=>break,_=timer.tick()=>{}}
                match repository.renew(&renew_id, &renew_command, attempt).await {
                    Ok(true) => {}
                    Ok(false) => Self::diagnostic("standalone-chat.scratch.lease-lost"),
                    Err(_) => Self::diagnostic("standalone-chat.scratch.lease-renewal-failed"),
                }
            }
        });
        let result = self.perform(claimed).await;
        let settled = match result {
            Ok(()) => Ok(()),
            Err(error)
                if matches!(
                    error.downcast_ref::<RootJobError>(),
                    Some(RootJobError::Stale(_))
                ) =>
            {
                Self::diagnostic("standalone-chat.scratch.stale-completion");
                Ok(())
            }
            Err(error) => {
                let offline = matches!(error.downcast_ref::<CommandFailure>(),Some(CommandFailure::Bridge(e)) if e.unavailable);
                let code = if offline {
                    "worker-offline"
                } else if error.is::<InvalidResult>() || error.is::<InvalidSummary>() {
                    "invalid-result"
                } else if error.is::<RootJobError>() {
                    "root-conflict"
                } else {
                    "worker-error"
                };
                match self.settle(claimed, code, offline).await {
                    Err(error)
                        if matches!(
                            error.downcast_ref::<RootJobError>(),
                            Some(RootJobError::Stale(_))
                        ) =>
                    {
                        Ok(())
                    }
                    other => other,
                }
            }
        };
        stop.send_replace(true);
        let _ = renewal.await;
        settled
    }
    async fn perform(&self, claimed: &Value) -> Result<()> {
        let job = &claimed["job"];
        let owner = text(&claimed["ownerId"])?;
        let worker = text(&job["workerId"])?;
        let record = self.workers.repository.get_worker(&owner, &worker).await?;
        let Some(record) = record.filter(|_| self.workers.bridge.is_connected(&worker)) else {
            return self.settle(claimed, "worker-offline", true).await;
        };
        let provision = job["kind"] == "provision";
        let caps = &record["standaloneChat"]["scratch"];
        let capable = if provision {
            caps["provision"] == true && caps["routingHandles"] == true
        } else {
            caps["remove"] == true
        };
        if !capable {
            return self.settle(claimed, "capability-missing", false).await;
        }
        let result=self.workers.commands.request(&worker,json!({"type":if provision{"chat.scratch.provision"}else{"chat.scratch.delete"},"jobId":job["id"],"attempt":job["attempt"],"rootId":job["rootId"],"chatId":job["chatId"]}),Some(Duration::from_secs(60)),None).await?.unwrap_or(Value::Null);
        let schema = if provision {
            "standaloneChatScratchProvisionResultSchema"
        } else {
            "standaloneChatScratchDeleteResultSchema"
        };
        let result = crate::wire::parse(schema, Some(&result)).map_err(|_| InvalidResult)?;
        let id = text(&job["id"])?;
        let command = text(&claimed["commandId"])?;
        let completed = if provision {
            self.repository
                .complete_provision(&id, &command, &result)
                .await?
        } else {
            self.repository
                .complete_delete(&id, &command, &result)
                .await?
        };
        self.publish(&owner, &completed);
        Ok(())
    }
    async fn settle(&self, claimed: &Value, code: &str, retryable: bool) -> Result<()> {
        let job = self
            .repository
            .settle(
                &text(&claimed["job"]["id"])?,
                &text(&claimed["commandId"])?,
                !retryable,
                &json!({"code":code,"retryable":retryable}),
            )
            .await?;
        self.publish(&text(&claimed["ownerId"])?, &job);
        Ok(())
    }
    pub fn publish(&self, owner: &str, job: &Value) {
        if self.live.publish_event(json!({"ownerId":owner,"scope":json!({"kind":"current-user"}),"resource":"chat","action":"invalidated","entityId":job["chatId"],"revision":Value::Null,"payload":Value::Null})).is_err(){Self::diagnostic("standalone-chat.scratch.publication-failed");}
        eprintln!("{}",json!({"event":"standalone-chat.scratch.transitioned","subsystem":"standalone-chat-scratch","operation":job["kind"],"status":job["state"],"runId":job["id"],"chatId":job["chatId"],"workerId":job["workerId"],"attempt":job["attempt"],"level":match job["state"].as_str(){Some("failed")=>"error",Some("blocked")=>"warn",Some("succeeded")=>"info",_=>"debug"}}).stringify());
    }
    fn diagnostic(event: &str) {
        eprintln!(
            "{}",
            json!({"level":"warn","event":event,"subsystem":"standalone-chat-scratch"}).stringify()
        );
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
