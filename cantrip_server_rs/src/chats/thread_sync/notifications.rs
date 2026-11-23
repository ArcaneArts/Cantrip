use super::*;
use crate::{
    operations::logging::{self, LogCall},
    wire::{JsString, coercion::string},
};
use futures::FutureExt;

impl Service {
    pub fn notification(self: &Arc<Self>, owner: String, worker: String, note: Arc<Value>) {
        let this = self.clone();
        drop(self.operations.spawn(async move {
   let result=this.receive_notification(&owner,&worker,&note).await;
   if let Err(error)=result {
    (this.dependencies.logger)(LogCall::event("warn","Could not reconcile an observed Codex thread change",json!({"err":logging::error_details(&error),"workerId":worker,"threadId":note["threadId"]})));
   }
   Ok(())
  }));
    }
    async fn receive_notification(
        self: &Arc<Self>,
        owner: &str,
        worker: &str,
        note: &Value,
    ) -> Result<()> {
        let thread = text(&note["threadId"])?;
        let contexts = Repository::new(self.dependencies.database.clone())
            .contexts_by_thread(owner, worker, &thread)
            .await?;
        if contexts.len() != 1 || contexts[0]["experience"] != "agent" {
            return Ok(());
        }
        let chat = text(&contexts[0]["chatId"])?;
        let mut units = Vec::new();
        for (i, value) in [json!(owner), json!(worker), note["threadId"].clone()]
            .iter()
            .enumerate()
        {
            if i > 0 {
                units.push(u16::from(b':'));
            }
            units.extend(
                string(value)
                    .map_err(|_| anyhow::anyhow!("Thread observation key"))?
                    .units(),
            );
        }
        let (this, owner, worker) = (self.clone(), owner.to_owned(), worker.to_owned());
        self.observations.schedule(
            JsString::new(units),
            note.clone(),
            Arc::new(move |observation| {
                let (this, owner, worker, chat, thread) = (
                    this.clone(),
                    owner.clone(),
                    worker.clone(),
                    chat.clone(),
                    thread.clone(),
                );
                async move {
                    this.observed(
                        &owner,
                        &worker,
                        &chat,
                        &thread,
                        observation["changes"]
                            .as_array()
                            .context("Observed thread changes")?,
                    )
                    .await
                }
                .boxed()
            }),
        );
        Ok(())
    }
    async fn observed(
        self: &Arc<Self>,
        owner: &str,
        worker: &str,
        chat: &str,
        thread: &str,
        changes: &[Value],
    ) -> Result<()> {
        let chats = Repository::new(self.dependencies.database.clone());
        let matching = |context: &Value| {
            context["experience"] == "agent"
                && context["workerId"] == worker
                && context["threadId"] == thread
        };
        if chats
            .execution_context(owner, chat)
            .await?
            .as_ref()
            .is_none_or(|current| !matching(current))
        {
            return Ok(());
        }
        // Source revalidates once more after entering its owner-scoped callback.
        let Some(context) = chats.execution_context(owner, chat).await?.filter(matching) else {
            return Ok(());
        };
        for (change, resource, routing) in [
            ("goal", "chat-goal", true),
            ("queue", "chat-queue", false),
            ("plan", "chat-plan", true),
        ] {
            if changes.contains(&json!(change)) {
                self.dependencies.live.publish_invalidation(
                    owner,
                    chat,
                    resource,
                    routing.then_some(&context),
                );
            }
        }
        self.reconcile_one(owner, &context, None).await?;
        Ok(())
    }
}
