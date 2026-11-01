//! Bounded, per-chat automatic retries over the actual durable Task services.
use super::*;
use crate::{
    chats::{
        Repository as Chats,
        goals::{self, Observation},
        live_mutations::Service as Live,
        task_recovery,
        turn_runtime::stages::Operations,
    },
    operations::{
        logging::{self, LogCall, Logger},
        shared_failure::downcast_ref,
    },
    task_dispatch, tasks,
};
use futures::future::BoxFuture;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};
pub struct Dependencies {
    pub database: Arc<Database>,
    pub recovery: Arc<task_recovery::Service>,
    pub goals: Arc<goals::Service>,
    pub queue: Arc<super::operation_queue::Service>,
    pub live: Arc<Live>,
    pub logger: Logger,
    pub clock: Arc<dyn Fn() -> f64 + Send + Sync>,
}
pub struct Service {
    dependencies: Dependencies,
    tasks: tasks::Repository,
    retries: tasks::retries::Repository,
    chats: Chats,
    active: Arc<Mutex<HashSet<String>>>,
    stopped: AtomicBool,
    operations: Arc<Operations>,
}
struct Active {
    chats: Arc<Mutex<HashSet<String>>>,
    chat: String,
}
impl Drop for Active {
    fn drop(&mut self) {
        self.chats.lock().unwrap().remove(&self.chat);
    }
}
impl Service {
    pub fn new(dependencies: Dependencies) -> Arc<Self> {
        let db = dependencies.database.clone();
        Arc::new(Self {
            tasks: tasks::Repository::new(db.clone()),
            retries: tasks::retries::Repository::new(db.clone()),
            chats: Chats::new(db),
            dependencies,
            active: Arc::default(),
            stopped: AtomicBool::new(false),
            operations: Arc::default(),
        })
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
    pub async fn drained(&self) {
        self.operations.drained().await;
    }
    pub fn tick(self: &Arc<Self>) -> BoxFuture<'static, Result<()>> {
        let service = self.clone();
        self.operations.run(async move {
            if service.stopped.load(Ordering::SeqCst) {
                return Ok(());
            }
            let candidates = service
                .retries
                .list_candidates(Some((service.dependencies.clock)()))
                .await?;
            // Source reserves its whole batch before Promise microtasks begin.
            // Reserve atomically so a fast Tokio job cannot admit a fifth item
            // into the same tick while its remaining candidates are inspected.
            let admitted = {
                let mut active = service.active.lock().unwrap();
                let mut admitted = Vec::new();
                for candidate in candidates {
                    if service.stopped.load(Ordering::SeqCst) || active.len() >= 4 {
                        break;
                    }
                    let chat = text(&candidate["chatId"])?;
                    if active.insert(chat.clone()) {
                        admitted.push((candidate, chat));
                    }
                }
                admitted
            };
            for (candidate, chat) in admitted {
                let this = service.clone();
                let active = Active {
                    chats: service.active.clone(),
                    chat: chat.clone(),
                };
                drop(service.operations.spawn(async move {
                    let _active = active;
                    if let Err(error) = this.candidate(&candidate).await {
                        this.report(&chat, &error);
                    }
                    Ok(())
                }));
            }
            Ok(())
        })
    }
    fn publish(&self, owner: &str, chat: &str, project: &Value) {
        self.dependencies.live.publish_invalidation(
            owner,
            chat,
            "task",
            Some(&json!({"experience":"task","projectId":project})),
        );
    }
    fn report(&self, chat: &str, error: &anyhow::Error) {
        let mut details = logging::error_details(error);
        if let Some(conflict) = downcast_ref::<task_dispatch::Conflict>(error) {
            details["name"] = json!("TaskDispatchConflictError");
            details["code"] = json!(conflict.code);
        }
        (self.dependencies.logger)(LogCall::event(
            "warn",
            "Automatic Task retry did not start; history is retained",
            json!({"chatId":chat,"err":details}),
        ));
    }
    async fn finish(
        &self,
        owner: &str,
        chat: &str,
        claim: &Value,
        failure: Option<&Value>,
    ) -> Result<()> {
        self.retries
            .finish(
                owner,
                chat,
                &text(&claim["id"])?,
                failure,
                Some((self.dependencies.clock)()),
            )
            .await?;
        Ok(())
    }
    async fn candidate(&self, candidate: &Value) -> Result<()> {
        let owner = text(&candidate["ownerId"])?;
        let chat = text(&candidate["chatId"])?;
        let project = &candidate["projectId"];
        let Some(task) = self.tasks.get(&owner, &chat).await? else {
            return Ok(());
        };
        if !truthy(task.get("automaticRetry"))
            && task["state"] == "failed"
            && truthy(task.get("lastError"))
        {
            let error = &task["lastError"];
            let key = format!(
                "observed:{}:{}",
                text(&error["code"])?,
                text(&error["occurredAt"])?
            );
            if truthy(Some(
                &self
                    .retries
                    .note_failure(
                        &owner,
                        &chat,
                        &key,
                        tasks::failure_kind::classify(&error["code"]),
                        Some((self.dependencies.clock)()),
                    )
                    .await?,
            )) {
                self.publish(&owner, &chat, project);
            }
        }
        let claim = self
            .retries
            .claim_due(&owner, &chat, Some((self.dependencies.clock)()))
            .await?;
        if !truthy(Some(&claim)) {
            return Ok(());
        }
        self.publish(&owner, &chat, project);
        let result:Result<bool>=async {
            let task = self.tasks.get(&owner, &chat).await?;
            if task.as_ref().is_none_or(|task|task["rowVersion"] != claim["rowVersion"]) {
                self.finish(&owner,&chat,&claim,None).await?;
                return Ok(false);
            }
            let task=task.unwrap();
            if truthy(task.get("planGoalEnabled")) && truthy(task.get("implementationStartedAt")) && truthy(task["dispatch"].get("codexThreadId")) {
                anyhow::ensure!(self.dependencies.recovery.recover(&owner,&chat,true,true).await?,"Task implementation recovery is unavailable.");
            } else {
                let context=self.chats.execution_context(&owner,&chat).await?.context("The Task placement is unavailable.")?;
                if truthy(context.get("threadId")) {
                    let observed=self.dependencies.goals.read(&owner,&context,&task,Observation { observe_execution:true, observation_only:true, ..Observation::default() }).await?;
                    anyhow::ensure!(observed["execution"].get("threadId")==context.get("threadId"),"The previous native Task execution could not be observed. No new turn was started.");
                    if !matches!(observed["execution"]["status"].as_str(),Some("idle"|"failed")) {
                        return Err(task_dispatch::Conflict::new("active-operation","Waiting for the previous native Task turn to stop before retrying.").into());
                    }
                }
                self.dependencies.queue.retry(&owner,&task,Some(&claim["id"]),true).await?;
            }
            self.finish(&owner,&chat,&claim,None).await?;
            Ok(true)
        }.await;
        match result {
            Ok(false) => return Ok(()),
            Ok(true) => {}
            Err(error) => {
                let failure = json!({"kind":tasks::failure_kind::for_error(&error),"defer":downcast_ref::<task_dispatch::Conflict>(&error).is_some_and(|c|c.code=="active-operation")});
                self.finish(&owner, &chat, &claim, Some(&failure)).await?;
                self.report(&chat, &error);
            }
        }
        self.publish(&owner, &chat, project);
        Ok(())
    }
}
