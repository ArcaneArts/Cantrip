use super::*;
use crate::operations::logging::{self, LogCall};
use futures::FutureExt;

impl Service {
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
                        if notification["type"] == "chat.turn.outcome"
                            && let Some(service) = service.upgrade()
                        {
                            service.receive_outcome(owner, worker_id.clone(), notification);
                        }
                        async { Ok(()) }.boxed()
                    }),
                )
            });
    }

    fn receive_outcome(&self, owner: String, worker: String, notification: Arc<Value>) {
        let context = json!({"chatId":notification["chatId"],"clientMessageId":notification["clientMessageId"],"executionLaneId":notification["executionLaneId"],"outcome":if notification["outcome"]["ok"]==true {"completed"} else {"failed"},"workerId":worker});
        (self.logger)(LogCall::event(
            "info",
            "Received durable agent turn outcome",
            context,
        ));
        let key = recovery::scheduler::key(
            &json!(worker),
            &notification["chatId"],
            &notification["clientMessageId"],
        );
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
    }
}
