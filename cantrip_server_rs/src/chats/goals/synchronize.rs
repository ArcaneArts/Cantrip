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
                        this.synchronize_turn(&owner, &completed.turn, &lease, false, None)
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
                        this.synchronize_turn(
                            &owner,
                            &failed.turn,
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
        self.synchronize_goal_input(owner, chat, lease, failed, error, None)
    }
    async fn synchronize_turn(
        self: &Arc<Self>,
        owner: &str,
        turn: &crate::chats::turn_runtime::bootstrap::PreparedTurn,
        lease: &Value,
        failed: bool,
        error: Option<Arc<anyhow::Error>>,
    ) -> Result<()> {
        let chat = text(&turn.execution["chatId"])?;
        if let Some(receipt)=self.tasks.goal_input_receipt_for_turn(owner,&chat,lease,
            &json!({"clientMessageId":turn.user_message["id"],"executionLaneId":turn.execution["executionLaneId"],"executionLaneActivatedAt":turn.execution["executionLaneActivatedAt"]})).await? {
            self.synchronize_goal_input(owner,&chat,lease,failed,error,Some(&receipt)).await?;
        }
        Ok(())
    }
    pub fn synchronize_goal_input(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        lease: &Value,
        failed: bool,
        error: Option<Arc<anyhow::Error>>,
        receipt: Option<&Value>,
    ) -> BoxFuture<'static, Result<()>> {
        let (this, owner, chat, lease) = (
            self.clone(),
            owner.to_owned(),
            chat.to_owned(),
            lease.clone(),
        );
        let receipt = receipt.cloned();
        self.operations.run(async move {
            this.synchronize_one(&owner, &chat, &lease, failed, error, receipt.as_ref())
                .await
        })
    }
    async fn synchronize_terminal_one(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        lease: &Value,
        receipt: &Value,
    ) -> Result<()> {
        let Some(pending) = self
            .tasks
            .goal_input_terminal(owner, chat, Some(receipt))
            .await?
        else {
            return Ok(());
        };
        let result: Result<()> = async {
            let context=self.chats.execution_context(owner,chat).await?;
            let task=self.tasks.get(owner,chat).await?;
            let (Some(context),Some(task))=(context.filter(|c|c["experience"]=="task"),task) else{return Ok(());};
            if !pending["terminal"]["threadId"].is_null() && pending["terminal"]["threadId"]!=context["threadId"] {return Ok(());}

            // Actual native lifecycle outranks an older dispatched turn's error.
            // Only a proven unforwarded input supplies startup failure context.
            let failure=(pending["failedBeforeDispatch"]==true && !pending["terminal"]["failureKind"].is_null())
                .then(||json!({"kind":pending["terminal"]["failureKind"],"occurredAt":pending["terminal"]["observedAt"]}));
            let observed=self.read_one(owner,&context,&task,Observation{
                observe_execution:true,runtime_failure:failure,dispatch_guard:Some(pending["guard"].clone()),..Observation::default()
            }).await?;
            if !truthy(observed.get("goal")) && !(pending["failedBeforeDispatch"]==true && observed["task"]["state"]=="failed") {return Ok(());}
            let state=self.tasks.finish_goal_input_projection(owner,receipt,&observed["task"]["rowVersion"],pending["guard"].get("goalProjection")).await?;
            if matches!(state.as_str(),Some("complete"|"blocked"|"failed"|"paused")){self.release_lease(lease);}
            else {self.reconcile_one(owner,&task,&state).await?;}
            self.publish(owner,chat,"task",Some(&context));
            self.publish(owner,chat,"agent-interaction",Some(&context));
            (self.dependencies.queue_tick)();
            Ok(())
        }.await;
        match result {
            Err(error)
                if crate::operations::shared_failure::downcast_ref::<task_dispatch::Conflict>(
                    &error,
                )
                .is_some()
                    || crate::operations::shared_failure::downcast_ref::<tasks::Conflict>(
                        &error,
                    )
                    .is_some_and(|e| e.code == "stale-version") =>
            {
                Ok(())
            }
            other => other,
        }
    }
    async fn synchronize_one(
        self: &Arc<Self>,
        owner: &str,
        chat: &str,
        lease: &Value,
        failed: bool,
        error: Option<Arc<anyhow::Error>>,
        receipt: Option<&Value>,
    ) -> Result<()> {
        if let Some(receipt) = receipt {
            return self
                .synchronize_terminal_one(owner, chat, lease, receipt)
                .await;
        }
        let mut guard = json!({"kind":"leased","lease":lease});
        if let Some(receipt) = receipt {
            guard["goalInferenceInputOperationId"] = receipt["operationId"].clone();
        }
        let context = self.chats.execution_context(owner, chat).await?;
        let task = self.tasks.get(owner, chat).await?;
        let (Some(context), Some(task)) = (context.filter(|c| c["experience"] == "task"), task)
        else {
            return Ok(());
        };
        if truthy(context.get("automationPaused")) && error.as_ref().is_some_and(|e| interrupted(e))
        {
            let paused = if let Some(receipt) = receipt {
                self.tasks
                    .pause_goal_input(owner, receipt, &context["threadId"])
                    .await
            } else {
                self.dispatch
                    .pause(
                        lease,
                        &json!({"threadId":context["threadId"],"turnId":Value::Null}),
                        &Value::Null,
                        false,
                    )
                    .await
            };
            if let Err(error) = paused {
                if error.is::<task_dispatch::Conflict>() {
                    return Ok(());
                }
                return Err(error);
            }
            self.release_lease(lease);
            self.publish(owner, chat, "task", Some(&context));
            (self.dependencies.queue_tick)();
            return Ok(());
        }
        let observation:Result<()>=async {
            let failure=if failed{Some(json!({"kind":error.as_ref().map_or("runtime",|e|failure_kind::for_error(e)),"occurredAt":crate::wire::date_iso_milliseconds((self.dependencies.clock)()).context("Invalid time value")?}))}else{None};
            let observed=self.read_one(owner,&context,&task,Observation{runtime_failure:failure.clone(),dispatch_guard:Some(guard.clone()),..Observation::default()}).await?;
            if let Some(failure)=failure.filter(|_|observed["task"]["state"]=="failed") {
                let key=if let Some(receipt)=receipt {json!(format!("goal-input:{}",text(&receipt["operationId"])?))}else{concat(&[&json!("goal:"),&context["threadId"],&json!(":"),&failure["occurredAt"]])};
                let kind=selected(observed["task"]["lastError"].get("code"),&failure["kind"]);
                self.retries.note_failure_guarded(owner,chat,&text(&key)?,failure_kind::classify(&kind),Some((self.dependencies.clock)() as f64),Some(&guard)).await?;self.publish(owner,chat,"task",Some(&context));
            }else if matches!(observed["task"]["state"].as_str(),Some("complete"|"blocked")){self.retries.clear_pending_guarded(owner,chat,Some(&guard)).await?;self.publish(owner,chat,"task",Some(&context));}
            Ok(())
        }.await;
        if let Err(observation_error) = observation {
            if crate::operations::shared_failure::downcast_ref::<task_dispatch::Conflict>(
                &observation_error,
            )
            .is_some()
            {
                return Ok(());
            }
            if !failed {
                return Err(observation_error);
            }
            let now = (self.dependencies.clock)();
            let settled = self
                .retries
                .settle_dispatch_failure_guarded(
                    owner,
                    chat,
                    lease,
                    failure_kind::for_error(error.as_deref().unwrap_or(&observation_error)),
                    Some(now as f64),
                    Some(&guard),
                )
                .await;
            if let Err(error) = settled {
                if crate::operations::shared_failure::downcast_ref::<task_dispatch::Conflict>(
                    &error,
                )
                .is_some()
                {
                    return Ok(());
                }
                return Err(error);
            }
            self.release_lease(lease);
            self.publish(owner, chat, "task", Some(&context));
            (self.dependencies.queue_tick)();
        }
        Ok(())
    }
}
