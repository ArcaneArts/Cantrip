use super::Repository;
use crate::{
    chats::{
        managed_console::ManagedConsole,
        routing::{ModelRouting, ModelSelectionRequired},
    },
    database::Database,
    operations::logging::{self, Logger},
    wire::Value,
    workers::{
        bridge::{EventHandler, NotificationSubscription},
        command_bus::{LimitedCommandBus, RequestTimeout},
    },
};
use anyhow::{Context, Result, bail};
use futures::{
    FutureExt,
    future::{BoxFuture, Shared},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{Notify, oneshot};

pub type Recovery = Shared<BoxFuture<'static, Result<(), Arc<anyhow::Error>>>>;
pub type Request = Arc<
    dyn Fn(
            String,
            String,
            Value,
            RequestTimeout,
            Option<EventHandler>,
        ) -> BoxFuture<'static, Result<Option<Value>>>
        + Send
        + Sync,
>;
pub type Publish = Arc<dyn Fn(Value) + Send + Sync>;
pub(super) struct Job {
    pub id: uuid::Uuid,
    pub ready: Recovery,
    pub finished: Recovery,
}
#[derive(Default)]
pub(super) struct State {
    pub stopping: bool,
    pub tasks: usize,
    pub active: HashMap<String, Arc<Job>>,
    pub subscriptions: HashMap<String, NotificationSubscription>,
}
pub struct Service {
    pub repository: Repository,
    pub(super) routing: Arc<ModelRouting>,
    pub(super) console: Arc<ManagedConsole>,
    pub(super) request_worker: Request,
    pub(super) publish: Publish,
    pub(super) server_id: String,
    pub(super) logger: Logger,
    pub(super) state: Mutex<State>,
    pub(super) changed: Notify,
}
fn shared(receiver: oneshot::Receiver<Result<(), Arc<anyhow::Error>>>) -> Recovery {
    async move {
        receiver
            .await
            .unwrap_or_else(|_| Err(Arc::new(anyhow::anyhow!("Managed preparation task ended"))))
    }
    .boxed()
    .shared()
}
pub(super) fn copy_error(error: Arc<anyhow::Error>) -> anyhow::Error {
    if error.is::<ModelSelectionRequired>() {
        ModelSelectionRequired.into()
    } else {
        anyhow::anyhow!(error.to_string())
    }
}
pub(super) fn eligible(context: &Value) -> bool {
    context["contextKind"] == "project" && context["experience"] == "agent"
}
pub(super) fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key].as_str().context("Managed preparation identity")
}
pub(super) fn key(owner: &str, chat: &str) -> String {
    format!("{owner}:{chat}")
}
pub(super) struct Admission(pub Arc<Service>);
impl Drop for Admission {
    fn drop(&mut self) {
        self.0.state.lock().unwrap().tasks -= 1;
        self.0.changed.notify_waiters();
    }
}
impl Service {
    pub fn new(
        database: Arc<Database>,
        routing: Arc<ModelRouting>,
        console: Arc<ManagedConsole>,
        commands: Arc<LimitedCommandBus>,
        publish: Publish,
        server_id: String,
    ) -> Arc<Self> {
        Self::with_request(
            database,
            routing,
            console,
            Arc::new(move |_owner, worker, command, timeout, event| {
                let commands = commands.clone();
                async move {
                    Ok(commands
                        .request_with_timeout(&worker, command, timeout, event)
                        .await?)
                }
                .boxed()
            }),
            publish,
            server_id,
        )
    }
    pub fn with_request(
        database: Arc<Database>,
        routing: Arc<ModelRouting>,
        console: Arc<ManagedConsole>,
        request_worker: Request,
        publish: Publish,
        server_id: String,
    ) -> Arc<Self> {
        Arc::new(Self {
            repository: Repository::new(database),
            routing,
            console,
            request_worker,
            publish,
            server_id,
            logger: logging::server_logger(),
            state: Mutex::new(State::default()),
            changed: Notify::new(),
        })
    }
    pub(super) fn publish_preparation(&self, owner: &str, chat: &str) {
        (self.publish)(
            crate::wire::value::json!({"ownerId":owner,"scope":crate::wire::value::json!({"kind":"chat","chatId":chat}),"resource":"chat-preparation","action":"invalidated","entityId":Value::Null,"revision":Value::Null,"payload":Value::Null}),
        );
    }
    pub(super) async fn command(
        &self,
        owner: String,
        worker: String,
        command: Value,
        event: Option<EventHandler>,
    ) -> Result<Option<Value>> {
        (self.request_worker)(owner, worker, command, RequestTimeout::Disabled, event).await
    }
    pub(super) fn admission(self: &Arc<Self>, child: bool) -> Result<Admission> {
        let mut state = self.state.lock().unwrap();
        if state.stopping && !child {
            bail!("Managed chat preparation is closing");
        }
        state.tasks += 1;
        Ok(Admission(self.clone()))
    }
    pub(super) fn start(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        replace: bool,
        recovery: Option<Recovery>,
    ) -> Result<Arc<Job>> {
        let identity = key(owner, chat);
        let mut state = self.state.lock().unwrap();
        if !replace && let Some(job) = state.active.get(&identity) {
            return Ok(job.clone());
        }
        if state.stopping {
            bail!("Managed chat preparation is closing");
        }
        let (ready_send, ready_receive) = oneshot::channel();
        let (finish_send, finish_receive) = oneshot::channel();
        let job = Arc::new(Job {
            id: uuid::Uuid::new_v4(),
            ready: shared(ready_receive),
            finished: shared(finish_receive),
        });
        state.active.insert(identity.clone(), job.clone());
        state.tasks += 1;
        drop(state);
        let (service, owner, chat, job_copy) =
            (self.clone(), owner.to_owned(), chat.to_owned(), job.clone());
        tokio::spawn(async move {
            let _admission = Admission(service.clone());
            let result = service
                .run(&owner, &chat, &job_copy, recovery, ready_send)
                .await
                .map_err(Arc::new);
            {
                let mut state = service.state.lock().unwrap();
                if state
                    .active
                    .get(&identity)
                    .is_some_and(|current| current.id == job_copy.id)
                {
                    state.active.remove(&identity);
                }
            }
            service.publish_preparation(&owner, &chat);
            let _ = finish_send.send(result);
        });
        Ok(job)
    }
    pub async fn request(self: &Arc<Self>, owner: &str, chat: &str) -> Result<Option<Value>> {
        let active = self
            .state
            .lock()
            .unwrap()
            .active
            .contains_key(&key(owner, chat));
        if active {
            return self.repository.get(owner, chat).await;
        }
        let Some(context) = crate::chats::Repository::new(self.repository.database.clone())
            .execution_context(owner, chat)
            .await?
            .filter(eligible)
        else {
            return Ok(None);
        };
        let state = self
            .repository
            .request(owner, chat, text(&context, "workerId")?)
            .await?;
        self.start(owner, chat, false, None)?;
        Ok(state)
    }
    pub async fn join(self: &Arc<Self>, owner: &str, chat: &str) -> Result<()> {
        let existing = self
            .state
            .lock()
            .unwrap()
            .active
            .get(&key(owner, chat))
            .cloned();
        if let Some(job) = existing {
            return job.ready.clone().await.map_err(copy_error);
        }
        if let Some(state) = self.repository.get(owner, chat).await?
            && state["phase"] != "ready"
            && state["failedPhase"] != "console"
        {
            self.start(owner, chat, false, None)?
                .ready
                .clone()
                .await
                .map_err(copy_error)?;
        }
        Ok(())
    }
    pub async fn worker_connected(
        self: &Arc<Self>,
        owner: &str,
        worker: &str,
        recoveries: &HashMap<String, Recovery>,
    ) -> Result<()> {
        for chat in self.repository.for_worker(owner, worker).await? {
            self.start(owner, &chat, true, recoveries.get(&chat).cloned())?;
        }
        Ok(())
    }
    pub async fn settle(&self, owner: &str, chat: &str) -> Result<()> {
        let job = self
            .state
            .lock()
            .unwrap()
            .active
            .get(&key(owner, chat))
            .cloned();
        if let Some(job) = job {
            job.finished.clone().await.map_err(copy_error)?;
        }
        Ok(())
    }
    pub fn stop(&self) {
        self.state.lock().unwrap().stopping = true;
    }
    pub async fn drained(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.state.lock().unwrap().tasks == 0 {
                return;
            }
            changed.await;
        }
    }
}
