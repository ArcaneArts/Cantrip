use super::*;
use crate::chats::turn_runtime::engine::{Completion, Failure};
use crate::tasks::failure_kind;
fn interrupted(error: &anyhow::Error) -> bool {
    use crate::{
        operations::shared_failure::downcast_ref,
        workers::{bridge::CommandError, command_bus::CommandFailure},
    };
    downcast_ref::<CommandFailure>(error)
        .is_some_and(|e| matches!(e,CommandFailure::Bridge(e) if e.unavailable))
        || downcast_ref::<CommandError>(error).is_some_and(|e| e.unavailable)
        || downcast_ref::<super::super::live_mutations::WorkerUnavailable>(error).is_some()
}
impl Service {
    pub fn scheduled_hooks(self: &Arc<Self>, owner: &str, lease: &Value) -> Hooks {
        Hooks {
            after_completed: Some(Arc::new({
                let (this, owner, lease) = (self.clone(), owner.to_owned(), lease.clone());
                move |completed: Completion| {
                    let (this, owner, lease) = (this.clone(), owner.clone(), lease.clone());
                    async move {
                        this.synchronize(
                            &owner,
                            &text(&completed.turn.execution["chatId"])?,
                            &lease,
                            false,
                            None,
                        )
                        .await
                    }
                    .boxed()
                }
            })),
            after_failed: Some(Arc::new({
                let (this, owner, lease) = (self.clone(), owner.to_owned(), lease.clone());
                move |failed: Failure| {
                    let (this, owner, lease) = (this.clone(), owner.clone(), lease.clone());
                    async move {
                        this.synchronize(
                            &owner,
                            &text(&failed.turn.execution["chatId"])?,
                            &lease,
                            true,
                            Some(failed.error),
                        )
                        .await
                    }
                    .boxed()
                }
            })),
            ..Hooks::default()
        }
    }
    pub fn synchronize(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        lease: &Value,
        failed: bool,
        error: Option<Arc<anyhow::Error>>,
    ) -> BoxFuture<'static, Result<()>> {
        let (this, owner, chat, lease) = (
            self.clone(),
            owner.to_owned(),
            chat.to_owned(),
            lease.clone(),
        );
        self.operations.run(async move {
            this.synchronize_one(&owner, &chat, &lease, failed, error)
                .await
        })
    }
    async fn synchronize_one(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        lease: &Value,
        failed: bool,
        error: Option<Arc<anyhow::Error>>,
    ) -> Result<()> {
        let context = self.chats.execution_context(owner, chat).await?;
        let task = self.tasks.get(owner, chat).await?;
        let (Some(context), Some(task)) = (context.filter(|c| c["experience"] == "task"), task)
        else {
            return Ok(());
        };
        if truthy(context.get("automationPaused")) && error.as_ref().is_some_and(|e| interrupted(e))
        {
            self.release(&lease["cycleId"]);
            if let Err(error) = self
                .dispatch
                .pause(
                    lease,
                    &json!({"threadId":context["threadId"],"turnId":Value::Null}),
                    &Value::Null,
                    false,
                )
                .await
                && !error.is::<task_dispatch::Conflict>()
            {
                return Err(error);
            }
            self.publish(owner, chat, "task", Some(&context));
            (self.dependencies.queue_tick)();
            return Ok(());
        }
        let observation:Result<()>=async {
            let failure=if failed{Some(json!({"kind":error.as_ref().map_or("runtime",|e|failure_kind::for_error(e)),"occurredAt":crate::wire::date_iso_milliseconds((self.dependencies.clock)()).context("Invalid time value")?}))}else{None};
            let observed=self.read_one(owner,&context,&task,Observation{runtime_failure:failure.clone(),..Observation::default()}).await?;
            if let Some(failure)=failure.filter(|_|observed["task"]["state"]=="failed") {
                let key=concat(&[&json!("goal:"),&context["threadId"],&json!(":"),&failure["occurredAt"]]);
                let kind=selected(observed["task"]["lastError"].get("code"),&failure["kind"]);
                self.retries.note_failure(owner,chat,&text(&key)?,failure_kind::classify(&kind),Some((self.dependencies.clock)() as f64)).await?;self.publish(owner,chat,"task",Some(&context));
            }else if matches!(observed["task"]["state"].as_str(),Some("complete"|"blocked")){self.retries.clear_pending(owner,chat).await?;self.publish(owner,chat,"task",Some(&context));}
            Ok(())
        }.await;
        if let Err(observation_error) = observation {
            if !failed {
                return Err(observation_error);
            }
            let now = (self.dependencies.clock)();
            let key = format!("goal-observation:{}:{now}", text(&lease["cycleId"])?);
            self.retries
                .note_failure(
                    owner,
                    chat,
                    &key,
                    failure_kind::for_error(error.as_deref().unwrap_or(&observation_error)),
                    Some(now as f64),
                )
                .await?;
            self.release(&lease["cycleId"]);
            let settled: Result<()> = async {
                self.dispatch.heartbeat(lease, &Value::Null).await?;
                self.dispatch.settle(lease, "failed", &Value::Null).await?;
                Ok(())
            }
            .await;
            if let Err(error) = settled
                && !error.is::<task_dispatch::Conflict>()
            {
                return Err(error);
            }
            self.publish(owner, chat, "task", Some(&context));
            (self.dependencies.queue_tick)();
        }
        Ok(())
    }
}
