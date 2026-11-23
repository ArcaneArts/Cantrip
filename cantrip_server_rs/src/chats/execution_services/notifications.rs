use super::*;
use crate::operations::logging::{self, LogCall};
use futures::FutureExt;

impl Service {
    pub(crate) async fn receive_committed_outcome(
        &self,
        owner: String,
        worker: String,
        notification: Arc<Value>,
    ) {
        let context = json!({"event":"task.outcome.follow-up-pending","workerId":worker,"chatId":notification["chatId"]});
        if let Err(error) = self.receive_outcome(owner, worker, notification).await {
            let mut context = context;
            context["err"] = crate::operations::logging::error_details(&error);
            (self.logger)(crate::operations::logging::LogCall::event(
                "warn",
                "Task outcome is committed; live follow-up remains pending",
                context,
            ));
        }
    }

    pub(crate) async fn publish_task_outcome_message(
        &self,
        owner: &str,
        message: &Value,
        routing: &Value,
    ) {
        self.outcome_live
            .publish_persisted_message(
                owner,
                message,
                crate::chats::message_queries::MessageKind::Task,
                Some(routing),
            )
            .await;
    }

    pub fn worker_connected(self: &Arc<Self>, worker: &str) {
        self.subscriptions
            .lock()
            .unwrap()
            .entry(worker.into())
            .or_insert_with(|| {
                let service = Arc::downgrade(self);
                let worker_id = worker.to_owned();
                self.bridge.subscribe_owned_notifications(
                    worker,
                    Arc::new(move |owner, notification| {
                        if let Some(service) = service.upgrade() {
                            if notification["type"] == "inference.status" {
                                service.inference_status(&owner, &worker_id, &notification);
                            } else if notification["type"] == "chat.turn.outcome" {
                                let worker = worker_id.clone();
                                return async move {
                                    service.receive_outcome(owner, worker, notification).await
                                }
                                .boxed();
                            } else if notification["type"] == "chat.thread.changed" {
                                service.thread_sync.notification(
                                    owner,
                                    worker_id.clone(),
                                    notification,
                                );
                            }
                        }
                        async { Ok(()) }.boxed()
                    }),
                )
            });
    }

    pub(crate) async fn receive_outcome(
        &self,
        owner: String,
        worker: String,
        notification: Arc<Value>,
    ) -> anyhow::Result<()> {
        let context = json!({"chatId":notification["chatId"],"clientMessageId":notification["clientMessageId"],"executionLaneId":notification["executionLaneId"],"outcome":if notification["outcome"]["ok"]==true {"completed"} else {"failed"},"workerId":worker});
        (self.logger)(LogCall::event(
            "info",
            "Received durable agent turn outcome",
            context,
        ));
        let mut key = recovery::scheduler::attempt_key(
            &json!(worker),
            &notification["chatId"],
            &notification["clientMessageId"],
            notification.get("taskInferenceInputOperationId"),
        );
        let mut goal_projection = false;
        if notification.get("taskInferenceInputOperationId").is_some() {
            match self
                .outcomes
                .persist_goal_terminal(&owner, &worker, &notification)
                .await
            {
                Ok(true) => goal_projection = true,
                Ok(false) => {}
                Err(error)
                    if crate::operations::shared_failure::downcast_ref::<
                        crate::task_dispatch::Conflict,
                    >(&error)
                    .is_some() =>
                {
                    return Ok(());
                }
                Err(error) => {
                    goal_projection = true;
                    (self.logger)(LogCall::event(
                        "warn",
                        "Goal terminal persistence will retry through outcome recovery",
                        json!({"event":"task.goal.terminal-persistence-deferred","chatId":notification["chatId"],"workerId":worker,"err":logging::error_details(&error)}),
                    ));
                }
            }
        }
        if goal_projection {
            let mut units = key.units().to_vec();
            units.extend(":goal-terminal-projection".encode_utf16());
            key = crate::wire::JsString::new(units);
        }
        let (outcomes, logger, note, observed_worker) = (
            self.outcomes.clone(),
            self.logger.clone(),
            notification.clone(),
            worker.clone(),
        );
        let scheduled = self.outcome_timers.schedule(key, move || async move {
            if let Err(error) = outcomes.recover(&owner, &observed_worker, &note).await {
                logger(LogCall::event("error", "Could not recover a completed agent turn", json!({"chatId":note["chatId"],"clientMessageId":note["clientMessageId"],"err":logging::error_details(&error),"workerId":observed_worker})));
            }
        }.boxed());
        if !scheduled {
            (self.logger)(LogCall::event(
                "debug",
                "Ignored a durable outcome for a turn already settled normally",
                json!({"chatId":notification["chatId"],"clientMessageId":notification["clientMessageId"],"workerId":worker}),
            ));
        }
        Ok(())
    }
}
