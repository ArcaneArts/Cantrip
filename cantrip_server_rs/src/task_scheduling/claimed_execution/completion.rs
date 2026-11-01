use super::*;
impl Service {
    pub(super) fn completion_hooks(
        self: &Arc<Self>,
        owner: &str,
        claim: &Value,
        context: &Value,
        runtime: &Value,
        request: &Value,
    ) -> Hooks {
        let completed = Arc::new({
            let (this, owner, claim, context, request) = (
                self.clone(),
                owner.to_owned(),
                claim.clone(),
                context.clone(),
                request.clone(),
            );
            move |completed: Completion| {
                let (this, owner, claim, context, request) = (
                    this.clone(),
                    owner.clone(),
                    claim.clone(),
                    context.clone(),
                    request.clone(),
                );
                async move {
                    this.complete_operation(&owner, &claim, &context, &request, &completed)
                        .await
                }
                .boxed()
            }
        });
        let failed = Arc::new({
            let (this, owner, claim) = (self.clone(), owner.to_owned(), claim.clone());
            move |failed: crate::chats::turn_runtime::engine::Failure| {
                this.finish_failure(&owner, &claim, Some(failed.error))
            }
        });
        let after_completed = Some(Arc::new({
            let (this, owner, claim, context, runtime, request) = (
                self.clone(),
                owner.to_owned(),
                claim.clone(),
                context.clone(),
                runtime.clone(),
                request.clone(),
            );
            move |_: Completion| {
                let (this, owner, claim, context, runtime, request) = (
                    this.clone(),
                    owner.clone(),
                    claim.clone(),
                    context.clone(),
                    runtime.clone(),
                    request.clone(),
                );
                async move {
                    if request["classification"]["kind"] == "finalize" {
                        this.launch_goal(
                            &owner,
                            &claim,
                            &context,
                            &runtime,
                            &text(&request["operationId"])?,
                        )
                        .await?;
                    }
                    Ok(())
                }
                .boxed()
            }
        }) as crate::chats::turn_runtime::engine::Completed);
        Hooks {
            structured: Some(Structured {
                completed,
                failed,
                after_completed,
            }),
            ..Hooks::default()
        }
    }
    async fn complete_operation(
        &self,
        owner: &str,
        claim: &Value,
        context: &Value,
        request: &Value,
        completed: &Completion,
    ) -> Result<()> {
        self.dispatch
            .heartbeat(&claim["lease"], &Value::Null)
            .await?;
        let relay = tasks::relay::parse_result(request, &completed.result["structuredResult"])?;
        let (chat, operation) = (text(&context["chatId"])?, text(&request["operationId"])?);
        self.tasks
            .complete_operation(
                owner,
                &chat,
                &operation,
                &relay,
                completed.result["turnId"].as_str(),
            )
            .await?
            .context("Encrypted Task operation was not found.")?;
        let assistant = self
            .dependencies
            .live
            .write_message(
                owner,
                &chat,
                &relay["assistantMessage"],
                MessageOptions {
                    attribution: Some(&completed.turn.attribution),
                    kind: MessageKind::Task,
                    upsert: false,
                    routing: Some(context),
                },
            )
            .await?
            .context("Task Chat was not found.")?;
        self.tasks
            .attach_operation_assistant_message(owner, &chat, &operation, &text(&assistant["id"])?)
            .await?;
        if request["classification"]["kind"] != "finalize" {
            self.retries.clear_pending(owner, &chat).await?;
            self.dispatch
                .settle(&claim["lease"], "succeeded", &Value::Null)
                .await?;
            self.tick();
        }
        self.publish(owner, &chat, Some(context));
        Ok(())
    }
}
